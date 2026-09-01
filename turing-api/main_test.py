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


class ListJobsTest(unittest.TestCase):
    """GET /jobs exposes the SLURM job name so the Convex reconciler can tell
    which jobs the declarative GPU pool owns (name == 'gpupool:<type>:<fp>')."""

    def test_jobs_response_carries_job_name(self) -> None:
        from slurm import JobInfo

        pool_job = JobInfo(
            job_id="456",
            gpu_type="nvidia",
            status="PENDING",
            time_remaining="1:00:00",
            time_remaining_seconds=3600,
            screen_name="",
            start_time="N/A",
            end_time="N/A",
            job_name="gpupool:nvidia:deadbeef",
            gpu_stats=None,
        )

        with (
            patch("main.API_KEY", ""),
            patch("main.get_user_jobs", return_value=[pool_job]),
        ):
            res = _request("GET", "/jobs")

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["job_name"], "gpupool:nvidia:deadbeef")


class ReadKeyTest(unittest.TestCase):
    """TURING_READ_KEY opens three GETs and nothing else.

    The point of the split: a holder of the read key can SEE the cluster
    (GPU report, job list, session output) and cannot ACT on it. The write
    verb this guards against is POST /sessions/{name}/run, which types an
    arbitrary command into a tmux session under Tom's cluster account — the
    full TURING_API_KEY authorizes it and the read key must never.
    """

    FULL = "full-key"
    READ = "read-key"

    def _with_keys(self, full: str = FULL, read: str = READ):
        return (patch("main.API_KEY", full), patch("main.READ_KEY", read))

    # -- the read key opens the three read endpoints ---------------------------

    def test_read_key_opens_gpu_report(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.format_gpu_report_v2", return_value={"nodes": []}):
            res = _request("GET", "/gpu-report", headers={"X-API-Key": self.READ})
        self.assertEqual(res.status_code, 200)

    def test_read_key_opens_jobs(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.get_user_jobs", return_value=[]):
            res = _request("GET", "/jobs", headers={"X-API-Key": self.READ})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [])

    def test_read_key_opens_session_output(self) -> None:
        full, read = self._with_keys()
        with (
            full,
            read,
            patch("main.session_exists", return_value=True),
            patch("main.capture_output", return_value="hello"),
        ):
            res = _request(
                "GET", "/sessions/1_alloc/output", headers={"X-API-Key": self.READ}
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["output"], "hello")

    # -- and nothing else ------------------------------------------------------

    def test_read_key_refused_on_run_command(self) -> None:
        """The whole reason the split exists."""
        full, read = self._with_keys()
        with full, read, patch("main.send_to_session") as send:
            res = _request(
                "POST",
                "/sessions/1_alloc/run",
                json={"command": "nvidia-smi"},
                headers={"X-API-Key": self.READ},
            )
        self.assertEqual(res.status_code, 401)
        send.assert_not_called()

    def test_read_key_refused_on_allocate(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.allocate_gpu") as allocate_gpu:
            res = _request(
                "POST",
                "/allocate",
                json={"gpu_type": "nvidia", "time_mins": 30},
                headers={"X-API-Key": self.READ},
            )
        self.assertEqual(res.status_code, 401)
        allocate_gpu.assert_not_called()

    def test_read_key_refused_on_job_cancel(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.cancel_job") as cancel:
            res = _request("DELETE", "/jobs/123", headers={"X-API-Key": self.READ})
        self.assertEqual(res.status_code, 401)
        cancel.assert_not_called()

    def test_read_key_refused_on_file_read(self) -> None:
        """/file is under the full key: it reaches the whole home directory."""
        full, read = self._with_keys()
        with full, read:
            res = _request(
                "GET", "/file", params={"path": "/tmp/x"}, headers={"X-API-Key": self.READ}
            )
        self.assertEqual(res.status_code, 401)

    # -- the full key is unchanged --------------------------------------------

    def test_full_key_still_opens_read_endpoints(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.get_user_jobs", return_value=[]):
            res = _request("GET", "/jobs", headers={"X-API-Key": self.FULL})
        self.assertEqual(res.status_code, 200)

    def test_full_key_still_opens_write_endpoints(self) -> None:
        full, read = self._with_keys()
        with (
            full,
            read,
            patch("main.session_exists", return_value=True),
            patch("main.send_to_session", return_value=True) as send,
        ):
            res = _request(
                "POST",
                "/sessions/1_alloc/run",
                json={"command": "nvidia-smi"},
                headers={"X-API-Key": self.FULL},
            )
        self.assertEqual(res.status_code, 200)
        send.assert_called_once_with("1_alloc", "nvidia-smi")

    # -- fail closed -----------------------------------------------------------

    def test_unset_read_key_closes_the_read_door(self) -> None:
        """An unset TURING_READ_KEY must not become a blank password: the read
        endpoints go back to full-key-only, and an empty header is refused."""
        full, read = self._with_keys(read="")
        with full, read, patch("main.get_user_jobs", return_value=[]):
            with_empty = _request("GET", "/jobs", headers={"X-API-Key": ""})
            missing = _request("GET", "/jobs")
            stale = _request("GET", "/jobs", headers={"X-API-Key": self.READ})
            still_full = _request("GET", "/jobs", headers={"X-API-Key": self.FULL})
        self.assertEqual(with_empty.status_code, 401)
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(stale.status_code, 401)
        self.assertEqual(still_full.status_code, 200)

    def test_wrong_key_is_refused_on_a_read_endpoint(self) -> None:
        full, read = self._with_keys()
        with full, read, patch("main.get_user_jobs", return_value=[]):
            res = _request("GET", "/jobs", headers={"X-API-Key": "neither"})
        self.assertEqual(res.status_code, 401)

    def test_non_ascii_header_is_a_401_not_a_500(self) -> None:
        """The header is caller-controlled; a constant-time compare over str
        raises TypeError on non-ASCII, which would turn a refusal into a crash.
        Sent as raw bytes because that is what a non-ASCII header IS on the
        wire — Starlette decodes it latin-1 into a str the compare must survive."""
        full, read = self._with_keys()
        with full, read, patch("main.get_user_jobs", return_value=[]):
            res = _request("GET", "/jobs", headers={"X-API-Key": "kéy".encode("latin-1")})
        self.assertEqual(res.status_code, 401)

    def test_health_needs_no_key_at_all(self) -> None:
        """The one endpoint the worker box could already reach; unchanged."""
        full, read = self._with_keys()
        with full, read:
            res = _request("GET", "/health")
        self.assertEqual(res.status_code, 200)


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
