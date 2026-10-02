#!/usr/bin/env python3
"""kaava-api: the one door OpenKaava uses to reach Plane (Plane design §2, §3.3, §7.1).

A Cloud Run service behind Google IAM. The desktop app sends a Google ID token; Cloud Run checks it
and the invoker binding before this code runs. The service then reaches plane-vm over the VPC
(Direct VPC egress), so the laptop needs no IAP tunnel, no hosts entry and no Plane token for the
REST API. The Plane personal access token (`plane-pat-kaava`) reaches this process as an
environment variable from Secret Manager and never leaves it.

    GET   /health                              this process is up (touches nothing else)
    GET   /v1/plane/status                     {"vm": <Compute status>, "healthy": bool, "detail"}
    POST  /v1/plane/wake                       start (or resume) plane-vm, then answer as status
    GET   /v1/projects?profile=prod|dev        the project records (design §3.1), a bucket read
    GET   /v1/plane/api/v1/<path>[?query]      Plane's REST API, with the service's own token
    POST  /v1/plane/api/v1/<path>              same, JSON body
    PATCH /v1/plane/api/v1/<path>              same, JSON body

Rules this file keeps, each with a test:

- The proxy is narrow: GET, POST and PATCH only, under `/api/v1/` only, and every path segment must
  be a plain name (`is_safe_path`, the same rule as `cloud::plane::is_safe_path` in the app).
- `per_page` is clamped to 100 (design §7.1), and calls are held to Plane's 300 a minute per key
  (§12 V4). Cloud Run runs at most one instance, so the limiter in memory is the whole budget.
- Waking is a request a person made: nothing here starts plane-vm except `POST /v1/plane/wake`. A
  proxied call that finds Plane asleep answers 503 `plane_unreachable` and does not wake it.
- `ALLOWED_EMAILS`, when set, narrows the IAM invokers to these Google identities.
- No token is logged, returned or put in an error. A log line names the method, the route, the
  status and the caller's email.

Standard library only, like the rest of infra/: the image is the stock Python image with this file
and `kaava_wake.py` (infra/common/kaava-wake/) copied in.
"""

import base64
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import kaava_wake

# design §7.1 and §12 V4
MAX_PER_PAGE = 100
RATE_LIMIT = 300
RATE_WINDOW = 60.0
# A burst that would wait longer than this answers 429 with Retry-After instead of holding the
# request open (and the instance billed) while it waits.
MAX_QUEUE_SECONDS = 5.0

MAX_BODY = 1 << 20
MAX_REPLY = 8 << 20
PLANE_TIMEOUT = 30
HEALTH_TIMEOUT = 5
HEALTH_PATHS = ("/", "/api/instances/")

PROFILES = ("prod", "dev")
PROXY_PREFIX = "/v1/plane/api/v1/"
STORAGE = "https://storage.googleapis.com/storage/v1"


def log(message):
    print(f"[kaava-api] {message}", file=sys.stderr, flush=True)


# --- Pure rules -------------------------------------------------------------------------------


def is_plain_segment(part):
    """One path segment: letters, digits, `-`, `_` and `.`, and not `.` or `..`."""
    return (
        part not in ("", ".", "..")
        and all(c.isascii() and (c.isalnum() or c in "-_.") for c in part)
    )


def is_safe_path(path):
    """The app's `plane::is_safe_path`: a relative path under /api/v1/ with only plain segments.

    A trailing slash is allowed (every Plane list endpoint has one), so empty segments pass.
    """
    return (
        bool(path)
        and not path.startswith("/")
        and ".." not in path
        and all(seg == "" or is_plain_segment(seg) for seg in path.split("/"))
    )


def clamp_query(query_string):
    """The query, re-encoded, with `per_page` never above MAX_PER_PAGE."""
    pairs = []
    for key, value in urllib.parse.parse_qsl(query_string, keep_blank_values=True):
        if key == "per_page":
            try:
                value = str(min(int(value), MAX_PER_PAGE))
            except ValueError:
                pass
        pairs.append((key, value))
    return urllib.parse.urlencode(pairs)


def caller_email(authorization):
    """The `email` claim of the bearer token Cloud Run already verified, lowercased, or None.

    Cloud Run checks the signature, audience and expiry before the request arrives, and replaces
    the signature in the forwarded header, so reading the payload here is all that is left to do.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    parts = authorization[7:].strip().split(".")
    if len(parts) < 2:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, TypeError):
        return None
    email = claims.get("email") if isinstance(claims, dict) else None
    return email.strip().lower() if isinstance(email, str) and email.strip() else None


def parse_allowlist(text):
    return {e.strip().lower() for e in (text or "").split(",") if e.strip()}


class RateLimiter:
    """A sliding window of call times. `admit` records a call and returns 0, or the wait needed."""

    def __init__(self, limit=RATE_LIMIT, window=RATE_WINDOW, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self.calls = []
        self.lock = threading.Lock()

    def admit(self):
        with self.lock:
            now = self.clock()
            self.calls = [t for t in self.calls if now - t < self.window]
            if len(self.calls) < self.limit:
                self.calls.append(now)
                return 0.0
            return self.window - (now - self.calls[0])


# --- Outbound HTTP ----------------------------------------------------------------------------


def request(method, url, headers=None, body=None, timeout=PLANE_TIMEOUT, limit=MAX_REPLY):
    """One request. Returns (status, bytes); network failures raise OSError."""
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(limit)
    except urllib.error.HTTPError as err:
        return err.code, err.read(limit)


class Google:
    """Compute and Storage as the service's own account, through the metadata server."""

    def __init__(self, project, zone, instance):
        self.project, self.zone, self.instance = project, zone, instance

    def _instance(self):
        return kaava_wake.Instance(self.project, self.zone, self.instance, kaava_wake.access_token())

    def vm_status(self):
        return self._instance().status()

    def wake(self):
        """Ask for RUNNING the way kaava-wake's first step does. Returns the status it found."""
        instance = self._instance()
        state = instance.status()
        if state in ("TERMINATED", "STOPPED"):
            instance.start()
        elif state == "SUSPENDED":
            instance.resume()
        return state

    def _get(self, url):
        token = kaava_wake.access_token()
        status, body = request("GET", url, {"Authorization": f"Bearer {token}"}, timeout=20)
        if status != 200:
            raise kaava_wake.WakeError(f"Cloud Storage answered HTTP {status}")
        return body

    def list_objects(self, bucket, prefix):
        names, page = [], None
        while True:
            query = {"prefix": prefix, "fields": "items(name),nextPageToken"}
            if page:
                query["pageToken"] = page
            reply = json.loads(self._get(f"{STORAGE}/b/{bucket}/o?{urllib.parse.urlencode(query)}"))
            names += [item["name"] for item in reply.get("items", [])]
            page = reply.get("nextPageToken")
            if not page:
                return names

    def read_object(self, bucket, name):
        return self._get(f"{STORAGE}/b/{bucket}/o/{urllib.parse.quote(name, safe='')}?alt=media")


# --- The application, with every dependency passed in ------------------------------------------


class Reply:
    def __init__(self, status, body, headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers = headers or {}


def error(status, code, detail, headers=None):
    return Reply(status, {"error": code, "detail": detail}, headers)


class App:
    def __init__(
        self,
        plane_url,
        plane_host,
        plane_token,
        google,
        bucket="veistra-projects",
        allowed=frozenset(),
        limiter=None,
        plane_request=request,
        sleep=time.sleep,
    ):
        self.plane_url = plane_url.rstrip("/")
        self.plane_host = plane_host
        self.plane_token = plane_token
        self.google = google
        self.bucket = bucket
        self.allowed = set(allowed)
        self.limiter = limiter or RateLimiter()
        self.plane_request = plane_request
        self.sleep = sleep

    def handle(self, method, target, headers, body=b""):
        """Route one request. `headers` is a case-insensitive mapping (or a dict with title case)."""
        path, _, query = target.partition("?")
        if path == "/health":
            return Reply(200, {"ok": True}) if method == "GET" else error(405, "method", "GET only")

        email = caller_email(headers.get("Authorization"))
        if self.allowed and email not in self.allowed:
            return error(403, "not_allowed", "this Google identity is not on kaava-api's allowlist")

        if path == "/v1/plane/status":
            return self.status() if method == "GET" else error(405, "method", "GET only")
        if path == "/v1/plane/wake":
            return self.wake() if method == "POST" else error(405, "method", "POST only")
        if path == "/v1/projects":
            return self.projects(query) if method == "GET" else error(405, "method", "GET only")
        if path.startswith(PROXY_PREFIX):
            return self.proxy(method, path[len(PROXY_PREFIX) :], query, headers, body)
        return error(404, "not_found", "no such route")

    # -- wake and status --

    def plane_health(self):
        """None when both health paths answer 200, else what the first failing one said."""
        for path in HEALTH_PATHS:
            try:
                status, _ = self.plane_request(
                    "GET", self.plane_url + path, {"Host": self.plane_host}, timeout=HEALTH_TIMEOUT, limit=1 << 16
                )
            except OSError as err:
                return f"{path}: {err}"
            if status != 200:
                return f"{path}: HTTP {status}"
        return None

    def status(self, vm=None):
        try:
            vm = vm or self.google.vm_status()
        except (kaava_wake.WakeError, OSError, ValueError, KeyError) as err:
            return error(502, "compute", str(err))
        if vm != "RUNNING":
            return Reply(200, {"vm": vm, "healthy": False, "detail": f"plane-vm is {vm}"})
        problem = self.plane_health()
        return Reply(200, {"vm": vm, "healthy": problem is None, "detail": problem or "healthy"})

    def wake(self):
        try:
            before = self.google.wake()
        except (kaava_wake.WakeError, OSError, ValueError, KeyError) as err:
            return error(502, "compute", str(err))
        log(f"wake: plane-vm was {before}")
        if before == "RUNNING":
            return self.status(vm=before)
        return Reply(200, {"vm": before, "healthy": False, "detail": f"plane-vm was {before}; starting"})

    # -- project records --

    def projects(self, query):
        params = dict(urllib.parse.parse_qsl(query))
        profile = params.get("profile", "prod")
        if profile not in PROFILES:
            return error(400, "bad_profile", f"profile must be one of {', '.join(PROFILES)}")
        prefix = f"{profile}/projects/"
        try:
            names = [n for n in self.google.list_objects(self.bucket, prefix) if n.endswith(".json")]
        except (kaava_wake.WakeError, OSError, ValueError, KeyError) as err:
            return error(502, "storage", str(err))
        records, problems = [], []
        for name in names:
            try:
                records.append(json.loads(self.google.read_object(self.bucket, name)))
            except (kaava_wake.WakeError, OSError, ValueError) as err:
                problems.append(f"{name}: {err}")
        return Reply(200, {"profile": profile, "projects": records, "problems": problems})

    # -- the Plane proxy --

    def proxy(self, method, rest, query, headers, body):
        if method not in ("GET", "POST", "PATCH"):
            return error(405, "method", "GET, POST and PATCH only")
        if not is_safe_path(rest):
            return error(400, "unsafe_path", "not a path kaava-api may ask Plane for")
        if method == "GET":
            body = None
        elif body:
            try:
                json.loads(body)
            except ValueError:
                return error(400, "bad_body", "the body must be JSON")
        else:
            body = None

        wait = self.limiter.admit()
        while wait > 0:
            if wait > MAX_QUEUE_SECONDS:
                return error(
                    429,
                    "rate_limited",
                    f"Plane allows {RATE_LIMIT} calls a minute; try again shortly",
                    {"Retry-After": str(math.ceil(wait))},
                )
            self.sleep(wait)
            wait = self.limiter.admit()

        url = f"{self.plane_url}/api/v1/{rest}"
        clamped = clamp_query(query)
        if clamped:
            url += "?" + clamped
        out = {"X-API-Key": self.plane_token, "Host": self.plane_host, "Accept": "application/json"}
        if body is not None:
            out["Content-Type"] = "application/json"
        try:
            status, reply = self.plane_request(method, url, out, body)
        except OSError as err:
            # Connection refused or timed out: plane-vm is stopped or still booting.
            return error(503, "plane_unreachable", f"Plane did not answer: {type(err).__name__}")
        if status == 502 and not reply.strip().startswith(b"{"):
            # Plane's proxy answers 502 while its containers start (handoff, Connecting step 2).
            return error(503, "plane_unreachable", "Plane is still starting")
        if status == 401:
            # Plane refused the service's own token. Passed through as 401 it would read as the
            # caller being signed out, which is Cloud Run's 401 and a different fix.
            return error(502, "plane_auth", "Plane refused kaava-api's token (plane-pat-kaava)")
        return Reply(status, reply)


# --- HTTP server ------------------------------------------------------------------------------


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "kaava-api"
        sys_version = ""

        def _serve(self):
            started = time.monotonic()
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                reply = error(413, "too_large", f"bodies are limited to {MAX_BODY} bytes")
            else:
                body = self.rfile.read(length) if length else b""
                try:
                    reply = app.handle(self.command, self.path, self.headers, body)
                except Exception as err:  # noqa: BLE001 - one bad request must not end the process
                    log(f"unhandled {type(err).__name__} on {self.command} {self.path.partition('?')[0]}")
                    reply = error(500, "internal", "kaava-api failed; see its logs")
            self.send_response(reply.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply.body)))
            self.send_header("Cache-Control", "no-store")
            # Marks a reply as ours. A 401 or 403 without it came from Cloud Run's IAM check.
            self.send_header("X-Kaava-Api", "1")
            for key, value in reply.headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(reply.body)
            route = self.path.partition("?")[0]
            who = caller_email(self.headers.get("Authorization")) or "-"
            log(f"{self.command} {route} {reply.status} {who} {1000 * (time.monotonic() - started):.0f}ms")

        do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _serve

        def log_message(self, format, *args):  # noqa: A002 - the base class's name
            # The default logger prints the request line, query included. _serve logs instead.
            pass

    return Handler


def from_env(env=os.environ):
    project = env.get("KAAVA_PROJECT") or kaava_wake.default_project()
    google = Google(project, env.get("KAAVA_ZONE", "us-central1-a"), env.get("PLANE_INSTANCE", "plane-vm"))
    return App(
        plane_url=env["PLANE_URL"],
        plane_host=env.get("PLANE_HOST", "plane.kaava.internal:8765"),
        plane_token=env["PLANE_PAT"].strip(),
        google=google,
        bucket=env.get("PROJECTS_BUCKET", "veistra-projects"),
        allowed=parse_allowlist(env.get("ALLOWED_EMAILS")),
    )


def main():
    app = from_env()
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(app))
    log(f"listening on {port}; allowlist {'on' if app.allowed else 'off (IAM only)'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
