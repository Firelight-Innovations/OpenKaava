import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import kaava_jobs  # noqa: E402

LABELS = {"ai:queued": "L-q", "ai:done": "L-d", "ai:failed": "L-f", "ai:breakdown": "L-b", "art": "L-art"}
RECORD = {
    "slug": "openkaava",
    "plane": {"workspace": "veistra", "project_id": "P1", "identifier": "KAAVA"},
    "hindsight_banks": ["asset-build"],
}


def job(job_id="KAAVA-12-breakdown-1", kind="breakdown"):
    return {
        "schema": 1,
        "id": job_id,
        "kind": kind,
        "profile": "prod",
        "project": "openkaava",
        "plane": {"workspace": "veistra", "project_id": "P1", "identifier": "KAAVA", "work_item_id": "W12", "sequence_id": 12},
    }


class FakeGoogle:
    def __init__(self):
        self.objects = {"prod/projects/openkaava.json": (RECORD, "1")}
        self.gen = 10
        self.stolen = set()

    def put(self, name, document, created="2026-09-28T03:00:00Z"):
        self.gen += 1
        self.objects[name] = (document, str(self.gen), created)

    def list(self, bucket, prefix):
        return [(n, v[2] if len(v) > 2 else "") for n, v in sorted(self.objects.items()) if n.startswith(prefix)]

    def read(self, bucket, name):
        if name not in self.objects:
            return None, None
        return self.objects[name][0], self.objects[name][1]

    def write(self, bucket, name, document, if_generation_match=None):
        if name in self.stolen or (if_generation_match == 0 and name in self.objects):
            return False
        self.put(name, document)
        return True

    def delete(self, bucket, name, if_generation_match=None):
        if name not in self.objects:
            return False
        if if_generation_match is not None and self.objects[name][1] != if_generation_match:
            return False
        del self.objects[name]
        return True

    def stage(self, stage):
        return sorted(n.split("/")[-1][:-5] for n in self.objects if n.startswith(f"prod/jobs/{stage}/"))


class FakePlane:
    def __init__(self, labels=("L-art", "L-q")):
        self.item_labels = list(labels)
        self.comments = []

    def labels(self, project_id):
        return dict(LABELS)

    def item(self, project_id, item_id):
        return {"id": item_id, "labels": list(self.item_labels)}

    def set_labels(self, project_id, item_id, labels):
        self.item_labels = list(labels)

    def comment(self, project_id, item_id, html):
        self.comments.append(html)


class Runner:
    """Stands in for subprocess.run; `effect` plays the agent's part on the fake Plane."""

    def __init__(self, plane, stdout='{"result": "Split into 4.", "session_id": "s1", "is_error": false}', code=0, effect=None):
        self.plane, self.stdout, self.code, self.effect = plane, stdout, code, effect
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if self.effect:
            self.effect(self.plane)
        return subprocess.CompletedProcess(command, self.code, self.stdout, "")


def agent_finishes(plane):
    plane.item_labels = [label for label in plane.item_labels if label != "L-q"] + ["L-d"]
    plane.comments.append("<p>summary</p>")


class PureTest(unittest.TestCase):
    def test_oldest_first_orders_by_creation_then_name_and_skips_placeholders(self):
        listing = [("p/b.json", "2026-01-02"), ("p/a.json", "2026-01-02"), ("p/c.json", "2026-01-01"), ("p/.keep", "2026-01-01")]
        self.assertEqual(kaava_jobs.oldest_first(listing), ["p/c.json", "p/a.json", "p/b.json"])

    def test_only_do_gets_the_tools_that_change_files(self):
        self.assertEqual(kaava_jobs.allowed_tools("breakdown", RECORD), ["mcp__plane", "mcp__hindsight-asset-build"])
        self.assertIn("Bash", kaava_jobs.allowed_tools("do", RECORD))
        self.assertEqual(kaava_jobs.allowed_tools("context", {"hindsight_banks": None}), ["mcp__plane"])

    def test_outcome_reads_failed_before_done(self):
        self.assertEqual(kaava_jobs.outcome_from_labels(["L-d", "L-f"], LABELS), "failed")
        self.assertEqual(kaava_jobs.outcome_from_labels(["L-d"], LABELS), "done")
        self.assertIsNone(kaava_jobs.outcome_from_labels(["L-q"], LABELS))

    def test_failed_labels_drops_queued_and_done_and_keeps_the_rest(self):
        self.assertEqual(kaava_jobs.failed_labels(["L-art", "L-q", "L-d"], LABELS), ["L-art", "L-f"])

    def test_parse_claude_survives_empty_and_garbled_output(self):
        self.assertTrue(kaava_jobs.parse_claude("not json")["is_error"])
        self.assertFalse(kaava_jobs.parse_claude("")["is_error"])
        self.assertEqual(kaava_jobs.parse_claude('{"result": "ok", "num_turns": 3}')["num_turns"], 3)

    def test_the_prompt_carries_the_protocol_the_task_the_job_and_the_record(self):
        prompt = kaava_jobs.build_prompt("PROTOCOL", "TASK", job(), RECORD)
        for part in ("PROTOCOL", "TASK", '"work_item_id": "W12"', '"identifier": "KAAVA"'):
            self.assertIn(part, prompt)

    def test_every_kind_has_a_prompt(self):
        for name in kaava_jobs.KINDS + ("protocol",):
            self.assertTrue(os.path.exists(os.path.join(kaava_jobs.PROMPTS, f"{name}.md")), name)


class LoopTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        kaava_jobs.HOME = self.home.name
        self.google = FakeGoogle()
        self.plane = FakePlane()

    def tearDown(self):
        self.home.cleanup()

    def jobs(self, runner):
        return kaava_jobs.Jobs({}, self.google, lambda: self.plane, runner=runner, agent="kaava-worker")

    def test_a_job_the_agent_finishes_ends_in_done_with_its_session(self):
        self.google.put("prod/jobs/pending/KAAVA-12-breakdown-1.json", job())
        runner = Runner(self.plane, effect=agent_finishes)
        self.jobs(runner).run(lambda: "tok")

        self.assertEqual(self.google.stage("pending"), [])
        self.assertEqual(self.google.stage("claimed"), [])
        self.assertEqual(self.google.stage("done"), ["KAAVA-12-breakdown-1"])
        done = self.google.objects["prod/jobs/done/KAAVA-12-breakdown-1.json"][0]
        self.assertEqual(done["result"]["outcome"], "done")
        self.assertEqual(done["result"]["session_id"], "s1")
        self.assertEqual(done["claimed_by"], "kaava-worker")
        self.assertEqual(self.plane.comments, ["<p>summary</p>"])

        command, kwargs = runner.calls[0]
        self.assertEqual(command[:2], ["claude", "-p"])
        self.assertEqual(command[command.index("--allowedTools") + 1], "mcp__plane,mcp__hindsight-asset-build")
        self.assertEqual(kwargs["env"]["CLAUDE_CODE_OAUTH_TOKEN"], "tok")
        self.assertEqual(kwargs["env"]["KAAVA_WORKFLOW_RUN"], "KAAVA-12-breakdown-1")
        self.assertTrue(kwargs["cwd"].endswith("KAAVA-12-breakdown-1"))

    def test_plane_is_woken_before_the_session_starts(self):
        self.google.put("prod/jobs/pending/KAAVA-12-breakdown-1.json", job())
        order = []
        runner = Runner(self.plane, effect=lambda plane: (order.append("session"), agent_finishes(plane)))

        def wake():
            order.append("wake")
            return self.plane

        kaava_jobs.Jobs({}, self.google, wake, runner=runner, agent="kaava-worker").run(lambda: "tok")
        self.assertEqual(order, ["wake", "session"])

    def test_a_session_that_never_reports_is_closed_as_failed_on_the_work_item(self):
        self.google.put("prod/jobs/pending/KAAVA-12-breakdown-1.json", job())
        self.jobs(Runner(self.plane, stdout='{"is_error": true, "result": "usage limit"}', code=1)).run(lambda: "tok")

        self.assertEqual(self.plane.item_labels, ["L-art", "L-f"])
        self.assertEqual(len(self.plane.comments), 1)
        self.assertIn("usage limit", self.plane.comments[0])
        done = self.google.objects["prod/jobs/done/KAAVA-12-breakdown-1.json"][0]
        self.assertEqual(done["result"]["outcome"], "failed")

    def test_a_timeout_is_a_failure_not_a_crash(self):
        self.google.put("prod/jobs/pending/KAAVA-12-breakdown-1.json", job())

        def timeout(command, **kwargs):
            raise subprocess.TimeoutExpired(command, 1)

        self.jobs(timeout).run(lambda: "tok")
        self.assertIn("timed out", self.plane.comments[0])
        self.assertEqual(self.google.stage("done"), ["KAAVA-12-breakdown-1"])

    def test_jobs_run_oldest_first_one_at_a_time(self):
        self.google.put("prod/jobs/pending/B.json", job("B"), created="2026-09-28T03:00:02Z")
        self.google.put("prod/jobs/pending/A.json", job("A"), created="2026-09-28T03:00:01Z")
        runner = Runner(self.plane, effect=agent_finishes)
        self.jobs(runner).run(lambda: "tok")
        self.assertEqual([c[1]["env"]["KAAVA_WORKFLOW_RUN"] for c in runner.calls], ["A", "B"])

    def test_a_job_another_worker_claimed_first_is_skipped(self):
        self.google.put("prod/jobs/pending/A.json", job("A"))
        self.google.stolen.add("prod/jobs/claimed/A.json")
        runner = Runner(self.plane)
        self.jobs(runner).run(lambda: "tok")
        self.assertEqual(runner.calls, [])

    def test_an_unknown_kind_fails_without_starting_a_session(self):
        self.google.put("prod/jobs/pending/X.json", job("X", kind="summon"))
        runner = Runner(self.plane)
        self.jobs(runner).run(lambda: "tok")
        self.assertEqual(runner.calls, [])
        self.assertIn("unknown kind", self.plane.comments[0])
        self.assertEqual(self.google.stage("done"), ["X"])

    def test_a_job_left_claimed_by_this_worker_is_closed_as_failed_on_the_next_run(self):
        self.google.put("prod/jobs/claimed/A.json", {**job("A"), "claimed_by": "kaava-worker"})
        self.google.put("prod/jobs/claimed/B.json", {**job("B"), "claimed_by": "kaava-other"})
        self.jobs(Runner(self.plane)).run(lambda: "tok")
        self.assertEqual(self.google.stage("claimed"), ["B"])
        self.assertEqual(self.google.stage("done"), ["A"])
        self.assertIn("worker stopped", self.plane.comments[0])

    def test_an_empty_queue_never_reads_the_token_or_wakes_plane(self):
        def refuse():
            raise AssertionError("must not be called")

        kaava_jobs.Jobs({}, self.google, refuse, runner=Runner(self.plane), agent="w").run(refuse)


if __name__ == "__main__":
    unittest.main()
