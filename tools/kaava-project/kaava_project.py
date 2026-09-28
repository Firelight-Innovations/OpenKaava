#!/usr/bin/env python3
"""kaava-project: the link table between Plane and the other Veistra systems (Plane design §3).

    kaava-project list [--json]                  bucket read only; never wakes Plane
    kaava-project create <slug> --name <n> [--game <g>] [--repo <url>] [--identifier <ABC>]
    kaava-project show <slug> [--json]           record plus a live Plane summary
    kaava-project archive <slug>                 archives in Plane, marks the record; never deletes

Every command takes --profile prod|dev (default prod). One record per project lives at
gs://veistra-projects/<profile>/projects/<slug>.json.

Plane is reached at its canonical URL. From the laptop, open the IAP tunnel and pass
--connect http://127.0.0.1:8765 (or set KAAVA_PLANE_CONNECT): requests go to the tunnel and
still carry Host: plane.kaava.internal:8765. The PAT (plane-pat-kaava) is read from Secret
Manager into memory and never printed or written.

Standard library only, so it runs on the agent image and on Windows alike.
"""

import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# kaava_wake lives in infra/common in this repository and in /usr/local/lib on the worker.
sys.path.insert(0, os.path.join(HERE, "..", "..", "infra", "common", "kaava-wake"))

PROFILES = {
    "prod": {"url": "http://plane.kaava.internal:8765", "secrets": "plane-", "wake": True},
    "dev": {"url": "http://localhost:8766", "secrets": "plane-dev-", "wake": False},
}
WORKSPACE = "veistra"
PROJECTS_BUCKET = "veistra-projects"
ARTIFACTS_BUCKET = "veistra-artifacts"
DEFAULT_BANKS = ["asset-build", "godot-build"]
OWNER_EMAIL = "braden.seaborn@firelightinnovations.com"

# §8.2 triggers plus the job states plane-watch swaps them for (§8.1).
LABELS = [
    ("ai:breakdown", "#5e6ad2", "Split into child issues with acceptance conditions and estimates"),
    ("ai:plan-cycle", "#5e6ad2", "Propose a cut list for the current cycle"),
    ("ai:context", "#5e6ad2", "Collect artifacts, design references and Hindsight recalls"),
    ("ai:do", "#5e6ad2", "Assign to agent and run the matching orchestrator workflow"),
    ("ai:queued", "#f2be02", "plane-watch queued a job for this issue"),
    ("ai:done", "#02b55c", "The agent finished; see its summary comment"),
    ("ai:failed", "#e5484d", "The agent failed; see its comment"),
]
# Plane's defaults are Backlog, Todo, In Progress, Done, Cancelled, at sequence 15000 to 55000
# in steps of 10000. ai:do ends in In Review, which sits between In Progress and Done.
EXTRA_STATES = [{"name": "In Review", "group": "started", "color": "#8b5cf6", "sequence": 40000}]
# Plane roles: 20 admin, 15 member.
MEMBERS = [(OWNER_EMAIL, 20), ("agent@plane.kaava.internal", 15)]

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$")
IDENTIFIER = re.compile(r"^[A-Z0-9]{1,12}$")


class Error(Exception):
    pass


# --- HTTP and Google credentials -------------------------------------------------------------


def http(method, url, headers=None, body=None, timeout=30):
    """One request. Returns (status, parsed JSON or text). Swapped out by the tests."""
    data = None
    headers = dict(headers or {})
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, parse(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, parse(err.read())


def parse(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode(errors="replace")[:300]


def gcloud(*args):
    out = subprocess.run(["gcloud", *args], capture_output=True, text=True, check=True,
                         shell=os.name == "nt")
    return out.stdout.strip()


def metadata(path):
    req = urllib.request.Request(f"http://metadata.google.internal/computeMetadata/v1/{path}",
                                 headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=2) as resp:
        return resp.read().decode()


def credentials(project=None):
    """(access token, project): the VM's service account, else the local gcloud login."""
    try:
        token = json.loads(metadata("instance/service-accounts/default/token"))["access_token"]
        return token, project or metadata("project/project-id")
    except OSError:
        return gcloud("auth", "print-access-token"), project or gcloud("config", "get-value", "project")


def secret(project, token, name):
    url = (f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}"
           "/versions/latest:access")
    status, body = http("GET", url, {"Authorization": f"Bearer {token}"})
    if status != 200:
        raise Error(f"secret {name}: HTTP {status}")
    return base64.b64decode(body["payload"]["data"]).decode().strip()


# --- Cloud Storage ----------------------------------------------------------------------------


class Bucket:
    API = "https://storage.googleapis.com"

    def __init__(self, token, name):
        self.headers = {"Authorization": f"Bearer {token}"}
        self.name = name

    def _object(self, key):
        return f"{self.API}/storage/v1/b/{self.name}/o/{urllib.parse.quote(key, safe='')}"

    def list(self, prefix):
        keys, page = [], None
        while True:
            query = {"prefix": prefix, "fields": "items(name),nextPageToken"}
            if page:
                query["pageToken"] = page
            url = f"{self.API}/storage/v1/b/{self.name}/o?{urllib.parse.urlencode(query)}"
            status, body = http("GET", url, self.headers)
            if status != 200:
                raise Error(f"list gs://{self.name}/{prefix}: HTTP {status} {body}")
            keys += [item["name"] for item in (body or {}).get("items", [])]
            page = (body or {}).get("nextPageToken")
            if not page:
                return keys

    def get(self, key):
        """(parsed JSON, generation), or (None, None) when the object does not exist."""
        status, meta = http("GET", self._object(key), self.headers)
        if status == 404:
            return None, None
        if status != 200:
            raise Error(f"get gs://{self.name}/{key}: HTTP {status} {meta}")
        generation = meta["generation"]
        status, body = http("GET", f"{self._object(key)}?alt=media&generation={generation}",
                            self.headers)
        if status != 200:
            raise Error(f"read gs://{self.name}/{key}: HTTP {status}")
        return body, generation

    def put(self, key, value, if_generation):
        """Write only if the object is still at `if_generation` (0: only if it does not exist)."""
        query = urllib.parse.urlencode({"uploadType": "media", "name": key,
                                        "ifGenerationMatch": if_generation})
        body = value if isinstance(value, bytes) else (json.dumps(value, indent=2) + "\n").encode()
        status, resp = http("POST", f"{self.API}/upload/storage/v1/b/{self.name}/o?{query}",
                            {**self.headers, "Content-Type": "application/json"}, body)
        if status == 412:
            raise Error(f"gs://{self.name}/{key} changed underneath us (precondition failed)")
        if status != 200:
            raise Error(f"write gs://{self.name}/{key}: HTTP {status} {resp}")


# --- Plane ------------------------------------------------------------------------------------


class Plane:
    def __init__(self, url, connect, pat):
        self.base = f"{connect or url}/api/v1/workspaces/{WORKSPACE}"
        self.headers = {"Host": urllib.parse.urlparse(url).netloc, "X-API-Key": pat}

    def call(self, method, path, body=None, expect=(200,)):
        status, resp = http(method, self.base + path, self.headers, body)
        if status not in expect:
            raise Error(f"Plane {method} {path}: HTTP {status} {resp}")
        return resp

    def results(self, path):
        """Every item of a list endpoint, following Plane's cursor pagination."""
        items, cursor = [], None
        while True:
            sep = "&" if "?" in path else "?"
            page = self.call("GET", f"{path}{sep}per_page=100" + (f"&cursor={cursor}" if cursor else ""))
            if isinstance(page, list):
                return items + page
            items += page.get("results", [])
            if not page.get("next_page_results"):
                return items
            cursor = page["next_cursor"]


# --- Records ----------------------------------------------------------------------------------


def record_key(profile, slug):
    return f"{profile}/projects/{slug}.json"


def default_identifier(slug):
    """anomaly -> ANOM, torn-apart -> TA; Plane allows up to 12 characters."""
    words = [w for w in slug.split("-") if w]
    ident = words[0][:4] if len(words) == 1 else "".join(w[0] for w in words)
    return ident.upper()[:12]


def new_record(slug, name, game, repo, project_id, identifier, created):
    return {
        "schema": 1,
        "slug": slug,
        "name": name,
        "game": game,
        "plane": {"workspace": WORKSPACE, "project_id": project_id, "identifier": identifier},
        "artifacts": f"gs://{ARTIFACTS_BUCKET}/{game}/" if game else None,
        "repo": repo,
        "hindsight_banks": list(DEFAULT_BANKS) if game else [],
        "created": created,
        "archived": False,
    }


def validate(slug, identifier, game):
    if not SLUG.match(slug):
        raise Error(f"slug {slug!r}: lowercase letters, digits and hyphens, 2 to 40 characters")
    if not IDENTIFIER.match(identifier):
        raise Error(f"identifier {identifier!r}: uppercase letters and digits, 1 to 12 characters")
    if game is not None and not SLUG.match(game):
        raise Error(f"game {game!r}: must be a lowercase slug, as in the artifact registry path")


# --- Commands ---------------------------------------------------------------------------------


class Context:
    """Everything a command needs; built lazily so `list` never touches Plane or its secrets."""

    def __init__(self, args):
        self.profile = args.profile
        self.spec = PROFILES[args.profile]
        self.connect = args.connect or os.environ.get("KAAVA_PLANE_CONNECT")
        self.log = (lambda msg: None) if getattr(args, "json", False) else (
            lambda msg: print(f"kaava-project: {msg}", file=sys.stderr))
        self.token, self.project = credentials(args.project)
        self.records = Bucket(self.token, PROJECTS_BUCKET)
        self._plane = None

    def plane(self):
        if self._plane is None:
            if self.spec["wake"]:
                wake_plane(self)
            pat = secret(self.project, self.token, f"{self.spec['secrets']}pat-kaava")
            self._plane = Plane(self.spec["url"], self.connect, pat)
        return self._plane


def wake_plane(ctx):
    import kaava_wake

    base = ctx.connect or ctx.spec["url"]
    services = {"plane": {**kaava_wake.SERVICES["plane"],
                          "health": [f"{base}/", f"{base}/api/instances/"]}}
    ctx.log("waking Plane")
    seconds = kaava_wake.wake("plane", ctx.project, services=services,
                              log=lambda msg, _started: ctx.log(msg))
    ctx.log(f"Plane healthy after {seconds:.0f} s")


def load(ctx, slug):
    record, generation = ctx.records.get(record_key(ctx.profile, slug))
    if record is None:
        raise Error(f"no project {slug!r} in {ctx.profile}")
    return record, generation


def cmd_list(ctx, args):
    prefix = f"{ctx.profile}/projects/"
    records = [ctx.records.get(key)[0] for key in ctx.records.list(prefix) if key.endswith(".json")]
    records = [r for r in records if r and (args.all or not r.get("archived"))]
    if args.json:
        print(json.dumps(records, indent=2))
        return
    for r in records:
        flag = "  (archived)" if r.get("archived") else ""
        print(f"{r['slug']:<16} {r['plane']['identifier']:<8} {r['name']}{flag}")


def cmd_create(ctx, args):
    identifier = args.identifier or default_identifier(args.slug)
    validate(args.slug, identifier, args.game)
    key = record_key(ctx.profile, args.slug)
    if ctx.records.get(key)[0] is not None:
        raise Error(f"project {args.slug!r} already exists in {ctx.profile}")

    plane = ctx.plane()
    project = plane.call("POST", "/projects/", {"name": args.name, "identifier": identifier},
                         expect=(201,))
    pid = project["id"]
    ctx.log(f"Plane project {identifier} created ({pid})")
    try:
        setup_plane_project(ctx, plane, pid)
        record = new_record(args.slug, args.name, args.game, args.repo, pid, identifier,
                            datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"))
        if args.game:
            placeholder(ctx, args.game)
        ctx.records.put(key, record, if_generation=0)
    except Exception:
        ctx.log(f"rolling back: deleting Plane project {identifier}")
        plane.call("DELETE", f"/projects/{pid}/", expect=(204,))
        raise
    ctx.log(f"record written to gs://{PROJECTS_BUCKET}/{key}")
    print(json.dumps(record, indent=2))


def setup_plane_project(ctx, plane, pid):
    have = {s["name"] for s in plane.results(f"/projects/{pid}/states/")}
    for state in EXTRA_STATES:
        if state["name"] not in have:
            # Plane ignores sequence on create and appends the state last; move it after.
            made = plane.call("POST", f"/projects/{pid}/states/", state, expect=(200, 201))
            plane.call("PATCH", f"/projects/{pid}/states/{made['id']}/",
                       {"sequence": state["sequence"]})
    have = {label["name"] for label in plane.results(f"/projects/{pid}/labels/")}
    for name, color, description in LABELS:
        if name not in have:
            plane.call("POST", f"/projects/{pid}/labels/",
                       {"name": name, "color": color, "description": description},
                       expect=(200, 201))
    ctx.log(f"{len(LABELS)} ai:* labels and the In Review state are in place")
    users = plane.call("GET", "/members/")
    in_project = {u["id"] for u in plane.call("GET", f"/projects/{pid}/members/")}
    for email, role in MEMBERS:
        user = find_user(users, email)
        if user is None:
            raise Error(f"{email} is not a member of workspace {WORKSPACE}")
        if user["id"] not in in_project:
            plane.call("POST", f"/projects/{pid}/members/", {"member": user["id"], "role": role},
                       expect=(200, 201))
    ctx.log("owner and agent added to the project")


def find_user(users, email):
    """Plane's lite user may leave out email; its display name defaults to the local part."""
    local = email.split("@")[0]
    for user in users:
        if user.get("email") == email:
            return user
    matches = [u for u in users if not u.get("email") and u.get("display_name") == local]
    return matches[0] if len(matches) == 1 else None


def placeholder(ctx, game):
    """Makes gs://veistra-artifacts/<game>/ visible before the first artifact lands."""
    try:
        Bucket(ctx.token, ARTIFACTS_BUCKET).put(f"{game}/.keep", b"", if_generation=0)
    except Error as err:
        if "precondition" not in str(err):
            raise


def cmd_show(ctx, args):
    record, _ = load(ctx, args.slug)
    plane = ctx.plane()
    pid = record["plane"]["project_id"]
    project = plane.call("GET", f"/projects/{pid}/")
    labels = sorted(label["name"] for label in plane.results(f"/projects/{pid}/labels/"))
    states = [s["name"] for s in sorted(plane.results(f"/projects/{pid}/states/"),
                                        key=lambda s: s.get("sequence", 0))]
    issues = plane.call("GET", f"/projects/{pid}/issues/?per_page=1")
    summary = {
        "name": project["name"],
        "identifier": project["identifier"],
        "archived_at": project.get("archived_at"),
        "issues": issues.get("total_count") if isinstance(issues, dict) else None,
        "states": states,
        "labels": labels,
    }
    if args.json:
        print(json.dumps({"record": record, "plane": summary}, indent=2))
        return
    print(json.dumps(record, indent=2))
    print(f"\nPlane {summary['identifier']}: {summary['issues']} issues")
    print(f"  states: {', '.join(states)}")
    print(f"  labels: {', '.join(labels)}")


def cmd_archive(ctx, args):
    record, generation = load(ctx, args.slug)
    if record.get("archived"):
        ctx.log(f"{args.slug} is already archived")
        return
    ctx.plane().call("POST", f"/projects/{record['plane']['project_id']}/archive/", expect=(204,))
    record["archived"] = True
    ctx.records.put(record_key(ctx.profile, args.slug), record, if_generation=generation)
    ctx.log(f"{args.slug} archived in Plane and in its record")


def parser():
    ap = argparse.ArgumentParser(prog="kaava-project", description=__doc__.splitlines()[0])
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--profile", choices=PROFILES, default="prod")
    common.add_argument("--project", help="GCP project; default from gcloud or the VM")
    common.add_argument("--connect", help="where to reach Plane, e.g. http://127.0.0.1:8765")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list", parents=[common])
    p.add_argument("--json", action="store_true")
    p.add_argument("--all", action="store_true", help="include archived projects")
    p.set_defaults(run=cmd_list)

    p = sub.add_parser("create", parents=[common])
    p.add_argument("slug")
    p.add_argument("--name", required=True)
    p.add_argument("--game")
    p.add_argument("--repo")
    p.add_argument("--identifier")
    p.set_defaults(run=cmd_create)

    p = sub.add_parser("show", parents=[common])
    p.add_argument("slug")
    p.add_argument("--json", action="store_true")
    p.set_defaults(run=cmd_show)

    p = sub.add_parser("archive", parents=[common])
    p.add_argument("slug")
    p.set_defaults(run=cmd_archive)
    return ap


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        args.run(Context(args), args)
    except (Error, OSError, subprocess.CalledProcessError) as err:
        print(f"kaava-project: {err}", file=sys.stderr)
        return 1
    except Exception as err:  # kaava_wake.WakeError, without importing it for `list`
        if type(err).__name__ != "WakeError":
            raise
        print(f"kaava-project: Plane did not wake: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
