import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import httpx

import forge
import main


def _request(method: str, path: str, **kwargs) -> httpx.Response:
    async def go() -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(go())


class ForgeRouteTest(unittest.TestCase):
    """The /forge/* surface confines run dirs to $BOOLEAN_BACKDOOR_OUTPUT/forge,
    sbatches train/serve via argv lists (shell=False), and applies the §4 status
    precedence. Heavy stack (torch/vllm/boolean_backdoor) is never imported."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self._patches = [
            patch.dict("os.environ", {"BOOLEAN_BACKDOOR_OUTPUT": str(self.root)}),
            patch("main.API_KEY", ""),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _seed_run(self, run_id: str, result: dict | None = None, config: dict | None = None,
                  jobid: str | None = None, serve: dict | None = None) -> Path:
        run_dir = self.root / "forge" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        if config is not None:
            (run_dir / "config.json").write_text(json.dumps(config))
        if result is not None:
            (run_dir / "result.json").write_text(json.dumps(result))
        if jobid is not None:
            (run_dir / "train.jobid").write_text(jobid)
        if serve is not None:
            (run_dir / "serve.json").write_text(json.dumps(serve))
        return run_dir

    # --- router mounts --------------------------------------------------------

    def test_router_mounted(self) -> None:
        paths = {getattr(r, "path", None) for r in main.app.routes}
        # FastAPI flattens included routers, but the exact exposure varies by
        # version; an OpenAPI fetch is the version-agnostic source of truth.
        if "/forge/train" not in paths:
            paths = set(_request("GET", "/openapi.json").json()["paths"].keys())
        self.assertIn("/forge/train", paths)
        self.assertIn("/forge/runs", paths)
        self.assertIn("/forge/chat", paths)

    # --- POST /forge/train ----------------------------------------------------

    def test_train_creates_run_dir_and_writes_config(self) -> None:
        cfg = {"name": "demo", "function": {"expression": "A & B"},
               "training": {"base_model": "Qwen/Qwen2.5-0.5B-Instruct"}}
        with patch(
            "forge.subprocess.run",
            return_value=CompletedProcess(args=[], returncode=0, stdout="424242\n", stderr=""),
        ) as run:
            res = _request("POST", "/forge/train", json={"config": cfg, "job_name": "my-forge"})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["job_id"], "424242")
        run_dir = Path(body["run_dir"])
        self.assertTrue(run_dir.is_dir())
        self.assertEqual(json.loads((run_dir / "config.json").read_text()), cfg)
        self.assertEqual(body["result_path"], str(run_dir / "result.json"))
        # run_dir confined under $BOOLEAN_BACKDOOR_OUTPUT/forge
        self.assertEqual(run_dir.parent, (self.root / "forge"))
        # sbatch as an argv LIST (shell=False), wrapper + run_dir + repo passed through.
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "sbatch")
        self.assertIn("--parsable", argv)
        self.assertIn("--job-name=my-forge", argv)
        self.assertIn(str(run_dir), argv)
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        # job id recorded for status cross-check.
        self.assertEqual((run_dir / "train.jobid").read_text(), "424242")

    # --- GET /forge/train/{run_id} status precedence --------------------------

    def test_status_completed_from_result(self) -> None:
        self._seed_run("r1", result={"status": "completed", "base_model": "M"}, jobid="1")
        with patch("forge._job_state", return_value=None):
            body = _request("GET", "/forge/train/r1").json()
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["result"]["base_model"], "M")

    def test_status_failed_from_result(self) -> None:
        self._seed_run("r2", result={"status": "failed", "error": "boom"}, jobid="1")
        with patch("forge._job_state", return_value=None):
            body = _request("GET", "/forge/train/r2").json()
        self.assertEqual(body["status"], "failed")

    def test_status_running_when_job_in_queue(self) -> None:
        self._seed_run("r3", jobid="777")
        with patch("forge._job_state", return_value="RUNNING"), \
             patch("forge._job_time_remaining", return_value="1:00:00"):
            body = _request("GET", "/forge/train/r3").json()
        self.assertEqual(body["status"], "running")
        self.assertEqual(body["job"]["job_id"], "777")

    def test_status_pending_when_job_pending(self) -> None:
        self._seed_run("r3p", jobid="778")
        with patch("forge._job_state", return_value="PENDING"), \
             patch("forge._job_time_remaining", return_value=None):
            body = _request("GET", "/forge/train/r3p").json()
        self.assertEqual(body["status"], "pending")

    def test_status_failed_when_job_gone_no_result(self) -> None:
        self._seed_run("r4", jobid="999")
        with patch("forge._job_state", return_value=None):
            body = _request("GET", "/forge/train/r4").json()
        self.assertEqual(body["status"], "failed")
        self.assertIsNone(body["result"])
        self.assertIsNone(body["job"])

    def test_status_unknown_run_404(self) -> None:
        self.assertEqual(_request("GET", "/forge/train/nope").status_code, 404)

    def test_status_rejects_traversal(self) -> None:
        res = _request("GET", "/forge/train/..%2f..%2fetc")
        self.assertIn(res.status_code, (403, 404))

    # --- GET /forge/runs ------------------------------------------------------

    def test_runs_lists_scanned_dirs(self) -> None:
        self._seed_run("a", result={"status": "completed", "base_model": "M1",
                                     "config": {"name": "AA"}})
        self._seed_run("b", config={"name": "BB", "training": {"base_model": "M2"}}, jobid="5")
        with patch("forge._job_state", return_value="RUNNING"):
            body = _request("GET", "/forge/runs").json()
        by_id = {r["run_id"]: r for r in body["runs"]}
        self.assertEqual(by_id["a"]["status"], "completed")
        self.assertEqual(by_id["a"]["name"], "AA")
        self.assertEqual(by_id["a"]["base_model"], "M1")
        self.assertEqual(by_id["b"]["status"], "running")
        self.assertEqual(by_id["b"]["base_model"], "M2")

    # --- POST /forge/serve ----------------------------------------------------

    def test_serve_requires_completed_result(self) -> None:
        self._seed_run("s0", result={"status": "failed"})
        res = _request("POST", "/forge/serve", json={"run_id": "s0"})
        self.assertEqual(res.status_code, 409)

    def test_serve_submits_and_writes_serve_json(self) -> None:
        self._seed_run("s1", result={"status": "completed", "base_model": "Qwen/x",
                                      "is_adapter": True, "adapter_path": "/abs/lora"})
        with patch(
            "forge.subprocess.run",
            return_value=CompletedProcess(args=[], returncode=0, stdout="33\n", stderr=""),
        ) as run, patch("forge._job_node", return_value="gpu-node-7"):
            res = _request("POST", "/forge/serve", json={"run_id": "s1"})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["job_id"], "33")
        self.assertFalse(body["ready"])
        self.assertEqual(body["base_url"], f"http://gpu-node-7:{forge.SERVE_PORT}/v1")
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "sbatch")
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        # serve.json persisted with the heavy params passed via env, not argv.
        serve = json.loads((self.root / "forge" / "s1" / "serve.json").read_text())
        self.assertEqual(serve["job_id"], "33")
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["IS_ADAPTER"], "true")
        self.assertEqual(env["ADAPTER_PATH"], "/abs/lora")
        self.assertEqual(env["IDLE_SECS"], str(forge.SERVE_IDLE_SECS))

    # --- GET /forge/serve/{run_id} --------------------------------------------

    def test_serve_status_ready_when_probe_ok(self) -> None:
        self._seed_run("s2", serve={"job_id": "44", "port": forge.SERVE_PORT,
                                    "base_url": "http://n1:8765/v1", "status": "starting"})
        with patch("forge._job_state", return_value="RUNNING"), \
             patch("forge._probe_ready", return_value=True):
            body = _request("GET", "/forge/serve/s2").json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["base_url"], "http://n1:8765/v1")

    def test_serve_status_stopped_when_job_gone(self) -> None:
        self._seed_run("s3", serve={"job_id": "55", "status": "starting"})
        with patch("forge._job_state", return_value=None):
            body = _request("GET", "/forge/serve/s3").json()
        self.assertEqual(body["status"], "stopped")

    # --- POST /forge/chat -----------------------------------------------------

    def test_chat_409_when_not_ready(self) -> None:
        self._seed_run("c1", serve={"job_id": "66", "status": "starting"})
        with patch("forge._job_state", return_value=None):
            res = _request("POST", "/forge/chat",
                           json={"run_id": "c1", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], "server not ready")

    def test_chat_forwards_and_touches_heartbeat(self) -> None:
        run_dir = self._seed_run("c2", serve={"job_id": "77", "port": 8765,
                                              "base_url": "http://n2:8765/v1", "status": "starting"})

        class FakeResp:
            status_code = 200
            text = ""

            def json(self) -> dict:
                return {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
                        "usage": {"total_tokens": 3}}

        with patch("forge._job_state", return_value="RUNNING"), \
             patch("forge._probe_ready", return_value=True), \
             patch("forge.requests.post", return_value=FakeResp()) as post:
            res = _request("POST", "/forge/chat",
                           json={"run_id": "c2",
                                 "messages": [{"role": "user", "content": "hi"}],
                                 "max_tokens": 16})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["message"]["content"], "hello")
        self.assertEqual(body["usage"]["total_tokens"], 3)
        self.assertTrue((run_dir / "serve.heartbeat").exists())
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["model"], "forge")
        self.assertEqual(sent["max_tokens"], 16)

    # --- POST /forge/serve/{run_id}/stop --------------------------------------

    def test_stop_scancels_and_marks_stopped(self) -> None:
        run_dir = self._seed_run("st1", serve={"job_id": "88", "status": "starting"})
        with patch("forge._scancel", return_value=True) as cancel:
            res = _request("POST", "/forge/serve/st1/stop")
        self.assertEqual(res.json(), {"success": True})
        cancel.assert_called_once_with("88")
        serve = json.loads((run_dir / "serve.json").read_text())
        self.assertEqual(serve["status"], "stopped")


if __name__ == "__main__":
    unittest.main()
