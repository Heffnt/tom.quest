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


class TransformerTraceAuthTest(unittest.TestCase):
    """/transformer-trace is the one non-WS route with no `verify_api_key`, and
    that is deliberate: /transformer is a public page whose browser calls this
    host directly, and the shared API key never leaves Vercel. An audit that
    "fixes" the asymmetry by adding the dependency would 401 every visitor to a
    public page. These tests fail if that happens."""

    def test_reachable_without_api_key_when_one_is_configured(self) -> None:
        # API_KEY set + no X-API-Key header is precisely the anonymous-visitor
        # case. Any status but 401 means the route stayed public.
        with (
            patch("main.API_KEY", "a-real-key"),
            patch("main._trace_target", return_value=None),
        ):
            res = _request("GET", "/transformer-trace/config")
        self.assertNotEqual(
            res.status_code, 401,
            "/transformer-trace went behind X-API-Key; that 401s the public "
            "/transformer page, whose browser cannot hold the shared key",
        )
        self.assertEqual(res.status_code, 503)

    def test_every_other_non_ws_route_still_requires_the_key(self) -> None:
        # The flip side: the exception must stay an exception of exactly two.
        with patch("main.API_KEY", "a-real-key"):
            for path in ("/gpu-report", "/gpu-types", "/jobs", "/dirs"):
                with self.subTest(path=path):
                    self.assertEqual(_request("GET", path).status_code, 401)
            self.assertEqual(_request("GET", "/health").status_code, 200)

    def test_caller_token_is_forwarded_not_the_api_key(self) -> None:
        # The route's whole security story is that it relays the trace server's
        # own per-job credential. If it stopped forwarding x-trace-token, the
        # upstream would 401 and the page would break with no auth gained.
        seen: dict[str, str] = {}

        def fake_urlopen(req, timeout=None):  # noqa: ANN001
            seen["token"] = req.get_header("X-trace-token") or ""
            seen["url"] = req.full_url
            raise OSError("no upstream in test")

        with (
            patch("main.API_KEY", "a-real-key"),
            patch("main._trace_target", return_value="http://node42:8899"),
            patch("urllib.request.urlopen", side_effect=fake_urlopen),
        ):
            _request("GET", "/transformer-trace/config",
                     headers={"x-trace-token": "per-job-secret"})

        self.assertEqual(seen["token"], "per-job-secret")
        self.assertEqual(seen["url"], "http://node42:8899/config")
        self.assertNotIn("a-real-key", seen["token"])


class TransformerTraceBackpressureTest(unittest.TestCase):
    """Each forward parks a threadpool worker for up to TRACE_TIMEOUT_S, and
    that pool is shared with every sync `def` endpoint. Since this route is
    unauthenticated, without a cap an anonymous caller could hold every worker
    and starve the authenticated surface. Guard the cap and the sync endpoints
    it protects."""

    def test_excess_concurrent_forwards_are_shed_and_release_afterwards(self) -> None:
        release = threading.Event()
        in_upstream = threading.Semaphore(0)

        def hanging_urlopen(req, timeout=None):  # noqa: ANN001
            # Stands in for a trace server that accepts the connection and then
            # never answers -- the case that pins a worker for TRACE_TIMEOUT_S.
            in_upstream.release()
            release.wait(10)
            raise OSError("released")

        async def scenario() -> tuple[list[int], int, int]:
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                hangers = [
                    asyncio.create_task(client.get("/transformer-trace/generate"))
                    for _ in range(main.TRACE_MAX_INFLIGHT)
                ]
                # Wait until every slot is genuinely occupied upstream, so the
                # next request is rejected by the cap and not by a race.
                for _ in range(main.TRACE_MAX_INFLIGHT):
                    while not in_upstream.acquire(blocking=False):
                        await asyncio.sleep(0.01)

                shed = await client.get("/transformer-trace/generate")
                # The authenticated surface must still be served while the
                # unauthenticated route is saturated.
                healthy = await client.get("/gpu-report")

                release.set()
                done = [r.status_code for r in await asyncio.gather(*hangers)]
            return done, shed.status_code, healthy.status_code

        with (
            patch("main.API_KEY", ""),
            patch("main._trace_target", return_value="http://node42:8899"),
            patch("urllib.request.urlopen", side_effect=hanging_urlopen),
            patch("main.format_gpu_report_v2",
                  return_value={"nodes": [], "summary": {}, "gpu_jobs_by_node": {}}),
        ):
            done, shed, healthy = asyncio.run(scenario())

        self.assertEqual(
            shed, 503,
            "an unauthenticated caller held every trace slot and the next request "
            "was still admitted; the cap is what keeps this route off the shared "
            "threadpool that all sync endpoints use",
        )
        self.assertEqual(healthy, 200, "a saturated /transformer-trace starved /gpu-report")
        self.assertEqual(done, [503] * main.TRACE_MAX_INFLIGHT)
        # The counter must unwind, or the route bricks itself after one burst.
        self.assertEqual(main._trace_inflight, 0)

    def test_a_failed_forward_releases_its_slot(self) -> None:
        with (
            patch("main.API_KEY", ""),
            patch("main._trace_target", return_value="http://node42:8899"),
            patch("urllib.request.urlopen", side_effect=OSError("boom")),
        ):
            for _ in range(main.TRACE_MAX_INFLIGHT + 2):
                self.assertEqual(
                    _request("GET", "/transformer-trace/config").status_code, 503)
        self.assertEqual(main._trace_inflight, 0)


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
