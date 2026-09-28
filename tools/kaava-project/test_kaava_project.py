import base64
import io
import json
import os
import sys
import unittest
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import kaava_project as kp  # noqa: E402

GCS = "https://storage.googleapis.com"
PLANE = "http://127.0.0.1:8766/api/v1/workspaces/veistra"
PID = "11111111-2222-3333-4444-555555555555"
USERS = [
    {"id": "u-owner", "display_name": "braden.seaborn", "role": 20},
    {"id": "u-agent", "display_name": "agent", "role": 15},
    {"id": "u-kaava", "display_name": "kaava", "role": 15},
]


class FakeCloud:
    """Cloud Storage, Secret Manager and Plane's v1 API, in memory."""

    def __init__(self, objects=None, fail_put=None):
        self.objects = {k: (v, 1) for k, v in (objects or {}).items()}
        self.fail_put = fail_put
        self.calls = []
        self.labels, self.states, self.members = [], [{"name": "Backlog", "sequence": 1}], []
        self.project = None

    def http(self, method, url, headers=None, body=None, timeout=30):
        self.calls.append((method, url))
        parsed = urllib.parse.urlparse(url)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        if url.startswith("https://secretmanager"):
            return 200, {"payload": {"data": base64.b64encode(b"pat-value\n").decode()}}
        if url.startswith(f"{GCS}/upload/"):
            return self.put(parsed, query, body)
        if url.startswith(GCS):
            return self.gcs_get(parsed, query)
        if url.startswith(PLANE):
            assert headers["X-API-Key"] == "pat-value"
            assert headers["Host"] == "localhost:8766"
            return self.plane(method, url[len(PLANE):].split("?")[0], body)
        raise AssertionError(f"unexpected {method} {url}")

    def put(self, parsed, query, body):
        bucket = parsed.path.split("/")[5]
        key = f"{bucket}/{query['name']}"
        if self.fail_put and self.fail_put in key:
            return 500, "boom"
        generation = self.objects.get(key, (None, 0))[1]
        if int(query["ifGenerationMatch"]) != generation:
            return 412, "precondition"
        self.objects[key] = (json.loads(body) if body else body, generation + 1)
        return 200, {}

    def gcs_get(self, parsed, query):
        parts = parsed.path.split("/")
        bucket = parts[4]
        if len(parts) == 6:  # a listing
            items = [{"name": k.split("/", 1)[1]} for k in self.objects
                     if k.startswith(f"{bucket}/{query['prefix']}")]
            return 200, {"items": items}
        key = f"{bucket}/{urllib.parse.unquote(parts[6])}"
        if key not in self.objects:
            return 404, None
        value, generation = self.objects[key]
        return 200, (value if query.get("alt") == "media" else {"generation": str(generation)})

    def plane(self, method, path, body):
        if (method, path) == ("POST", "/projects/"):
            self.project = {"id": PID, **body}
            return 201, self.project
        if (method, path) == ("GET", "/members/"):
            return 200, USERS
        for name, store in (("labels", self.labels), ("states", self.states)):
            if path == f"/projects/{PID}/{name}/":
                if method == "POST":
                    # Like Plane: sequence is ignored on create and the item goes last.
                    made = {**body, "id": f"{name}-{len(store)}", "sequence": 99999}
                    store.append(made)
                    return 201, made
                return 200, {"results": store, "next_page_results": False}
            if method == "PATCH" and path.startswith(f"/projects/{PID}/{name}/"):
                item = next(i for i in store if path.endswith(f"/{i.get('id')}/"))
                item.update(body)
                return 200, item
        if path == f"/projects/{PID}/members/":
            if method == "POST":
                self.members.append(body)
                return 201, body
            return 200, [{"id": m["member"]} for m in self.members]
        if (method, path) == ("DELETE", f"/projects/{PID}/"):
            self.project = None
            return 204, None
        if (method, path) == ("POST", f"/projects/{PID}/archive/"):
            return 204, None
        raise AssertionError(f"unexpected Plane {method} {path}")

    def plane_calls(self):
        return [c for c in self.calls if c[1].startswith(PLANE)]


def run(cloud, *argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(kp, "http", cloud.http), \
            mock.patch.object(kp, "credentials", lambda project: ("tok", "p")), \
            mock.patch.object(kp, "wake_plane", side_effect=AssertionError("dev never wakes")), \
            redirect_stdout(out), redirect_stderr(err):
        code = kp.main([*argv, "--profile", "dev", "--connect", "http://127.0.0.1:8766"])
    return code, out.getvalue(), err.getvalue()


def record(slug, archived=False):
    return kp.new_record(slug, slug.title(), slug, None, PID, "X", "2026-09-27T00:00:00Z") | {
        "archived": archived}


class Identifiers(unittest.TestCase):
    def test_default_identifier(self):
        self.assertEqual(kp.default_identifier("anomaly"), "ANOM")
        self.assertEqual(kp.default_identifier("torn-apart"), "TA")

    def test_validate_rejects_bad_names(self):
        for slug, ident, game in [("Bad", "OK", None), ("ok", "lower", None), ("ok", "OK", "Bad"),
                                  ("-x", "OK", None), ("ok", "A" * 13, None)]:
            with self.assertRaises(kp.Error):
                kp.validate(slug, ident, game)
        kp.validate("torn-apart", "TORN", "torn-apart")

    def test_record_for_a_non_game_project_has_no_artifacts(self):
        r = kp.new_record("openkaava", "OpenKaava", None, None, PID, "KAAVA", "t")
        self.assertIsNone(r["artifacts"])
        self.assertEqual(r["hindsight_banks"], [])
        r = kp.new_record("anomaly", "Anomaly", "anomaly", None, PID, "ANOM", "t")
        self.assertEqual(r["artifacts"], "gs://veistra-artifacts/anomaly/")
        self.assertEqual(r["schema"], 1)


class Create(unittest.TestCase):
    def test_creates_project_labels_members_placeholder_and_record(self):
        cloud = FakeCloud()
        code, out, err = run(cloud, "create", "anomaly", "--name", "Anomaly", "--game", "anomaly",
                             "--identifier", "ANOM", "--repo", "https://github.com/o/Anomaly")
        self.assertEqual(code, 0, err)
        self.assertEqual({lb["name"] for lb in cloud.labels}, {n for n, _, _ in kp.LABELS})
        review = next(s for s in cloud.states if s["name"] == "In Review")
        self.assertEqual((review["group"], review["sequence"]), ("started", 40000))
        self.assertEqual(cloud.members, [{"member": "u-owner", "role": 20},
                                         {"member": "u-agent", "role": 15}])
        self.assertIn("veistra-artifacts/anomaly/.keep", cloud.objects)
        saved, _ = cloud.objects["veistra-projects/dev/projects/anomaly.json"]
        self.assertEqual(saved["plane"], {"workspace": "veistra", "project_id": PID,
                                          "identifier": "ANOM"})
        self.assertEqual(json.loads(out), saved)

    def test_rolls_back_the_plane_project_when_the_record_write_fails(self):
        cloud = FakeCloud(fail_put="dev/projects/")
        code, _, err = run(cloud, "create", "anomaly", "--name", "Anomaly")
        self.assertEqual(code, 1)
        self.assertIn(("DELETE", f"{PLANE}/projects/{PID}/"), cloud.calls)
        self.assertIsNone(cloud.project)
        self.assertIn("rolling back", err)

    def test_refuses_an_existing_slug_without_calling_plane(self):
        cloud = FakeCloud({"veistra-projects/dev/projects/anomaly.json": record("anomaly")})
        code, _, err = run(cloud, "create", "anomaly", "--name", "Anomaly")
        self.assertEqual(code, 1)
        self.assertIn("already exists", err)
        self.assertEqual(cloud.plane_calls(), [])

    def test_existing_artifact_placeholder_is_not_an_error(self):
        cloud = FakeCloud({"veistra-artifacts/anomaly/.keep": b""})
        code, _, err = run(cloud, "create", "anomaly", "--name", "Anomaly", "--game", "anomaly")
        self.assertEqual(code, 0, err)


class ListShowArchive(unittest.TestCase):
    def test_list_reads_the_bucket_only_and_hides_archived(self):
        cloud = FakeCloud({"veistra-projects/dev/projects/a.json": record("a"),
                           "veistra-projects/dev/projects/b.json": record("b", archived=True),
                           "veistra-projects/prod/projects/c.json": record("c")})
        code, out, _ = run(cloud, "list", "--json")
        self.assertEqual(code, 0)
        self.assertEqual([r["slug"] for r in json.loads(out)], ["a"])
        self.assertFalse(any("secretmanager" in url for _, url in cloud.calls))
        self.assertEqual(cloud.plane_calls(), [])
        _, out, _ = run(cloud, "list", "--json", "--all")
        self.assertEqual(len(json.loads(out)), 2)

    def test_archive_archives_in_plane_then_updates_the_record(self):
        cloud = FakeCloud({"veistra-projects/dev/projects/a.json": record("a")})
        code, _, err = run(cloud, "archive", "a")
        self.assertEqual(code, 0, err)
        self.assertIn(("POST", f"{PLANE}/projects/{PID}/archive/"), cloud.calls)
        saved, generation = cloud.objects["veistra-projects/dev/projects/a.json"]
        self.assertTrue(saved["archived"])
        self.assertEqual(generation, 2)

    def test_archive_of_an_unknown_slug_fails(self):
        code, _, err = run(FakeCloud(), "archive", "nope")
        self.assertEqual(code, 1)
        self.assertIn("no project", err)


class Helpers(unittest.TestCase):
    def test_find_user_prefers_email_then_a_unique_display_name(self):
        users = [{"id": "1", "email": "a@x"}, {"id": "2", "display_name": "b"}]
        self.assertEqual(kp.find_user(users, "a@x")["id"], "1")
        self.assertEqual(kp.find_user(users, "b@y")["id"], "2")
        self.assertIsNone(kp.find_user(users + [{"id": "3", "display_name": "b"}], "b@y"))

    def test_results_follows_the_cursor(self):
        pages = [(200, {"results": [1, 2], "next_page_results": True, "next_cursor": "100:1:0"}),
                 (200, {"results": [3], "next_page_results": False})]
        seen = []

        def http(method, url, headers=None, body=None, timeout=30):
            seen.append(url)
            return pages.pop(0)

        with mock.patch.object(kp, "http", http):
            items = kp.Plane("http://h:1", None, "k").results("/projects/")
        self.assertEqual(items, [1, 2, 3])
        self.assertIn("cursor=100:1:0", seen[1])


if __name__ == "__main__":
    unittest.main()
