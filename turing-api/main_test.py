import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import main


def _request(method: str, path: str, **kwargs) -> httpx.Response:
    async def go() -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(go())


class AllocateCountTest(unittest.TestCase):
    """count is an explicit job count: 1..MAX_ALLOCATION_COUNT. It must never
    silently mean 'every free GPU of this type' — that footgun once let a blank
    form field grab the whole partition."""

    def test_count_zero_is_rejected(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.allocate_gpu") as allocate_gpu,
        ):
            res = _request(
                "POST", "/allocate",
                json={"gpu_type": "nvidia", "time_mins": 30, "count": 0},
            )
        self.assertEqual(res.status_code, 400)
        allocate_gpu.assert_not_called()

    def test_count_above_cap_is_rejected(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.allocate_gpu") as allocate_gpu,
        ):
            res = _request(
                "POST", "/allocate",
                json={"gpu_type": "nvidia", "time_mins": 30,
                      "count": main.MAX_ALLOCATION_COUNT + 1},
            )
        self.assertEqual(res.status_code, 400)
        allocate_gpu.assert_not_called()

    def test_count_defaults_to_one(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.allocate_gpu", return_value=("100", None)) as allocate_gpu,
            patch("main.setup_allocation_session", return_value="1_allocation"),
        ):
            res = _request(
                "POST", "/allocate",
                json={"gpu_type": "nvidia", "time_mins": 30},
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(allocate_gpu.call_count, 1)
        self.assertEqual(res.json()["job_ids"], ["100"])

    def test_count_allocates_requested_number(self) -> None:
        job_ids = iter(["100", "101", "102"])

        def fake_allocate(*_args, **_kwargs) -> tuple[str, None]:
            return (next(job_ids), None)

        with (
            patch("main.API_KEY", ""),
            patch("main.allocate_gpu", side_effect=fake_allocate) as allocate_gpu,
            patch("main.setup_allocation_session", side_effect=lambda jid, *_: f"{jid}_s"),
        ):
            res = _request(
                "POST", "/allocate",
                json={"gpu_type": "nvidia", "time_mins": 30, "count": 3},
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(allocate_gpu.call_count, 3)
        self.assertEqual(res.json()["job_ids"], ["100", "101", "102"])


class FileAccessTest(unittest.TestCase):
    """/file and /dirs are confined to ALLOWED_FILE_ROOT and refuse secrets even
    inside it, so a network-reachable GET can't read ~/.ssh, .env, or /etc."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / "ok.txt").write_text("hello")
        (self.root / ".env").write_text("SECRET=1")
        self._patches = [patch("dirs.ALLOWED_FILE_ROOT", self.root), patch("main.API_KEY", "")]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def test_serves_file_within_root(self) -> None:
        res = _request("GET", "/file", params={"path": str(self.root / "ok.txt")})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["content"], "hello")

    def test_rejects_file_outside_root(self) -> None:
        res = _request("GET", "/file", params={"path": "/etc/passwd"})
        self.assertEqual(res.status_code, 403)

    def test_rejects_traversal_escape(self) -> None:
        res = _request("GET", "/file", params={"path": f"{self.root}/../../../etc/passwd"})
        self.assertEqual(res.status_code, 403)

    def test_rejects_env_file_within_root(self) -> None:
        res = _request("GET", "/file", params={"path": str(self.root / ".env")})
        self.assertEqual(res.status_code, 403)

    def test_dirs_rejects_outside_root(self) -> None:
        res = _request("GET", "/dirs", params={"path": "/etc"})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["dirs"], [])
        self.assertTrue(body["error"])


class RunCommandTest(unittest.TestCase):
    """POST /sessions/{name}/run lets an authenticated caller run a command in an
    existing allocation instead of resorting to out-of-band tmux send-keys."""

    def test_run_sends_command_to_existing_session(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.session_exists", return_value=True),
            patch("main.send_to_session", return_value=True) as send,
        ):
            res = _request("POST", "/sessions/1_alloc/run", json={"command": "nvidia-smi"})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["success"])
        send.assert_called_once_with("1_alloc", "nvidia-smi")

    def test_run_404_when_session_missing(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.session_exists", return_value=False),
            patch("main.send_to_session") as send,
        ):
            res = _request("POST", "/sessions/missing/run", json={"command": "ls"})
        self.assertEqual(res.status_code, 404)
        send.assert_not_called()

    def test_run_400_when_command_blank(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.session_exists", return_value=True),
            patch("main.send_to_session") as send,
        ):
            res = _request("POST", "/sessions/1_alloc/run", json={"command": "   "})
        self.assertEqual(res.status_code, 400)
        send.assert_not_called()

    def test_run_502_when_send_fails(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main.session_exists", return_value=True),
            patch("main.send_to_session", return_value=False),
        ):
            res = _request("POST", "/sessions/1_alloc/run", json={"command": "ls"})
        self.assertEqual(res.status_code, 502)


class EventLoopIsolationTest(unittest.TestCase):
    def test_slow_gpu_report_does_not_delay_health(self) -> None:
        report_started = threading.Event()

        def slow_gpu_report() -> dict:
            # Stands in for a blocking subprocess call, e.g. an ssh to a
            # dead compute node that hangs until ConnectTimeout.
            report_started.set()
            time.sleep(1.0)
            return {"nodes": [], "summary": {}, "gpu_jobs_by_node": {}}

        async def scenario() -> tuple[httpx.Response, httpx.Response, float]:
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                start = time.monotonic()
                report_task = asyncio.create_task(client.get("/gpu-report"))
                deadline = start + 5
                while not report_started.is_set():
                    self.assertLess(time.monotonic(), deadline, "/gpu-report never reached its handler")
                    await asyncio.sleep(0.01)
                health = await client.get("/health")
                health_elapsed = time.monotonic() - start
                report = await report_task
            return health, report, health_elapsed

        with (
            patch("main.format_gpu_report_v2", side_effect=slow_gpu_report),
            patch("main.API_KEY", ""),
        ):
            health, report, health_elapsed = asyncio.run(scenario())

        self.assertEqual(health.status_code, 200)
        self.assertEqual(report.status_code, 200)
        self.assertLess(
            health_elapsed,
            0.5,
            "/health was starved by a slow subprocess in /gpu-report: "
            "blocking work must not run on the event loop",
        )


if __name__ == "__main__":
    unittest.main()
