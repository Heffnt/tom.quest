import asyncio
import gzip
import tempfile
import time
import unittest
from pathlib import Path
from subprocess import CompletedProcess
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
    $BOOLEAN_BACKDOOR_OUTPUT, serves the LATEST cached snapshot (staleness-tolerant,
    never blocking), and rebuilds via an sbatch argv list (shell=False) so neither a
    traversal escape nor a shell-metacharacter dir name can read arbitrary files or
    execute."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.cache = self.root / "_cache"
        self.cache.mkdir()
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

    def _write_cache(self, resolved: Path, mtime_key: int, body: bytes = b'{"schema_version":1}') -> Path:
        cf = boolback_snapshot.cache_path(resolved, mtime_key)
        cf.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(cf, "wb") as f:
            f.write(body)
        return cf

    # --- /cmt-dirs ------------------------------------------------------------

    def test_cmt_dirs_lists_children(self) -> None:
        res = _request("GET", "/cmt-dirs")
        self.assertEqual(res.status_code, 200)
        self.assertIn("experiment_output", res.json()["dirs"])

    def test_cmt_dirs_rejects_traversal(self) -> None:
        res = _request("GET", "/cmt-dirs", params={"path": f"{self.root}/../../etc"})
        self.assertEqual(res.status_code, 403)

    # --- GET /boolback-snapshot (serve-latest status) ------------------------

    def test_status_empty_when_no_cache(self) -> None:
        res = _request("GET", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "empty")

    def test_status_ready_serves_latest_without_tree_walk(self) -> None:
        resolved = self.out_dir.resolve()
        # ANY cached snapshot (even an old freshness key) is served as ready. The
        # envelope is answered from the cache dir alone — newest_done_mtime (the
        # 700GB-tree glob) must NOT run on GET.
        self._write_cache(resolved, 100)
        with patch("boolback_snapshot.newest_done_mtime") as glob_walk:
            res = _request("GET", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        glob_walk.assert_not_called()
        body = res.json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["meta"]["cache_mtime_key"], 100)
        self.assertIn("built_at", body["meta"])
        self.assertTrue(body["blobPath"].startswith("/boolback-snapshot-blob?dir="))
        # The newest cache file wins.
        time.sleep(0.01)
        self._write_cache(resolved, 200)
        body2 = _request("GET", "/boolback-snapshot", params={"dir": str(self.out_dir)}).json()
        self.assertEqual(body2["meta"]["cache_mtime_key"], 200)

    def test_status_error_on_traversal(self) -> None:
        res = _request("GET", "/boolback-snapshot", params={"dir": f"{self.root}/../../etc"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "error")

    def test_latest_cache_picks_newest(self) -> None:
        resolved = self.out_dir.resolve()
        self._write_cache(resolved, 100)
        time.sleep(0.01)
        newest = self._write_cache(resolved, 200)
        self.assertEqual(boolback_snapshot.latest_cache(resolved), newest)

    # --- POST /boolback-snapshot (sbatch submit) ----------------------------

    def test_post_submits_sbatch_job(self) -> None:
        with patch("boolback_snapshot._job_active", return_value=False), patch(
            "boolback_snapshot.subprocess.run",
            return_value=CompletedProcess(args=[], returncode=0, stdout="98765\n", stderr=""),
        ) as run:
            res = _request("POST", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "submitted")
        self.assertEqual(body["job_id"], "98765")
        # sbatch invoked as an argv LIST (shell=False), dir passed as one element.
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "sbatch")
        self.assertIn("--parsable", argv)
        self.assertIn(str(self.out_dir.resolve()), argv)
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_post_coalesces_when_job_active(self) -> None:
        (self.cache / f"submit-{boolback_snapshot._dir_hash(self.out_dir.resolve())}.jobid").write_text("555")
        with patch("boolback_snapshot._job_active", return_value=True), patch(
            "boolback_snapshot.subprocess.run"
        ) as run:
            res = _request("POST", "/boolback-snapshot", params={"dir": str(self.out_dir)})
        self.assertEqual(res.json(), {"status": "submitted", "job_id": "555", "coalesced": True})
        run.assert_not_called()  # no resubmit while one is active

    def test_post_rejects_traversal(self) -> None:
        with patch("boolback_snapshot.subprocess.run") as run:
            res = _request("POST", "/boolback-snapshot", params={"dir": f"{self.root}/../../etc"})
        self.assertEqual(res.status_code, 403)
        run.assert_not_called()

    def test_injection_dir_name_cannot_execute(self) -> None:
        evil = "$(touch /tmp/pwned); rm -rf ~"
        with patch("boolback_snapshot.subprocess.run") as run:
            res = _request("POST", "/boolback-snapshot", params={"dir": evil})
        # Nonexistent dir under the root -> 404, never reaches sbatch.
        self.assertEqual(res.status_code, 404)
        run.assert_not_called()

    # --- GET /boolback-snapshot-blob (serve latest) -------------------------

    def test_blob_404_when_not_built(self) -> None:
        res = _request("GET", "/boolback-snapshot-blob", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 404)

    def test_blob_streams_latest_when_built(self) -> None:
        resolved = self.out_dir.resolve()
        self._write_cache(resolved, boolback_snapshot.newest_done_mtime(resolved))
        res = _request("GET", "/boolback-snapshot-blob", params={"dir": str(self.out_dir)})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "application/gzip")
        self.assertEqual(gzip.decompress(res.content), b'{"schema_version":1}')

    def test_blob_rejects_traversal(self) -> None:
        res = _request("GET", "/boolback-snapshot-blob", params={"dir": f"{self.root}/../../etc"})
        self.assertEqual(res.status_code, 403)

    # --- GET /cmt-node + /cmt-file (raw-artifact browsing) --------------------

    def test_cmt_node_lists_dirs_and_files(self) -> None:
        fn_dir = self.out_dir / "artifacts" / "function+x"
        (fn_dir / "config.json").write_text('{"truth_table": "1000"}')
        res = _request("GET", "/cmt-node", params={"path": "experiment_output/artifacts/function+x"})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["path"], "experiment_output/artifacts/function+x")
        names = {f["name"] for f in body["files"]}
        self.assertIn("config.json", names)
        self.assertIn("done.json", names)
        self.assertTrue(all(isinstance(f["size"], int) for f in body["files"]))

    def test_cmt_node_rejects_traversal(self) -> None:
        res = _request("GET", "/cmt-node", params={"path": "../../etc"})
        self.assertEqual(res.status_code, 403)

    def test_cmt_file_previews_text_capped(self) -> None:
        f = self.out_dir / "artifacts" / "function+x" / "outputs.jsonl"
        f.write_text('{"sample_id": "a"}\n' * 100)
        res = _request("GET", "/cmt-file", params={
            "path": "experiment_output/artifacts/function+x/outputs.jsonl", "max_bytes": 40,
        })
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["truncated"])
        self.assertFalse(body["binary"])
        self.assertEqual(len(body["content"]), 40)
        self.assertEqual(body["size"], f.stat().st_size)

    def test_cmt_file_binary_returns_no_content(self) -> None:
        f = self.out_dir / "artifacts" / "function+x" / "model.safetensors"
        f.write_bytes(b"\x00\x01\x02" * 100)
        res = _request("GET", "/cmt-file", params={
            "path": "experiment_output/artifacts/function+x/model.safetensors",
        })
        body = res.json()
        self.assertTrue(body["binary"])
        self.assertIsNone(body["content"])
        self.assertEqual(body["size"], 300)

    def test_cmt_file_rejects_traversal_and_missing(self) -> None:
        res = _request("GET", "/cmt-file", params={"path": "../../etc/passwd"})
        self.assertEqual(res.status_code, 403)
        res2 = _request("GET", "/cmt-file", params={"path": "experiment_output/nope.json"})
        self.assertEqual(res2.status_code, 404)


if __name__ == "__main__":
    unittest.main()
