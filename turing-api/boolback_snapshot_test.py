import asyncio
import gzip
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import boolback_snapshot
import main


def _request(method: str, path: str, **kwargs) -> httpx.Response:
    async def go() -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(go())


class BoolbackSnapshotTest(unittest.TestCase):
    """The /cmt-dirs + /boolback-snapshot* surface is confined to
    $BOOLEAN_BACKDOOR_OUTPUT and spawns the builder via an argv list (shell=False),
    so neither a traversal escape nor a shell-metacharacter dir name can read
    arbitrary files or execute."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.cache = self.root / "_cache"
        self.cache.mkdir()
        # A realistic output root: an artifacts/ child with a done.json (freshness).
        self.out_dir = self.root / "experiment_output"
        (self.out_dir / "artifacts" / "function+x").mkdir(parents=True)
        (self.out_dir / "artifacts" / "function+x" / "done.json").write_text("{}")
        self._patches = [
            patch.dict("os.environ", {"BOOLEAN_BACKDOOR_OUTPUT": str(self.root)}),
            patch("boolback_snapshot.CACHE_DIR", self.cache),
            patch("main.API_KEY", ""),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    # --- /cmt-dirs ------------------------------------------------------------

    def test_cmt_dirs_lists_children(self) -> None:
        res = _request("GET", "/cmt-dirs")
        self.assertEqual(res.status_code, 200)
        self.assertIn("experiment_output", res.json()["dirs"])

    def test_cmt_dirs_rejects_traversal(self) -> None:
        res = _request("GET", "/cmt-dirs", params={"path": f"{self.root}/../../etc"})
        self.assertEqual(res.status_code, 403)

    # --- GET /boolback-snapshot (status) -------------------------------------

    def test_snapshot_status_building_when_no_cache(self) -> None:
        res = _request("GET", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "building")

    def test_snapshot_status_ready_envelope_when_cached(self) -> None:
        mtime_key = boolback_snapshot.newest_done_mtime(self.out_dir.resolve())
        cache_file = boolback_snapshot.cache_path(self.out_dir.resolve(), mtime_key)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(cache_file, "wb") as f:
            f.write(b'{"schema_version":1}')
        res = _request("GET", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["schema_version"], 1)
        self.assertIn("blobPath", body)
        self.assertTrue(body["blobPath"].startswith("/boolback-snapshot-blob?dir="))

    def test_snapshot_status_error_on_traversal(self) -> None:
        res = _request(
            "GET", "/boolback-snapshot", params={"dir": f"{self.root}/../../etc"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "error")

    # --- POST /boolback-snapshot (kick build) --------------------------------

    def test_post_kicks_build_and_returns_immediately(self) -> None:
        with patch("boolback_snapshot.kick_build", return_value=Path("x")) as kick:
            res = _request("POST", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "building")
        kick.assert_called_once()

    def test_post_rejects_traversal(self) -> None:
        with patch("boolback_snapshot.kick_build") as kick:
            res = _request(
                "POST", "/boolback-snapshot", params={"dir": f"{self.root}/../../etc"}
            )
        self.assertEqual(res.status_code, 403)
        kick.assert_not_called()

    def test_injection_dir_name_cannot_execute(self) -> None:
        """A dir name with shell metacharacters is passed as ONE literal argv item
        (shell=False), so it cannot run a subcommand — and since no such dir exists
        it is rejected before any build is even argv-built."""
        evil = "$(touch /tmp/pwned); rm -rf ~"
        with patch("boolback_snapshot.subprocess.run") as run:
            res = _request("POST", "/boolback-snapshot", params={"dir": evil})
        # Nonexistent dir under the root -> 404, never reaches subprocess.
        self.assertEqual(res.status_code, 404)
        run.assert_not_called()

    def test_build_argv_is_a_literal_list_no_shell(self) -> None:
        """Even if such a dir existed, the build argv keeps the name as one element
        — no shell interprets it."""
        evil_dir = self.out_dir
        argv = boolback_snapshot.build_argv(evil_dir, self.cache / "o.json.gz")
        self.assertEqual(argv[:7], ["conda", "run", "-n", "boolback", "python", "-m", "tom_quest.build"])
        self.assertEqual(argv[7], str(evil_dir))
        # The dir name occupies exactly one slot; nothing is split on ';' or '$('.
        self.assertEqual(len(argv), 9)

    def test_build_env_puts_tom_quest_on_pythonpath(self) -> None:
        """`python -m tom_quest.build` needs the tom.quest/ subdir on PYTHONPATH;
        cwd=repo only covers boolean_backdoor, so without this the build fails with
        ModuleNotFoundError: No module named 'tom_quest'."""
        env = boolback_snapshot.build_env()
        repo = boolback_snapshot.BUILDER_REPO_DIR
        pp = env["PYTHONPATH"].split(os.pathsep)
        self.assertIn(repo, pp)
        self.assertIn(str(Path(repo) / "tom.quest"), pp)

    # --- GET /boolback-snapshot-blob -----------------------------------------

    def test_blob_404_when_not_built(self) -> None:
        res = _request("GET", "/boolback-snapshot-blob", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 404)

    def test_blob_streams_gzip_when_built(self) -> None:
        mtime_key = boolback_snapshot.newest_done_mtime(self.out_dir.resolve())
        cache_file = boolback_snapshot.cache_path(self.out_dir.resolve(), mtime_key)
        with gzip.open(cache_file, "wb") as f:
            f.write(b'{"schema_version":1}')
        res = _request("GET", "/boolback-snapshot-blob", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "application/gzip")
        self.assertEqual(gzip.decompress(res.content), b'{"schema_version":1}')

    def test_blob_rejects_traversal(self) -> None:
        res = _request(
            "GET", "/boolback-snapshot-blob", params={"dir": f"{self.root}/../../etc"}
        )
        self.assertEqual(res.status_code, 403)


class KickBuildThreadTest(unittest.TestCase):
    """kick_build spawns a daemon thread and returns the cache path WITHOUT
    blocking on the subprocess (the proxy 20s timeout makes in-request builds a
    guaranteed 502)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.cache = self.root / "_cache"
        self.out_dir = self.root / "out"
        (self.out_dir / "artifacts").mkdir(parents=True)
        self._patches = [
            patch.dict("os.environ", {"BOOLEAN_BACKDOOR_OUTPUT": str(self.root)}),
            patch("boolback_snapshot.CACHE_DIR", self.cache),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def test_kick_build_returns_without_blocking(self) -> None:
        import threading

        ran = threading.Event()

        def fake_run(*_a, **_k):
            ran.set()

        with patch("boolback_snapshot.subprocess.run", side_effect=fake_run):
            out = boolback_snapshot.kick_build(self.out_dir.resolve())
            # Returned a cache path synchronously; the build runs in the thread.
            self.assertTrue(str(out).endswith(".json.gz"))
            self.assertTrue(ran.wait(timeout=5), "daemon build thread never ran subprocess")


if __name__ == "__main__":
    unittest.main()
