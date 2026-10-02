"""Unit and loopback tests for kaava-api. No network beyond 127.0.0.1, no Google credentials.

    python services/kaava-api/test_kaava_api.py
"""

import base64
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "infra", "common", "kaava-wake"))
import kaava_api  # noqa: E402
import kaava_wake  # noqa: E402

PAT = "plane_api_SECRET_do_not_leak"


def bearer(email):
    """A token shaped like the one Cloud Run forwards: header, claims, signature removed."""

    def part(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return "Bearer " + ".".join([part({"alg": "RS256"}), part({"email": email, "aud": "x"}), "SIGNATURE_REMOVED_BY_GOOGLE"])


class FakeGoogle:
    def __init__(self, states=("RUNNING",), objects=None):
        self.states = list(states)
        self.objects = objects or {}
        self.woken = 0

    def vm_status(self):
        return self.states[0]

    def wake(self):
        self.woken += 1
        return self.states[0]

    def list_objects(self, bucket, prefix):
        return [n for n in self.objects if n.startswith(prefix)]

    def read_object(self, bucket, name):
        value = self.objects[name]
        if isinstance(value, Exception):
            raise value
        return value


class FakePlane:
    """Records what the proxy sent and answers from a script."""

    def __init__(self, status=200, body=b'{"results": []}', fail=None):
        self.status, self.body, self.fail = status, body, fail
        self.calls = []

    def __call__(self, method, url, headers=None, body=None, timeout=None, limit=None):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "body": body})
        if self.fail:
            raise self.fail
        return self.status, self.body


def make_app(google=None, plane=None, allowed=(), limiter=None, sleep=None):
    return kaava_api.App(
        plane_url="http://10.10.0.5:8765",
        plane_host="plane.kaava.internal:8765",
        plane_token=PAT,
        google=google or FakeGoogle(),
        allowed=allowed,
        limiter=limiter,
        plane_request=plane or FakePlane(),
        sleep=sleep or (lambda s: None),
    )


AUTH = {"Authorization": bearer("braden@example.com")}


class PathRules(unittest.TestCase):
    def test_plane_style_paths_pass(self):
        for good in ["workspaces/veistra/projects/", "workspaces/veistra/projects/abc-123/work-items/"]:
            self.assertTrue(kaava_api.is_safe_path(good), good)

    def test_traversal_and_hosts_are_refused(self):
        for bad in ["", "/workspaces", "workspaces/../secrets", "http://evil", "a/%2e%2e/b", "a b", "a?b", "a\\b"]:
            self.assertFalse(kaava_api.is_safe_path(bad), bad)

    def test_per_page_is_clamped_and_other_keys_kept(self):
        self.assertEqual(kaava_api.clamp_query("per_page=5000&cursor=1:2:0"), "per_page=100&cursor=1%3A2%3A0")
        self.assertEqual(kaava_api.clamp_query("per_page=20"), "per_page=20")
        self.assertEqual(kaava_api.clamp_query(""), "")


class Identity(unittest.TestCase):
    def test_email_is_read_from_the_forwarded_token(self):
        self.assertEqual(kaava_api.caller_email(bearer("Braden@Example.com")), "braden@example.com")

    def test_garbage_is_no_one(self):
        for header in [None, "", "Basic abc", "Bearer", "Bearer a.!!!.c", "Bearer onlyonepart"]:
            self.assertIsNone(kaava_api.caller_email(header), header)

    def test_allowlist_refuses_others_and_admits_listed(self):
        app = make_app(allowed=kaava_api.parse_allowlist("braden@example.com, other@example.com"))
        self.assertEqual(app.handle("GET", "/v1/plane/status", {"Authorization": bearer("x@evil.com")}).status, 403)
        self.assertEqual(app.handle("GET", "/v1/plane/status", {}).status, 403)
        self.assertEqual(app.handle("GET", "/v1/plane/status", AUTH).status, 200)

    def test_no_allowlist_leaves_it_to_iam(self):
        self.assertEqual(make_app().handle("GET", "/v1/plane/status", {}).status, 200)

    def test_health_needs_no_allowlist_entry(self):
        app = make_app(allowed={"someone@else.com"})
        self.assertEqual(app.handle("GET", "/health", {}).status, 200)


class Proxy(unittest.TestCase):
    def test_get_carries_the_pat_and_host_and_clamps(self):
        plane = FakePlane()
        reply = make_app(plane=plane).handle("GET", "/v1/plane/api/v1/workspaces/veistra/projects/?per_page=900", AUTH)
        self.assertEqual(reply.status, 200)
        sent = plane.calls[0]
        self.assertEqual(sent["url"], "http://10.10.0.5:8765/api/v1/workspaces/veistra/projects/?per_page=100")
        self.assertEqual(sent["headers"]["X-API-Key"], PAT)
        self.assertEqual(sent["headers"]["Host"], "plane.kaava.internal:8765")
        self.assertIsNone(sent["body"])

    def test_post_and_patch_forward_a_json_body(self):
        for verb in ("POST", "PATCH"):
            plane = FakePlane(status=201, body=b'{"id": "1"}')
            reply = make_app(plane=plane).handle(verb, "/v1/plane/api/v1/workspaces/veistra/x/", AUTH, b'{"name": "a"}')
            self.assertEqual(reply.status, 201)
            self.assertEqual(plane.calls[0]["method"], verb)
            self.assertEqual(plane.calls[0]["body"], b'{"name": "a"}')
            self.assertEqual(plane.calls[0]["headers"]["Content-Type"], "application/json")

    def test_other_verbs_are_refused_before_plane_is_called(self):
        plane = FakePlane()
        for verb in ("DELETE", "PUT"):
            self.assertEqual(make_app(plane=plane).handle(verb, "/v1/plane/api/v1/workspaces/", AUTH).status, 405)
        self.assertEqual(plane.calls, [])

    def test_unsafe_paths_never_reach_plane(self):
        plane = FakePlane()
        for path in ["../../secrets", "workspaces/..", "/etc"]:
            reply = make_app(plane=plane).handle("GET", "/v1/plane/api/v1/" + path, AUTH)
            self.assertEqual(reply.status, 400, path)
        self.assertEqual(plane.calls, [])

    def test_a_non_json_body_is_refused(self):
        reply = make_app().handle("POST", "/v1/plane/api/v1/workspaces/", AUTH, b"not json")
        self.assertEqual(reply.status, 400)

    def test_a_sleeping_plane_is_503_and_is_not_woken(self):
        google = FakeGoogle(states=["TERMINATED"])
        plane = FakePlane(fail=ConnectionRefusedError("refused"))
        reply = make_app(google=google, plane=plane).handle("GET", "/v1/plane/api/v1/workspaces/", AUTH)
        self.assertEqual(reply.status, 503)
        self.assertEqual(json.loads(reply.body)["error"], "plane_unreachable")
        self.assertEqual(google.woken, 0)

    def test_plane_starting_up_502_reads_as_unreachable(self):
        reply = make_app(plane=FakePlane(status=502, body=b"<html>Bad Gateway</html>")).handle(
            "GET", "/v1/plane/api/v1/workspaces/", AUTH
        )
        self.assertEqual(reply.status, 503)

    def test_plane_refusing_our_token_is_not_a_signed_out_401(self):
        reply = make_app(plane=FakePlane(status=401, body=b'{"detail": "bad key"}')).handle(
            "GET", "/v1/plane/api/v1/workspaces/", AUTH
        )
        self.assertEqual(reply.status, 502)
        self.assertEqual(json.loads(reply.body)["error"], "plane_auth")

    def test_plane_errors_pass_through(self):
        reply = make_app(plane=FakePlane(status=404, body=b'{"detail": "nope"}')).handle(
            "GET", "/v1/plane/api/v1/workspaces/x/", AUTH
        )
        self.assertEqual(reply.status, 404)


class RateLimit(unittest.TestCase):
    def test_the_window_admits_the_budget_then_asks_for_a_wait(self):
        t = [0.0]
        limiter = kaava_api.RateLimiter(limit=3, window=60, clock=lambda: t[0])
        self.assertEqual([limiter.admit() for _ in range(3)], [0.0, 0.0, 0.0])
        self.assertEqual(limiter.admit(), 60.0)
        t[0] = 60.0
        self.assertEqual(limiter.admit(), 0.0)

    def test_a_long_wait_is_429_with_retry_after_and_plane_is_not_called(self):
        t = [0.0]
        limiter = kaava_api.RateLimiter(limit=1, window=60, clock=lambda: t[0])
        plane = FakePlane()
        app = make_app(plane=plane, limiter=limiter)
        self.assertEqual(app.handle("GET", "/v1/plane/api/v1/workspaces/", AUTH).status, 200)
        reply = app.handle("GET", "/v1/plane/api/v1/workspaces/", AUTH)
        self.assertEqual(reply.status, 429)
        self.assertEqual(reply.headers["Retry-After"], "60")
        self.assertEqual(len(plane.calls), 1)

    def test_a_short_wait_is_slept_out(self):
        t = [0.0]
        limiter = kaava_api.RateLimiter(limit=1, window=60, clock=lambda: t[0])

        def sleep(seconds):
            t[0] += seconds

        app = make_app(limiter=limiter, sleep=sleep)
        app.handle("GET", "/v1/plane/api/v1/workspaces/", AUTH)
        t[0] = 57.0
        self.assertEqual(app.handle("GET", "/v1/plane/api/v1/workspaces/", AUTH).status, 200)
        self.assertEqual(t[0], 60.0)


class WakeAndStatus(unittest.TestCase):
    def test_status_of_a_stopped_vm_never_wakes_it(self):
        google = FakeGoogle(states=["TERMINATED"])
        plane = FakePlane()
        reply = make_app(google=google, plane=plane).handle("GET", "/v1/plane/status", AUTH)
        self.assertEqual(json.loads(reply.body), {"vm": "TERMINATED", "healthy": False, "detail": "plane-vm is TERMINATED"})
        self.assertEqual(google.woken, 0)
        self.assertEqual(plane.calls, [], "no health check against a stopped VM")

    def test_status_of_a_running_vm_checks_both_health_paths_with_the_host_header(self):
        plane = FakePlane(status=200, body=b"")
        reply = make_app(plane=plane).handle("GET", "/v1/plane/status", AUTH)
        self.assertTrue(json.loads(reply.body)["healthy"])
        self.assertEqual([c["url"] for c in plane.calls], ["http://10.10.0.5:8765/", "http://10.10.0.5:8765/api/instances/"])
        self.assertTrue(all(c["headers"]["Host"] == "plane.kaava.internal:8765" for c in plane.calls))
        self.assertTrue(all("X-API-Key" not in c["headers"] for c in plane.calls), "health needs no token")

    def test_running_but_booting_is_unhealthy_with_the_reason(self):
        reply = make_app(plane=FakePlane(status=502)).handle("GET", "/v1/plane/status", AUTH)
        body = json.loads(reply.body)
        self.assertFalse(body["healthy"])
        self.assertIn("HTTP 502", body["detail"])

    def test_wake_starts_only_through_post(self):
        google = FakeGoogle(states=["TERMINATED"])
        app = make_app(google=google)
        self.assertEqual(app.handle("GET", "/v1/plane/wake", AUTH).status, 405)
        self.assertEqual(google.woken, 0)
        reply = app.handle("POST", "/v1/plane/wake", AUTH)
        self.assertEqual(reply.status, 200)
        self.assertEqual(json.loads(reply.body)["vm"], "TERMINATED")
        self.assertEqual(google.woken, 1)

    def test_a_compute_failure_is_502_naming_compute(self):
        class Broken(FakeGoogle):
            def vm_status(self):
                raise kaava_wake.WakeError("GET ...: HTTP 403: denied")

        reply = make_app(google=Broken()).handle("GET", "/v1/plane/status", AUTH)
        self.assertEqual(reply.status, 502)
        self.assertEqual(json.loads(reply.body)["error"], "compute")


class GoogleWake(unittest.TestCase):
    """`Google.wake` makes kaava-wake's first-step decision against the real Compute URLs."""

    def run_wake(self, state):
        calls = []

        def http(method, url, headers=None, timeout=10):
            calls.append((method, url.rsplit("/", 1)[-1]))
            return 200, json.dumps({"status": state})

        original = (kaava_wake.http, kaava_wake.access_token)
        kaava_wake.http, kaava_wake.access_token = http, lambda: "tok"
        try:
            kaava_api.Google("p", "us-central1-a", "plane-vm").wake()
        finally:
            kaava_wake.http, kaava_wake.access_token = original
        return [c for c in calls if c[0] == "POST"]

    def test_terminated_is_started(self):
        self.assertEqual(self.run_wake("TERMINATED"), [("POST", "start")])

    def test_suspended_is_resumed(self):
        self.assertEqual(self.run_wake("SUSPENDED"), [("POST", "resume")])

    def test_running_and_stopping_are_left_alone(self):
        self.assertEqual(self.run_wake("RUNNING"), [])
        self.assertEqual(self.run_wake("STOPPING"), [])


class Projects(unittest.TestCase):
    def test_records_are_listed_and_a_bad_one_is_a_problem(self):
        google = FakeGoogle(
            objects={
                "prod/projects/anomaly.json": b'{"slug": "anomaly"}',
                "prod/projects/broken.json": b"{",
                "prod/projects/README.txt": b"not a record",
                "dev/projects/sandbox.json": b'{"slug": "sandbox"}',
            }
        )
        body = json.loads(make_app(google=google).handle("GET", "/v1/projects?profile=prod", AUTH).body)
        self.assertEqual(body["projects"], [{"slug": "anomaly"}])
        self.assertEqual(len(body["problems"]), 1)
        self.assertIn("broken.json", body["problems"][0])

    def test_an_unknown_profile_is_refused(self):
        self.assertEqual(make_app().handle("GET", "/v1/projects?profile=../x", AUTH).status, 400)

    def test_listing_never_wakes_plane(self):
        google = FakeGoogle(states=["TERMINATED"])
        make_app(google=google).handle("GET", "/v1/projects", AUTH)
        self.assertEqual(google.woken, 0)


class Loopback(unittest.TestCase):
    """The real server against a real fake Plane, both on 127.0.0.1."""

    @classmethod
    def setUpClass(cls):
        received = cls.received = []

        class PlaneHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append({"path": self.path, "key": self.headers.get("X-API-Key"), "host": self.headers.get("Host")})
                body = b'{"results": [], "next_cursor": null}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.plane = ThreadingHTTPServer(("127.0.0.1", 0), PlaneHandler)
        threading.Thread(target=cls.plane.serve_forever, daemon=True).start()

        app = kaava_api.App(
            plane_url=f"http://127.0.0.1:{cls.plane.server_port}",
            plane_host="plane.kaava.internal:8765",
            plane_token=PAT,
            google=FakeGoogle(),
        )
        cls.api = ThreadingHTTPServer(("127.0.0.1", 0), kaava_api.make_handler(app))
        threading.Thread(target=cls.api.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.api.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.api.shutdown()
        cls.plane.shutdown()

    def fetch(self, path, method="GET"):
        req = urllib.request.Request(self.base + path, method=method, headers=dict(AUTH))
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), err.read()

    def test_a_proxied_get_round_trips_and_the_pat_stays_inside(self):
        import io
        from contextlib import redirect_stderr

        logs = io.StringIO()
        with redirect_stderr(logs):
            status, headers, body = self.fetch("/v1/plane/api/v1/workspaces/veistra/projects/?per_page=500")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["results"], [])
        self.assertEqual(headers.get("X-Kaava-Api"), "1")
        self.assertEqual(self.received[-1]["path"], "/api/v1/workspaces/veistra/projects/?per_page=100")
        self.assertEqual(self.received[-1]["key"], PAT)
        self.assertEqual(self.received[-1]["host"], "plane.kaava.internal:8765")
        self.assertNotIn(PAT.encode(), body)
        for leaked in (PAT, "Bearer", "per_page"):
            self.assertNotIn(leaked, logs.getvalue(), "the log names the route only")
        self.assertIn("braden@example.com", logs.getvalue())

    def test_health(self):
        status, _, body = self.fetch("/health")
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))

    def test_an_unknown_route_is_404_json(self):
        status, _, body = self.fetch("/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "not_found")


class Config(unittest.TestCase):
    def test_from_env_reads_every_setting_and_strips_the_pat(self):
        app = kaava_api.from_env(
            {
                "KAAVA_PROJECT": "p",
                "PLANE_URL": "http://10.10.0.5:8765/",
                "PLANE_PAT": PAT + "\n",
                "ALLOWED_EMAILS": "A@x.com,b@x.com",
            }
        )
        self.assertEqual(app.plane_url, "http://10.10.0.5:8765")
        self.assertEqual(app.plane_token, PAT)
        self.assertEqual(app.allowed, {"a@x.com", "b@x.com"})
        self.assertEqual(app.google.project, "p")


if __name__ == "__main__":
    unittest.main()
