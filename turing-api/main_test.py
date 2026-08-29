import asyncio
import re
import threading
import time
import unittest
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


class RouteSurfaceTest(unittest.TestCase):
    """Every route the API serves has a named caller in tom.quest. An endpoint no
    client asks for is still reachable by anyone holding the shared API key (the
    Next proxy at app/api/turing/[...path]/route.ts forwards ANY path an admin
    names), so an uncalled route is pure attack surface. This list is the contract:
    adding a route means adding its caller here, and it is what caught the six
    uncalled routes deleted in this test's introducing commit — GET /dirs,
    GET /file, GET /cmt-dirs, POST /sessions/{name}/run,
    GET /sessions/{name}/clients, POST /sessions/{name}/detach-clients."""

    # Routes FastAPI mounts on its own; no tom.quest code asks for them.
    FRAMEWORK_ROUTES = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

    # path -> the caller that asks for it
    CALLERS = {
        "/health": "convex/serverHealth.ts pollTuring cron",
        "/gpu-report": "app/turing/turing-client.tsx",
        "/gpu-types": "app/turing/components/allocate-form.tsx, pool-panel.tsx",
        "/allocate": "app/turing/components/allocate-form.tsx, convex/gpuPool.ts",
        "/jobs": "app/turing/turing-client.tsx, convex/gpuPool.ts reconcile",
        "/jobs/{job_id}": "app/turing/components/job-table.tsx, convex/gpuPool.ts",
        "/sessions/{session_name}/output": "app/turing/components/terminal-modal.tsx",
        "/ws/sessions/{session_name}": "app/turing/terminal/[session]/terminal-client.tsx",
        "/transformer-trace/{path}": "app/transformer/lib/turing-source.ts",
        "/cmt-node": "app/api/boolback/node/route.ts",
        "/cmt-file": "app/api/boolback/file/route.ts",
        "/boolback-snapshot": "app/boolback/data/source.ts (POST), boolback_cron.sh",
        "/boolback-snapshot-blob": "app/api/boolback/blob/route.ts",
        "/forge/train": "app/forge/components/builder-form.tsx",
        "/forge/train/{run_id}": "app/forge/components/job-list.tsx",
        "/forge/runs": "app/forge/components/job-list.tsx",
        "/forge/serve": "app/forge/components/job-list.tsx",
        "/forge/serve/{run_id}": "app/forge/components/chat-panel.tsx",
        # No caller as of the Aug 2026 sweep. Left in place because it is the stop
        # half of /forge/serve, which does have callers; the same sweep's other
        # uncalled routes were deleted (see this class's docstring).
        "/forge/serve/{run_id}/stop": "",
        "/forge/chat": "app/forge/components/chat-panel.tsx",
    }

    @staticmethod
    def _served_paths() -> set[str]:
        # Starlette keeps the converter in the path ("{path:path}"); the caller map
        # names the parameter alone.
        return {
            re.sub(r":[a-z_]+\}", "}", route.path)
            for route in main.app.routes
            if isinstance(getattr(route, "path", None), str)
        }

    def test_every_served_route_has_a_caller(self) -> None:
        unlisted = self._served_paths() - set(self.CALLERS) - self.FRAMEWORK_ROUTES
        self.assertEqual(
            unlisted,
            set(),
            "route served with no caller listed: delete it, or add its caller to CALLERS",
        )

    def test_deleted_file_and_session_routes_stay_deleted(self) -> None:
        served = self._served_paths()
        for gone in (
            "/dirs",
            "/file",
            "/cmt-dirs",
            "/sessions/{session_name}/run",
            "/sessions/{session_name}/clients",
            "/sessions/{session_name}/detach-clients",
        ):
            self.assertNotIn(gone, served)


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
