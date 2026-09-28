#!/usr/bin/env python3
"""First-run setup of a Plane instance (Plane design, A1.4 and A2.7), with no browser.

    python infra/plane/first_run.py                         # cloud, through an open IAP tunnel
    python infra/plane/first_run.py --profile dev           # the local instance on :8766

It makes the same HTTP calls Plane's own forms make, in this order, and skips any step that is
already done, so it is safe to run again:

1. instance admin (the owner), password login on, magic link off
2. workspace `veistra`, with `agent` and `kaava` invited as Members
3. each bot signs up, accepts its invitation and gets one personal access token, which goes
   straight into Secret Manager as <prefix>pat-agent / <prefix>pat-kaava
4. public sign-up off

Every password is read from Secret Manager (terraform/plane generates them) and every token is
written back to it. Nothing secret is printed or written to disk.
"""

import argparse
import base64
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from render_env import credentials, secret

PROFILES = {
    # Canonical URL, and where the laptop actually connects: the tunnel, or local Docker.
    "prod": ("http://plane.kaava.internal:8765", "http://127.0.0.1:8765", "plane-"),
    "dev": ("http://localhost:8766", "http://127.0.0.1:8766", "plane-dev-"),
}
WORKSPACE = "veistra"
OWNER = {"email": "braden.seaborn@firelightinnovations.com", "first_name": "Braden",
         "last_name": "Seaborn"}
BOTS = {"agent": "agent@plane.kaava.internal", "kaava": "kaava@plane.kaava.internal"}
MEMBER = 15


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Session:
    """One signed-in browser: a cookie jar plus Plane's CSRF token."""

    def __init__(self, url, connect):
        self.url, self.connect = url, connect
        self.host = urllib.parse.urlparse(url).netloc
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        self.csrf = self.call("GET", "/auth/get-csrf-token/")[1]["csrf_token"]

    def call(self, method, path, json_body=None, form=None, headers=None):
        """Returns (status, parsed body or Location header)."""
        hdrs = {"Host": self.host, "Origin": self.url, "Referer": self.url + "/"}
        data = None
        if form is not None:
            data = urllib.parse.urlencode({**form, "csrfmiddlewaretoken": self.csrf}).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        elif json_body is not None:
            data = json.dumps(json_body).encode()
            hdrs["Content-Type"] = "application/json"
        if method != "GET" and hasattr(self, "csrf"):
            hdrs["X-CSRFToken"] = self.csrf
        hdrs.update(headers or {})
        req = urllib.request.Request(self.connect + path, data=data, headers=hdrs, method=method)
        try:
            with self.opener.open(req, timeout=60) as resp:
                return resp.status, parse(resp.read())
        except urllib.error.HTTPError as err:
            if err.code in (301, 302):
                return err.code, err.headers.get("Location", "")
            return err.code, parse(err.read())

    def form_auth(self, path, fields):
        """Plane's auth forms answer with a redirect; an error_code in it means failure."""
        status, location = self.call("POST", path, form=fields)
        if status != 302 or "error_code" in location:
            return location or status
        return None


def parse(body):
    try:
        return json.loads(body)
    except ValueError:
        return body.decode(errors="replace")[:300]


def add_version(project, token, name, value):
    url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}:addVersion"
    body = json.dumps({"payload": {"data": base64.b64encode(value.encode()).decode()}}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["name"]


def has_version(project, token, name):
    url = (f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}"
           "/versions?filter=state:ENABLED")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return bool(json.load(resp).get("versions"))


def step(msg):
    print(f"first-run: {msg}", file=sys.stderr)


def fail(msg):
    sys.exit(f"first-run: FAILED {msg}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", choices=PROFILES, default="prod")
    ap.add_argument("--project")
    args = ap.parse_args()
    url, connect, prefix = PROFILES[args.profile]
    gtoken, project = credentials(args.project)
    pw = {k: secret(project, gtoken, f"{prefix}{k}-password") for k in ("owner", *BOTS)}

    # 1. Instance admin. Sign-up works once; after that, sign in.
    admin = Session(url, connect)
    err = admin.form_auth("/api/instances/admins/sign-up/", {
        **OWNER, "password": pw["owner"], "company_name": "Veistra",
        "is_telemetry_enabled": "False"})
    if err:
        err = admin.form_auth("/api/instances/admins/sign-in/",
                              {"email": OWNER["email"], "password": pw["owner"]})
        if err:
            fail(f"instance admin: {err}")
        step("instance admin exists; signed in")
    else:
        step("instance admin created")
    status, body = admin.call("PATCH", "/api/instances/configurations/", json_body={
        "ENABLE_EMAIL_PASSWORD": "1", "ENABLE_MAGIC_LINK_LOGIN": "0"})
    if status != 200:
        fail(f"instance configuration: {status} {body}")
    step("password login on, magic link off")

    # 2. The owner's app session: workspace and invitations.
    owner = Session(url, connect)
    if err := owner.form_auth("/auth/sign-in/", {"email": OWNER["email"], "password": pw["owner"]}):
        fail(f"owner sign-in: {err}")
    status, workspaces = owner.call("GET", "/api/users/me/workspaces/")
    if not any(w["slug"] == WORKSPACE for w in workspaces):
        status, body = owner.call("POST", "/api/workspaces/", json_body={
            "name": "Veistra", "slug": WORKSPACE, "organization_size": "2-10"})
        if status != 201:
            fail(f"workspace: {status} {body}")
        step(f"workspace {WORKSPACE} created")
    status, members = owner.call("GET", f"/api/workspaces/{WORKSPACE}/members/")
    have = {m["member"]["email"] for m in members} if status == 200 else set()
    status, pending = owner.call("GET", f"/api/workspaces/{WORKSPACE}/invitations/")
    have |= {i["email"] for i in pending} if status == 200 else set()
    invite = [{"email": e, "role": MEMBER} for e in BOTS.values() if e not in have]
    if invite:
        status, body = owner.call("POST", f"/api/workspaces/{WORKSPACE}/invitations/",
                                  json_body={"emails": invite})
        if status not in (200, 201):
            fail(f"invitations: {status} {body}")
        step(f"invited {', '.join(i['email'] for i in invite)}")

    # 3. Bots: sign up (or in), join, one token each.
    for name, email in BOTS.items():
        bot = Session(url, connect)
        if bot.form_auth("/auth/sign-up/", {"email": email, "password": pw[name]}):
            bot = Session(url, connect)
            if err := bot.form_auth("/auth/sign-in/", {"email": email, "password": pw[name]}):
                fail(f"{name} sign-in: {err}")
        status, invites = bot.call("GET", "/api/users/me/workspaces/invitations/")
        ids = [i["id"] for i in invites if i["workspace"]["slug"] == WORKSPACE] if status == 200 else []
        if ids:
            status, body = bot.call("POST", "/api/users/me/workspaces/invitations/",
                                    json_body={"invitations": ids})
            if status not in (200, 201, 204):
                fail(f"{name} join: {status} {body}")
            step(f"{name} joined {WORKSPACE}")
        pat = f"{prefix}pat-{name}"
        if has_version(project, gtoken, pat):
            step(f"{pat} already set; not minting another token")
            continue
        status, body = bot.call("POST", "/api/users/api-tokens/", json_body={
            "label": f"openkaava-{name}", "description": f"Secret Manager {pat}"})
        if status != 201:
            fail(f"{name} token: {status}")
        step(f"{pat} stored as {add_version(project, gtoken, pat, body['token'])}")

    # 4. Close the door, then prove a token works.
    status, body = admin.call("PATCH", "/api/instances/configurations/",
                              json_body={"ENABLE_SIGNUP": "0"})
    if status != 200:
        fail(f"disable sign-up: {status} {body}")
    step("public sign-up off")
    probe = Session(url, connect)
    status, _ = probe.call("GET", f"/api/v1/workspaces/{WORKSPACE}/projects/", headers={
        "X-API-Key": secret(project, gtoken, f"{prefix}pat-kaava")})
    step(f"API check with {prefix}pat-kaava: HTTP {status}")
    if status != 200:
        sys.exit(1)


if __name__ == "__main__":
    main()
