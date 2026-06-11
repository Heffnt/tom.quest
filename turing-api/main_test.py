import asyncio
import threading
import time
import unittest
from unittest.mock import patch

import httpx

import main


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
