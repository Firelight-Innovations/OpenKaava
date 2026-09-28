#!/usr/bin/env python3
"""kaava-jobs: claims AI jobs from the queue and runs each as a headless Claude Code session.

    kaava-jobs run       claim and run pending jobs, one at a time, until none are left
    kaava-jobs status    list the queue

Plane design §8.1. plane-watch (or OpenKaava's "Run AI") writes a job to
gs://<bucket>/<profile>/jobs/pending/. This, run every minute by kaava-jobs.timer:

  1. claims the oldest job by copying it to claimed/ with ifGenerationMatch=0, so only one worker
     ever gets it, then deletes it from pending/;
  2. runs `claude -p` with prompts/protocol.md and prompts/<kind>.md, the job and the project
     record, allowing the Plane MCP server, the project's Hindsight banks and, for `do` only,
     the tools that change files;
  3. checks the work item: the agent's protocol is to swap `ai:queued` for `ai:done` or
     `ai:failed` and leave one summary comment. If it did neither, this does it, as `ai:failed`;
  4. moves the job to done/ with the outcome.

One job at a time (MAX_AI_JOBS=1): these sessions share usage limits with the owner's own Claude.
A lock file enforces it even if the timer and a person both start a run.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

METADATA = "http://metadata.google.internal/computeMetadata/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
PROMPTS = os.environ.get("KAAVA_JOBS_PROMPTS", os.path.join(HERE, "prompts"))
HOME = os.environ.get("KAAVA_JOBS_HOME", "/var/lib/kaava-jobs")
KINDS = ("breakdown", "plan-cycle", "context", "do")
# Tools that change files or run commands. Only `do` may use them; the other kinds read and write
# Plane and Hindsight, nothing else.
DO_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
JOB_TIMEOUT = int(os.environ.get("KAAVA_JOB_TIMEOUT", str(60 * 60)))
SUMMARY_LIMIT = 4000


def log(message):
    print(f"[kaava-jobs] {message}", flush=True)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


def http(method, url, headers=None, body=None, timeout=30):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    if data is not None and "Content-Type" not in req.headers:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as err:
        raise HttpError(err.code, err.read().decode("utf-8", "replace")) from None


def read_env(path="/etc/kaava/env"):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                key, sep, value = line.strip().partition("=")
                if sep and not key.startswith("#"):
                    env[key] = value
    except OSError:
        pass
    return env


# --- Google Cloud -------------------------------------------------------------------------------


class Google:
    def __init__(self, project):
        self.project = project
        self._token, self._expires = None, 0

    def token(self):
        if time.time() > self._expires - 60:
            _, _, raw = http("GET", f"{METADATA}/instance/service-accounts/default/token", {"Metadata-Flavor": "Google"})
            info = json.loads(raw)
            self._token, self._expires = info["access_token"], time.time() + info["expires_in"]
        return self._token

    def call(self, method, url, body=None):
        return http(method, url, {"Authorization": f"Bearer {self.token()}"}, body)

    def secret(self, name):
        url = f"https://secretmanager.googleapis.com/v1/projects/{self.project}/secrets/{name}/versions/latest:access"
        data = json.loads(self.call("GET", url)[2])["payload"]["data"]
        return base64.b64decode(data).decode().strip()

    @staticmethod
    def _object(bucket, name):
        return f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe='')}"

    def list(self, bucket, prefix):
        """[(name, timeCreated)] under a prefix."""
        found, page = [], None
        while True:
            query = {"prefix": prefix, "fields": "items(name,timeCreated),nextPageToken"}
            if page:
                query["pageToken"] = page
            reply = json.loads(self.call("GET", f"https://storage.googleapis.com/storage/v1/b/{bucket}/o?{urllib.parse.urlencode(query)}")[2])
            found += [(item["name"], item["timeCreated"]) for item in reply.get("items", [])]
            page = reply.get("nextPageToken")
            if not page:
                return found

    def read(self, bucket, name):
        """(document, generation), or (None, None) when it is gone."""
        try:
            _, headers, raw = self.call("GET", self._object(bucket, name) + "?alt=media")
        except HttpError as err:
            if err.status == 404:
                return None, None
            raise
        generation = {k.lower(): v for k, v in headers.items()}.get("x-goog-generation")
        return json.loads(raw), generation

    def write(self, bucket, name, document, if_generation_match=None):
        """Returns False when the precondition fails."""
        query = {"uploadType": "media", "name": name}
        if if_generation_match is not None:
            query["ifGenerationMatch"] = if_generation_match
        url = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?{urllib.parse.urlencode(query)}"
        try:
            self.call("POST", url, json.dumps(document, indent=2).encode())
            return True
        except HttpError as err:
            if err.status == 412:
                return False
            raise

    def delete(self, bucket, name, if_generation_match=None):
        url = self._object(bucket, name)
        if if_generation_match is not None:
            url += f"?ifGenerationMatch={if_generation_match}"
        try:
            self.call("DELETE", url)
            return True
        except HttpError as err:
            if err.status in (404, 412):
                return False
            raise


# --- Plane, for the fallback when an agent does not finish its protocol ------------------------


class Plane:
    def __init__(self, url, workspace, token):
        self.base = f"{url.rstrip('/')}/api/v1/workspaces/{workspace}"
        self.headers = {"X-API-Key": token}

    def call(self, method, path, body=None):
        raw = http(method, self.base + path, dict(self.headers), body)[2]
        return json.loads(raw) if raw else None

    def labels(self, project_id):
        return {label["name"]: label["id"] for label in self.call("GET", f"/projects/{project_id}/labels/?per_page=100")["results"]}

    def item(self, project_id, item_id):
        return self.call("GET", f"/projects/{project_id}/work-items/{item_id}/")

    def set_labels(self, project_id, item_id, labels):
        self.call("PATCH", f"/projects/{project_id}/work-items/{item_id}/", {"labels": labels})

    def comment(self, project_id, item_id, html):
        self.call("POST", f"/projects/{project_id}/work-items/{item_id}/comments/", {"comment_html": html})


# --- Pure pieces --------------------------------------------------------------------------------


def oldest_first(listing):
    """Pending job names, oldest first, from [(name, timeCreated)]."""
    return [name for name, _ in sorted(listing, key=lambda entry: (entry[1], entry[0])) if name.endswith(".json")]


def allowed_tools(kind, record):
    tools = ["mcp__plane"] + [f"mcp__hindsight-{bank}" for bank in record.get("hindsight_banks") or []]
    return tools + DO_TOOLS if kind == "do" else tools


def build_prompt(protocol, task, job, record):
    return "\n\n".join(
        [
            protocol.strip(),
            task.strip(),
            "## The job\n\n```json\n" + json.dumps(job, indent=2) + "\n```",
            "## The project record\n\n```json\n" + json.dumps(record, indent=2) + "\n```",
        ]
    )


def outcome_from_labels(item_labels, label_ids):
    """What the work item says happened: "done", "failed", or None if the agent never said."""
    if label_ids.get("ai:failed") in item_labels:
        return "failed"
    if label_ids.get("ai:done") in item_labels:
        return "done"
    return None


def failed_labels(item_labels, label_ids):
    drop = {label_ids.get("ai:queued"), label_ids.get("ai:done")}
    kept = [label for label in item_labels if label not in drop]
    failed = label_ids["ai:failed"]
    return kept if failed in kept else kept + [failed]


def parse_claude(stdout):
    """The fields of `claude -p --output-format json` this records. Tolerates a missing result."""
    try:
        reply = json.loads(stdout.strip().splitlines()[-1]) if stdout.strip() else {}
    except (ValueError, IndexError):
        return {"is_error": True, "result": stdout[-SUMMARY_LIMIT:]}
    return {
        "is_error": bool(reply.get("is_error")),
        "result": (reply.get("result") or "")[:SUMMARY_LIMIT],
        "session_id": reply.get("session_id"),
        "num_turns": reply.get("num_turns"),
        "duration_ms": reply.get("duration_ms"),
        "subtype": reply.get("subtype"),
    }


# --- The loop -----------------------------------------------------------------------------------


class Jobs:
    def __init__(self, env, google, plane_factory, runner=subprocess.run, agent=None):
        self.bucket = env.get("KAAVA_PROJECTS_BUCKET", "veistra-projects")
        self.profile = env.get("KAAVA_PROFILE", "prod")
        self.agent = agent or env.get("KAAVA_AGENT") or os.uname().nodename
        self.google, self.plane_factory, self.runner = google, plane_factory, runner
        self._plane = None

    def path(self, stage, job_id=""):
        return f"{self.profile}/jobs/{stage}/{job_id}.json" if job_id else f"{self.profile}/jobs/{stage}/"

    def plane(self):
        if self._plane is None:
            self._plane = self.plane_factory()
        return self._plane

    def claim_next(self):
        for name in oldest_first(self.google.list(self.bucket, self.path("pending"))):
            job, generation = self.google.read(self.bucket, name)
            if job is None:
                continue
            claimed = {**job, "claimed_by": self.agent, "claimed_at": now_iso()}
            if not self.google.write(self.bucket, self.path("claimed", job["id"]), claimed, if_generation_match=0):
                continue  # another worker got there first
            self.google.delete(self.bucket, name, if_generation_match=generation)
            log(f"claimed {job['id']}")
            return claimed
        return None

    def recover(self):
        """Jobs this worker claimed but never finished: it stopped mid-job. Nothing is running now,
        since the caller holds the lock, so each is closed as failed rather than silently lost."""
        for name, _ in self.google.list(self.bucket, self.path("claimed")):
            job, _ = self.google.read(self.bucket, name)
            if job and job.get("claimed_by") == self.agent:
                log(f"{job['id']} was claimed but never finished; closing it as failed")
                self.close_as_failed(job, "the worker stopped while this job was running")
                self.finish(job, {"outcome": "failed", "reason": "worker stopped mid-job"})

    def close_as_failed(self, job, reason):
        plane = self.plane()
        project_id, item_id = job["plane"]["project_id"], job["plane"]["work_item_id"]
        label_ids = plane.labels(project_id)
        item = plane.item(project_id, item_id)
        plane.set_labels(project_id, item_id, failed_labels(item["labels"], label_ids))
        plane.comment(project_id, item_id, f"<p>Agent job <code>{job['id']}</code> failed: {reason}</p>")

    def finish(self, job, result):
        done = {**job, "finished_at": now_iso(), "result": result}
        self.google.write(self.bucket, self.path("done", job["id"]), done)
        self.google.delete(self.bucket, self.path("claimed", job["id"]))
        log(f"{job['id']}: {result.get('outcome')}")

    def run_job(self, job, token):
        record, _ = self.google.read(self.bucket, f"{self.profile}/projects/{job['project']}.json")
        if job.get("kind") not in KINDS or record is None:
            reason = f"unknown kind {job.get('kind')!r}" if record else f"no project record {job['project']!r}"
            self.close_as_failed(job, reason)
            return self.finish(job, {"outcome": "failed", "reason": reason})

        with open(os.path.join(PROMPTS, "protocol.md")) as f:
            protocol = f.read()
        with open(os.path.join(PROMPTS, f"{job['kind']}.md")) as f:
            task = f.read()
        workdir = os.path.join(HOME, "work", job["id"])
        os.makedirs(workdir, exist_ok=True)
        command = [
            "claude", "-p", build_prompt(protocol, task, job, record),
            "--output-format", "json",
            "--allowedTools", ",".join(allowed_tools(job["kind"], record)),
        ]  # fmt: skip
        env = {
            **os.environ,
            "HOME": HOME,
            "CLAUDE_CODE_OAUTH_TOKEN": token,
            # kaava-session-hook puts these in the session's status.json for OpenKaava's views.
            "KAAVA_WORKFLOW": f"plane-{job['kind']}",
            "KAAVA_WORKFLOW_RUN": job["id"],
            "KAAVA_WORKFLOW_STEP": job["kind"],
        }
        started = time.time()
        try:
            proc = self.runner(command, cwd=workdir, env=env, capture_output=True, text=True, timeout=JOB_TIMEOUT)
            session = parse_claude(proc.stdout)
            session["exit"] = proc.returncode
            if proc.returncode != 0 and not session.get("result"):
                session["result"] = (proc.stderr or "")[-SUMMARY_LIMIT:]
        except subprocess.TimeoutExpired:
            session = {"is_error": True, "exit": None, "result": f"timed out after {JOB_TIMEOUT} s"}
        session["seconds"] = round(time.time() - started)

        plane = self.plane()
        project_id, item_id = job["plane"]["project_id"], job["plane"]["work_item_id"]
        outcome = outcome_from_labels(plane.item(project_id, item_id)["labels"], plane.labels(project_id))
        if outcome is None:
            reason = "the session ended without reporting a result"
            if session.get("is_error") or session.get("exit"):
                reason += f" ({(session.get('result') or 'exit ' + str(session.get('exit')))[:300]})"
            self.close_as_failed(job, reason)
            outcome = "failed"
        self.finish(job, {"outcome": outcome, **session})

    def run(self, token_source):
        self.recover()
        token = None
        while True:
            job = self.claim_next()
            if job is None:
                return
            token = token or token_source()
            try:
                self.run_job(job, token)
            except (OSError, HttpError, KeyError, ValueError) as err:
                log(f"{job['id']}: {err}")
                try:
                    self.close_as_failed(job, f"the job runner failed: {err}")
                finally:
                    self.finish(job, {"outcome": "failed", "reason": str(err)})

    def status(self):
        for stage in ("pending", "claimed", "done"):
            for name, created in self.google.list(self.bucket, self.path(stage)):
                print(f"{stage:8} {created}  {os.path.basename(name)[:-5]}")


def wake_plane():
    subprocess.run(["/opt/kaava/bin/kaava-wake", "plane", "--quiet"], check=True, timeout=400)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kaava-jobs")
    parser.add_argument("command", choices=["run", "status"])
    args = parser.parse_args(argv)
    env = {**read_env(), **os.environ}
    google = Google(env["KAAVA_PROJECT"])

    def plane_factory():
        wake_plane()
        return Plane(env["KAAVA_PLANE_URL"], "veistra", google.secret("plane-pat-agent"))

    jobs = Jobs(env, google, plane_factory)
    if args.command == "status":
        jobs.status()
        return 0

    import fcntl  # Linux only; imported here so the tests run anywhere

    os.makedirs(HOME, exist_ok=True)
    lock = open(os.path.join(HOME, "lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0  # a run is already going; it drains the queue
    jobs.run(lambda: google.secret("claude-oauth-token"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
