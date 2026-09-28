#!/usr/bin/env python3
"""plane-watch: turns an `ai:*` label on a Plane work item into an AI job (Plane design §7.3).

    plane_watch.py run      poll every INTERVAL seconds, forever (the container's command)
    plane_watch.py once     one poll, then exit

Every poll reads the project records, then asks each project's Plane project for the work items
updated since the last poll. A work item that carries a trigger label (`ai:breakdown`,
`ai:plan-cycle`, `ai:context`, `ai:do`) gets, in this order:

  1. one job file per trigger in gs://<bucket>/<profile>/jobs/pending/<job-id>.json
  2. its trigger labels swapped for `ai:queued`
  3. one comment naming the queued jobs
  4. the worker VM started

The job id is derived from the work item and the moment it was labelled, so a poll that dies
half way through and runs again writes nothing twice. The label swap comes before the comment
so that a retry can cost at most a missing comment, never a duplicate job.

Standard library only: the container is the stock Python image with this file mounted in.
Credentials come from the VM's metadata server; the Plane token lives in memory only.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

TRIGGERS = {
    "ai:breakdown": "breakdown",
    "ai:plan-cycle": "plan-cycle",
    "ai:context": "context",
    "ai:do": "do",
}
QUEUED = "ai:queued"
METADATA = "http://169.254.169.254/computeMetadata/v1"
# A job still in pending/ or claimed/ after this long has stalled; plane-vm stops holding itself
# up for it. The worker's own timeout is shorter.
IN_FLIGHT_HOURS = 3


def log(message):
    print(f"[plane-watch] {message}", flush=True)


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


def http(method, url, headers=None, body=None, timeout=30):
    """One request. Returns (status, bytes); raises HttpError on 4xx/5xx and OSError on network."""
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    if data is not None and "Content-Type" not in req.headers:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        raise HttpError(err.code, err.read().decode("utf-8", "replace")) from None


# --- Google Cloud, through the metadata server ------------------------------------------------


class Google:
    def __init__(self, project=None):
        self._token, self._expires = None, 0
        self.project = project or self.metadata("project/project-id")

    def metadata(self, path):
        return http("GET", f"{METADATA}/{path}", {"Metadata-Flavor": "Google"}, timeout=5)[1].decode()

    def token(self):
        if time.time() > self._expires - 60:
            info = json.loads(self.metadata("instance/service-accounts/default/token"))
            self._token, self._expires = info["access_token"], time.time() + info["expires_in"]
        return self._token

    def call(self, method, url, body=None, headers=None):
        return http(method, url, {"Authorization": f"Bearer {self.token()}", **(headers or {})}, body)

    def secret(self, name):
        url = f"https://secretmanager.googleapis.com/v1/projects/{self.project}/secrets/{name}/versions/latest:access"
        payload = json.loads(self.call("GET", url)[1])["payload"]["data"]
        return base64.b64decode(payload).decode().strip()

    def list(self, bucket, prefix):
        names, page = [], None
        while True:
            query = {"prefix": prefix, "fields": "items(name),nextPageToken"}
            if page:
                query["pageToken"] = page
            url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o?{urllib.parse.urlencode(query)}"
            reply = json.loads(self.call("GET", url)[1])
            names += [item["name"] for item in reply.get("items", [])]
            page = reply.get("nextPageToken")
            if not page:
                return names

    def read(self, bucket, name):
        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe='')}?alt=media"
        return json.loads(self.call("GET", url)[1])

    def exists(self, bucket, name):
        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{urllib.parse.quote(name, safe='')}?fields=name"
        try:
            self.call("GET", url)
            return True
        except HttpError as err:
            if err.status == 404:
                return False
            raise

    def create(self, bucket, name, document):
        """Write `name` only if it does not exist yet. Returns False when it already did."""
        query = urllib.parse.urlencode({"uploadType": "media", "name": name, "ifGenerationMatch": 0})
        url = f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?{query}"
        try:
            self.call("POST", url, json.dumps(document, indent=2).encode())
            return True
        except HttpError as err:
            if err.status == 412:
                return False
            raise

    def start_instance(self, zone, name):
        """Start a VM unless it is already up. Returns its status before the call."""
        base = f"https://compute.googleapis.com/compute/v1/projects/{self.project}/zones/{zone}/instances/{name}"
        status = json.loads(self.call("GET", base + "?fields=status")[1])["status"]
        if status in ("TERMINATED", "STOPPED"):
            self.call("POST", base + "/start", b"")
        elif status == "SUSPENDED":
            self.call("POST", base + "/resume", b"")
        return status


# --- Plane --------------------------------------------------------------------------------------


class Plane:
    """The v1 REST API. `url` is where to connect; `host` is the Host header Plane expects."""

    def __init__(self, url, host, workspace, token, sleep=time.sleep):
        self.base = f"{url.rstrip('/')}/api/v1/workspaces/{workspace}"
        self.headers = {"X-API-Key": token}
        if host:
            self.headers["Host"] = host
        self.sleep = sleep

    def call(self, method, path, body=None):
        for attempt in range(4):
            try:
                raw = http(method, self.base + path, dict(self.headers), body)[1]
                return json.loads(raw) if raw else None
            except HttpError as err:
                if err.status != 429 or attempt == 3:
                    raise
                self.sleep(15 * (attempt + 1))

    def labels(self, project_id):
        reply = self.call("GET", f"/projects/{project_id}/labels/?per_page=100")
        return {label["name"]: label["id"] for label in reply["results"]}

    def updated_since(self, project_id, since):
        """Work items whose updated_at is at or after `since`, newest first.

        The API ignores filters on updated_at, but honours order_by, so this pages from the newest
        and stops at the first item older than the cursor.
        """
        cursor = None
        while True:
            query = {"order_by": "-updated_at", "per_page": 50}
            if cursor:
                query["cursor"] = cursor
            reply = self.call("GET", f"/projects/{project_id}/work-items/?{urllib.parse.urlencode(query)}")
            for item in reply["results"]:
                if moment(item["updated_at"]) < since:
                    return
                yield item
            if not reply.get("next_page_results"):
                return
            cursor = reply["next_cursor"]

    def set_labels(self, project_id, item_id, labels):
        self.call("PATCH", f"/projects/{project_id}/work-items/{item_id}/", {"labels": labels})

    def comment(self, project_id, item_id, html):
        self.call("POST", f"/projects/{project_id}/work-items/{item_id}/comments/", {"comment_html": html})


# --- The decisions, with nothing to fetch -------------------------------------------------------


def moment(timestamp):
    """A Plane timestamp as a string that sorts correctly: always with microseconds, always UTC.

    Plane drops the fraction when it is zero, and "…:46Z" sorts after "…:46.1Z" as text.
    """
    parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def triggered(item, label_ids):
    """The (label name, job kind) pairs this work item asks for, in a fixed order."""
    return [(name, kind) for name, kind in TRIGGERS.items() if label_ids.get(name) in item["labels"]]


def job_id(identifier, sequence_id, kind, updated_at):
    """Same work item, same labelling, same id. `updated_at` pins the moment it was labelled."""
    stamp = datetime.fromisoformat(updated_at.replace("Z", "+00:00")).strftime("%Y%m%dT%H%M%S%f")
    return f"{identifier}-{sequence_id}-{kind}-{stamp}"


def make_job(record, item, kind, profile, now):
    plane = record["plane"]
    return {
        "schema": 1,
        "id": job_id(plane["identifier"], item["sequence_id"], kind, item["updated_at"]),
        "kind": kind,
        "profile": profile,
        "project": record["slug"],
        "plane": {
            "workspace": plane["workspace"],
            "project_id": plane["project_id"],
            "identifier": plane["identifier"],
            "work_item_id": item["id"],
            "sequence_id": item["sequence_id"],
            "name": item["name"],
        },
        "requested_by": "plane-watch",
        "created": now,
    }


def swapped_labels(current, label_ids):
    """The work item's labels with every trigger removed and ai:queued added."""
    triggers = {label_ids[name] for name in TRIGGERS if name in label_ids}
    kept = [label for label in current if label not in triggers]
    queued = label_ids[QUEUED]
    return kept if queued in kept else kept + [queued]


def queued_comment(job_ids):
    names = ", ".join(f"<code>{job}</code>" for job in job_ids)
    return f"<p>Queued for agent: job {names}</p>"


def prune_in_flight(in_flight, now_seconds):
    return {job: since for job, since in in_flight.items() if now_seconds - since < IN_FLIGHT_HOURS * 3600}


# --- One poll -----------------------------------------------------------------------------------


class Watcher:
    def __init__(self, config, google, plane, clock=time.time):
        self.config, self.google, self.plane, self.clock = config, google, plane, clock
        self.state_path = os.path.join(config["state_dir"], "state.json")
        self.busy_path = os.path.join(config["state_dir"], "busy")

    def load_state(self):
        try:
            with open(self.state_path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def save_state(self, state):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, self.state_path)

    def records(self):
        bucket, prefix = self.config["bucket"], f"{self.config['profile']}/projects/"
        for name in self.google.list(bucket, prefix):
            if name.endswith(".json"):
                record = self.google.read(bucket, name)
                if not record.get("archived"):
                    yield record

    def job_known(self, job):
        """Whether any stage of the queue already holds this job."""
        bucket, profile = self.config["bucket"], self.config["profile"]
        return any(
            self.google.exists(bucket, f"{profile}/jobs/{stage}/{job}.json")
            for stage in ("pending", "claimed", "done")
        )

    def queue(self, record, item, hits, label_ids):
        bucket, profile = self.config["bucket"], self.config["profile"]
        now = datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        ids = []
        for _, kind in hits:
            job = make_job(record, item, kind, profile, now)
            ids.append(job["id"])
            if self.job_known(job["id"]):
                log(f"{job['id']} already queued")
            elif self.google.create(bucket, f"{profile}/jobs/pending/{job['id']}.json", job):
                log(f"queued {job['id']}")
        project_id = record["plane"]["project_id"]
        self.plane.set_labels(project_id, item["id"], swapped_labels(item["labels"], label_ids))
        # The comment is for the reader; the job is already safe, so a failure here is only logged.
        try:
            self.plane.comment(project_id, item["id"], queued_comment(ids))
        except (OSError, HttpError) as err:
            log(f"comment on {record['plane']['identifier']}-{item['sequence_id']} failed: {err}")
        return ids

    def refresh_in_flight(self, in_flight):
        """Keep the jobs still in pending/ or claimed/. Returns (in flight, waiting for a worker)."""
        bucket, profile = self.config["bucket"], self.config["profile"]
        still, waiting = {}, []
        for job, since in prune_in_flight(in_flight, self.clock()).items():
            if self.google.exists(bucket, f"{profile}/jobs/pending/{job}.json"):
                still[job] = since
                waiting.append(job)
            elif self.google.exists(bucket, f"{profile}/jobs/claimed/{job}.json"):
                still[job] = since
        if still:
            with open(self.busy_path, "w") as f:
                f.write("\n".join(sorted(still)) + "\n")
        elif os.path.exists(self.busy_path):
            os.remove(self.busy_path)
        return still, waiting

    def poll(self):
        state = self.load_state()
        since = state.get("cursor", "")
        newest = since
        queued = []
        for record in self.records():
            project_id = record["plane"]["project_id"]
            label_ids = self.plane.labels(project_id)
            if QUEUED not in label_ids:
                log(f"{record['slug']}: no {QUEUED} label; skipped")
                continue
            for item in self.plane.updated_since(project_id, since):
                newest = max(newest, moment(item["updated_at"]))
                hits = triggered(item, label_ids)
                if hits:
                    queued += self.queue(record, item, hits, label_ids)
        in_flight = dict(state.get("in_flight", {}))
        for job in queued:
            in_flight.setdefault(job, self.clock())
        state["in_flight"], waiting = self.refresh_in_flight(in_flight)
        state["cursor"] = newest
        self.save_state(state)
        # Asked on every poll while a job waits, so a start that failed, or a worker that stopped
        # before claiming, is put right a minute later. A running worker costs one GET.
        if waiting:
            status = self.google.start_instance(self.config["zone"], self.config["worker"])
            if status != "RUNNING":
                log(f"worker {self.config['worker']} was {status}; started for {len(waiting)} job(s)")
        return queued


def load_config(env=os.environ):
    return {
        "plane_url": env.get("PLANE_URL", "http://proxy:80"),
        "plane_host": env.get("PLANE_HOST", "plane.kaava.internal:8765"),
        "workspace": env.get("PLANE_WORKSPACE", "veistra"),
        "token_secret": env.get("PLANE_TOKEN_SECRET", "plane-pat-kaava"),
        "bucket": env.get("KAAVA_PROJECTS", "veistra-projects"),
        "profile": env.get("KAAVA_PROFILE", "prod"),
        "worker": env.get("KAAVA_WORKER", "kaava-worker"),
        "zone": env.get("KAAVA_ZONE", "us-central1-a"),
        "state_dir": env.get("STATE_DIR", "/state"),
        "interval": int(env.get("INTERVAL", "60")),
    }


def connect(config):
    """Credentials can lag the VM's boot by a few seconds; keep asking."""
    for attempt in range(30):
        try:
            google = Google()
            token = google.secret(config["token_secret"])
            return google, Plane(config["plane_url"], config["plane_host"], config["workspace"], token)
        except (OSError, HttpError, KeyError, ValueError) as err:
            log(f"credentials not ready ({err}); retrying")
            time.sleep(min(60, 5 * (attempt + 1)))
    raise SystemExit("plane-watch: no credentials after 30 attempts")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="plane-watch")
    parser.add_argument("mode", choices=["run", "once"])
    args = parser.parse_args(argv)
    config = load_config()
    os.makedirs(config["state_dir"], exist_ok=True)
    google, plane = connect(config)
    watcher = Watcher(config, google, plane)
    log(f"watching {config['profile']} projects every {config['interval']} s")
    while True:
        try:
            watcher.poll()
        except (OSError, HttpError, KeyError, ValueError) as err:
            # Plane answers 502 until its migrator finishes on a cold boot; the next poll retries.
            log(f"poll failed: {err}")
            if args.mode == "once":
                return 1
        if args.mode == "once":
            return 0
        time.sleep(config["interval"])


if __name__ == "__main__":
    sys.exit(main())
