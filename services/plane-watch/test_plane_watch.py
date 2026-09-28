import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import plane_watch  # noqa: E402

LABELS = {
    "ai:breakdown": "L-breakdown",
    "ai:plan-cycle": "L-plan",
    "ai:context": "L-context",
    "ai:do": "L-do",
    "ai:queued": "L-queued",
    "ai:done": "L-done",
    "ai:failed": "L-failed",
    "art": "L-art",
}

RECORD = {
    "schema": 1,
    "slug": "openkaava",
    "plane": {"workspace": "veistra", "project_id": "P1", "identifier": "KAAVA"},
    "archived": False,
}


def item(seq, updated_at, labels=()):
    return {"id": f"W{seq}", "sequence_id": seq, "name": f"item {seq}", "updated_at": updated_at, "labels": list(labels)}


class FakeGoogle:
    def __init__(self, records):
        self.objects = {f"prod/projects/{r['slug']}.json": r for r in records}
        self.started = []
        self.status = "TERMINATED"

    def list(self, bucket, prefix):
        return sorted(name for name in self.objects if name.startswith(prefix))

    def read(self, bucket, name):
        return self.objects[name]

    def exists(self, bucket, name):
        return name in self.objects

    def create(self, bucket, name, document):
        if name in self.objects:
            return False
        self.objects[name] = document
        return True

    def start_instance(self, zone, name):
        self.started.append(name)
        return self.status

    def jobs(self, stage):
        return sorted(n.split("/")[-1][:-5] for n in self.objects if n.startswith(f"prod/jobs/{stage}/"))


class FakePlane:
    def __init__(self, items):
        self.items = {i["id"]: i for i in items}
        self.comments = []
        self.clock = 0
        self.fail_comment = False

    def labels(self, project_id):
        return dict(LABELS)

    def updated_since(self, project_id, since):
        ordered = sorted(self.items.values(), key=lambda i: plane_watch.moment(i["updated_at"]), reverse=True)
        return [i for i in ordered if plane_watch.moment(i["updated_at"]) >= since]

    def set_labels(self, project_id, item_id, labels):
        # Plane bumps updated_at on every change, as the live API does.
        self.clock += 1
        self.items[item_id] = {**self.items[item_id], "labels": labels, "updated_at": f"2026-09-28T03:00:{self.clock:02d}Z"}

    def comment(self, project_id, item_id, html):
        if self.fail_comment:
            raise plane_watch.HttpError(500, "boom")
        self.comments.append((item_id, html))


class PureTest(unittest.TestCase):
    def test_moment_sorts_a_whole_second_before_its_fractions(self):
        self.assertLess(plane_watch.moment("2026-09-28T02:22:46Z"), plane_watch.moment("2026-09-28T02:22:46.1Z"))
        self.assertEqual(plane_watch.moment("2026-09-28T02:22:46+00:00"), "2026-09-28T02:22:46.000000Z")

    def test_triggered_lists_every_trigger_label_and_nothing_else(self):
        found = plane_watch.triggered(item(1, "t", ["L-art", "L-do", "L-breakdown", "L-queued"]), LABELS)
        self.assertEqual(found, [("ai:breakdown", "breakdown"), ("ai:do", "do")])

    def test_job_id_is_stable_for_the_same_labelling(self):
        a = plane_watch.job_id("KAAVA", 12, "breakdown", "2026-09-28T02:22:46.318787Z")
        b = plane_watch.job_id("KAAVA", 12, "breakdown", "2026-09-28T02:22:46.318787+00:00")
        self.assertEqual(a, b)
        self.assertEqual(a, "KAAVA-12-breakdown-20260928T022246318787")

    def test_swapped_labels_removes_triggers_keeps_the_rest_and_adds_queued_once(self):
        self.assertEqual(plane_watch.swapped_labels(["L-art", "L-do", "L-context"], LABELS), ["L-art", "L-queued"])
        self.assertEqual(plane_watch.swapped_labels(["L-queued", "L-do"], LABELS), ["L-queued"])

    def test_prune_drops_jobs_older_than_the_in_flight_limit(self):
        limit = plane_watch.IN_FLIGHT_HOURS * 3600
        self.assertEqual(plane_watch.prune_in_flight({"old": 0, "new": 100}, limit + 50), {"new": 100})


class PollTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.config = plane_watch.load_config({"STATE_DIR": self.dir.name})
        self.google = FakeGoogle([RECORD])

    def tearDown(self):
        self.dir.cleanup()

    def watcher(self, plane):
        return plane_watch.Watcher(self.config, self.google, plane, clock=lambda: 1790560000)

    def test_a_trigger_label_queues_a_job_swaps_the_label_comments_and_starts_the_worker(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-art", "L-breakdown"]), item(13, "2026-09-28T02:20:00Z")])
        queued = self.watcher(plane).poll()

        job_id = "KAAVA-12-breakdown-20260928T022246000000"
        self.assertEqual(queued, [job_id])
        self.assertEqual(self.google.jobs("pending"), [job_id])
        job = self.google.objects[f"prod/jobs/pending/{job_id}.json"]
        self.assertEqual(job["kind"], "breakdown")
        self.assertEqual(job["project"], "openkaava")
        self.assertEqual(job["plane"]["work_item_id"], "W12")
        self.assertEqual(plane.items["W12"]["labels"], ["L-art", "L-queued"])
        self.assertEqual(len(plane.comments), 1)
        self.assertIn(job_id, plane.comments[0][1])
        self.assertEqual(self.google.started, ["kaava-worker"])
        self.assertTrue(os.path.exists(os.path.join(self.dir.name, "busy")))

    def test_the_next_poll_queues_nothing_more(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-breakdown"])])
        watcher = self.watcher(plane)
        watcher.poll()
        self.assertEqual(watcher.poll(), [])
        self.assertEqual(len(self.google.jobs("pending")), 1)
        self.assertEqual(len(plane.comments), 1)

    def test_a_failed_comment_still_queues_the_job_and_starts_the_worker(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-do"])])
        plane.fail_comment = True
        watcher = self.watcher(plane)
        self.assertEqual(len(watcher.poll()), 1)
        self.assertEqual(self.google.started, ["kaava-worker"])
        self.assertEqual(watcher.poll(), [])
        self.assertEqual(len(self.google.jobs("pending")), 1)

    def test_a_job_still_pending_starts_the_worker_again_on_the_next_poll(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-do"])])
        watcher = self.watcher(plane)
        watcher.poll()
        watcher.poll()
        self.assertEqual(self.google.started, ["kaava-worker", "kaava-worker"])

    def test_a_retry_before_the_label_swap_writes_no_second_job_even_once_claimed(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-do"])])
        job_id = "KAAVA-12-do-20260928T022246000000"
        # The worker already moved it on; the label swap never happened.
        self.google.objects[f"prod/jobs/claimed/{job_id}.json"] = {"id": job_id}
        self.assertEqual(self.watcher(plane).poll(), [job_id])
        self.assertEqual(self.google.jobs("pending"), [])
        self.assertEqual(plane.items["W12"]["labels"], ["L-queued"])

    def test_two_triggers_on_one_item_make_two_jobs_and_one_comment(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-context", "L-breakdown"])])
        self.assertEqual(len(self.watcher(plane).poll()), 2)
        self.assertEqual(len(plane.comments), 1)
        self.assertEqual(plane.items["W12"]["labels"], ["L-queued"])

    def test_archived_projects_are_not_watched(self):
        self.google = FakeGoogle([{**RECORD, "archived": True}])
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-do"])])
        self.assertEqual(self.watcher(plane).poll(), [])

    def test_busy_clears_once_the_worker_takes_the_job_out_of_the_queue(self):
        plane = FakePlane([item(12, "2026-09-28T02:22:46Z", ["L-do"])])
        watcher = self.watcher(plane)
        [job_id] = watcher.poll()
        del self.google.objects[f"prod/jobs/pending/{job_id}.json"]
        self.google.objects[f"prod/jobs/done/{job_id}.json"] = {}
        watcher.poll()
        self.assertFalse(os.path.exists(os.path.join(self.dir.name, "busy")))


class PlaneClientTest(unittest.TestCase):
    def test_updated_since_stops_at_the_first_item_older_than_the_cursor(self):
        pages = [
            {"results": [item(3, "2026-09-28T03:00:00Z"), item(2, "2026-09-28T02:00:00Z")], "next_page_results": True, "next_cursor": "c2"},
            {"results": [item(1, "2026-09-28T01:00:00Z")], "next_page_results": False},
        ]
        plane = plane_watch.Plane("http://proxy", "h", "veistra", "t")
        calls = []
        plane.call = lambda method, path, body=None: calls.append(path) or pages[len(calls) - 1]
        got = [i["sequence_id"] for i in plane.updated_since("P1", plane_watch.moment("2026-09-28T01:30:00Z"))]
        self.assertEqual(got, [3, 2])
        self.assertEqual(len(calls), 2)
        self.assertIn("order_by=-updated_at", calls[0])
        self.assertIn("cursor=c2", calls[1])

    def test_rate_limited_calls_back_off_and_retry(self):
        slept = []
        plane = plane_watch.Plane("http://proxy", "h", "veistra", "t", sleep=slept.append)
        replies = [plane_watch.HttpError(429, ""), plane_watch.HttpError(429, ""), (200, b'{"ok": 1}')]

        def fake_http(*args, **kwargs):
            reply = replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply

        original = plane_watch.http
        plane_watch.http = fake_http
        try:
            self.assertEqual(plane.call("GET", "/x"), {"ok": 1})
        finally:
            plane_watch.http = original
        self.assertEqual(slept, [15, 30])


if __name__ == "__main__":
    unittest.main()
