import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import kaava_wake  # noqa: E402

SERVICES = {"plane": {"instance": "plane-vm", "health": ["http://h/", "http://h/api/instances/"]}}
INSTANCE = "https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/plane-vm"


class FakeCloud:
    """Answers the Compute API from a script of states and the health URLs from a script of codes."""

    def __init__(self, states, health=None):
        self.states = list(states)
        self.health = list(health or [200])
        self.calls = []
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds

    def http(self, method, url, headers=None, timeout=10):
        self.calls.append((method, url))
        if url.startswith(INSTANCE):
            if method == "POST":
                return 200, "{}"
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            return 200, json.dumps({"status": state})
        code = self.health.pop(0) if len(self.health) > 1 else self.health[0]
        if isinstance(code, Exception):
            raise code
        return code, ""

    def posts(self):
        return [url[len(INSTANCE) :] for method, url in self.calls if method == "POST"]


class Wake(unittest.TestCase):
    def run_wake(self, cloud):
        with (
            mock.patch.object(kaava_wake, "http", cloud.http),
            mock.patch.object(kaava_wake, "now", cloud.now),
            mock.patch.object(kaava_wake, "sleep", cloud.sleep),
            mock.patch.object(kaava_wake, "access_token", return_value="tok"),
        ):
            return kaava_wake.wake("plane", project="p", log=kaava_wake.quiet_log, services=SERVICES)

    def test_running_skips_start(self):
        cloud = FakeCloud(["RUNNING"])
        self.assertEqual(self.run_wake(cloud), 0)
        self.assertEqual(cloud.posts(), [])

    def test_terminated_starts_once_then_polls(self):
        cloud = FakeCloud(["TERMINATED", "TERMINATED", "STAGING", "RUNNING"])
        seconds = self.run_wake(cloud)
        self.assertEqual(cloud.posts(), ["/start"])
        self.assertEqual(seconds, 9)

    def test_stopping_waits_for_terminated(self):
        cloud = FakeCloud(["STOPPING", "STOPPING", "TERMINATED", "RUNNING"])
        self.run_wake(cloud)
        self.assertEqual(cloud.posts(), ["/start"])
        first_post = next(i for i, (m, _) in enumerate(cloud.calls) if m == "POST")
        # Two STOPPING reads and the TERMINATED read come before the start.
        self.assertEqual(first_post, 3)

    def test_suspended_resumes(self):
        cloud = FakeCloud(["SUSPENDED", "RUNNING"])
        self.run_wake(cloud)
        self.assertEqual(cloud.posts(), ["/resume"])

    def test_health_retries_until_200(self):
        cloud = FakeCloud(["RUNNING"], health=[OSError("refused"), 502, 200, 200, 200])
        seconds = self.run_wake(cloud)
        # Round 1 fails on both URLs (refused, 502); round 2 passes both, one poll later.
        self.assertEqual(seconds, kaava_wake.POLL_SECONDS)
        health_calls = [u for m, u in cloud.calls if not u.startswith(INSTANCE)]
        self.assertEqual(len(health_calls), 4)

    def test_running_timeout_raises(self):
        cloud = FakeCloud(["TERMINATED", "STAGING"])
        with self.assertRaises(kaava_wake.WakeError) as ctx:
            self.run_wake(cloud)
        self.assertIn("not RUNNING", str(ctx.exception))
        self.assertGreaterEqual(cloud.t, kaava_wake.RUNNING_TIMEOUT)

    def test_health_timeout_raises_with_last_error(self):
        cloud = FakeCloud(["RUNNING"], health=[502])
        with self.assertRaises(kaava_wake.WakeError) as ctx:
            self.run_wake(cloud)
        self.assertIn("HTTP 502", str(ctx.exception))

    def test_unknown_service(self):
        with self.assertRaises(kaava_wake.WakeError):
            kaava_wake.wake("nope", project="p", log=kaava_wake.quiet_log, services=SERVICES)


class Main(unittest.TestCase):
    def test_timeout_exits_1(self):
        err = io.StringIO()
        with (
            mock.patch.object(kaava_wake, "wake", side_effect=kaava_wake.WakeError("unhealthy after 240 s")),
            redirect_stderr(err),
        ):
            self.assertEqual(kaava_wake.main(["plane", "--quiet"]), 1)
        self.assertIn("unhealthy after 240 s", err.getvalue())

    def test_success_exits_0(self):
        with mock.patch.object(kaava_wake, "wake", return_value=42.0), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(kaava_wake.main(["plane"]), 0)
        self.assertIn("healthy in 42 s", err.getvalue())


class Services(unittest.TestCase):
    def test_extra_services_file(self):
        path = os.path.join(os.path.dirname(__file__), "_services_test.json")
        with open(path, "w") as f:
            json.dump({"hindsight": {"instance": "x", "health": []}}, f)
        self.addCleanup(os.remove, path)
        services = kaava_wake.load_services(path)
        self.assertIn("plane", services)
        self.assertIn("hindsight", services)

    def test_missing_services_file(self):
        self.assertEqual(kaava_wake.load_services("/no/such/file.json"), kaava_wake.SERVICES)


if __name__ == "__main__":
    unittest.main()
