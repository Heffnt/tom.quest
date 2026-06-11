import time
import unittest
from unittest.mock import patch

from gpu_report import (
    NodeInfo,
    _parse_job_node_allocations,
    _parse_nvidia_smi_csv,
    _query_node_gpu_stats,
    aggregate_gpu_device_stats,
    get_cached_gpu_activity,
)


class GpuReportTest(unittest.TestCase):
    def test_aggregate_gpu_device_stats_sums_memory_and_uses_peak_heat_and_activity(self) -> None:
        device_stats = _parse_nvidia_smi_csv(
            "\n".join(
                [
                    "0, 1024, 81920, 45, 0",
                    "1, 2048, 81920, 61, 73",
                ]
            )
        )

        self.assertEqual(
            aggregate_gpu_device_stats(device_stats),
            {
                "memory_used_mb": 3072,
                "memory_total_mb": 163840,
                "temperature_c": 61,
                "utilization_pct": 73,
            },
        )

    def test_parse_job_node_allocations_ignores_numnodes_field(self) -> None:
        scontrol_output = (
            "JobId=123 JobName=train UserId=alice(1000) NumNodes=1 NumCPUs=8 "
            "Nodes=compute-2-02 CPU_IDs=0-7 Mem=0 GRES=gpu:a100:1(IDX:0) TRES=gres/gpu=1"
        )

        def fake_run_stdout(cmd: str) -> str:
            if cmd.startswith("scontrol show job"):
                return scontrol_output
            if cmd == "scontrol show hostnames compute-2-02":
                return "compute-2-02\n"
            return ""

        with patch("gpu_report.run_stdout", side_effect=fake_run_stdout):
            allocations = _parse_job_node_allocations("123", "compute-2-02", "gpu:1")

        self.assertEqual([a["node_name"] for a in allocations], ["compute-2-02"])

    def test_node_gpu_stats_accepts_new_compute_node_host_keys(self) -> None:
        with patch("gpu_report.run", return_value=("0, 1024, 81920, 45, 0\n", "", 0)) as run:
            stats = _query_node_gpu_stats({"gpu-1-01"})

        command = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=accept-new", command)
        self.assertEqual(stats["gpu-1-01"][0]["memory_used_mb"], 1024)

    def test_node_gpu_stats_queries_nodes_concurrently_and_skips_failures(self) -> None:
        def slow_run(cmd: str) -> tuple[str, str, int]:
            time.sleep(0.3)
            if "gpu-dead" in cmd:
                return "", "ssh: connect to host gpu-dead: timed out", 255
            return "0, 1024, 81920, 45, 0\n", "", 0

        with patch("gpu_report.run", side_effect=slow_run):
            start = time.monotonic()
            stats = _query_node_gpu_stats({"gpu-1-01", "gpu-1-02", "gpu-dead"})
            elapsed = time.monotonic() - start

        self.assertEqual(sorted(stats), ["gpu-1-01", "gpu-1-02"])
        self.assertLess(elapsed, 0.6, "node ssh queries must run concurrently, not serially")

    def test_parse_nvidia_smi_csv_treats_unknown_errors_as_missing_values(self) -> None:
        device_stats = _parse_nvidia_smi_csv("0, [Unknown Error], 81920, [Unknown Error], 0\n")

        self.assertEqual(
            device_stats[0],
            {
                "memory_used_mb": None,
                "memory_total_mb": 81920,
                "temperature_c": None,
                "utilization_pct": 0,
            },
        )

    def test_gpu_activity_refresh_failure_returns_empty_activity(self) -> None:
        nodes = [
            NodeInfo(
                name="gpu-1-01",
                gpu_type="a100",
                partition="gpu",
                total_gpus=2,
                allocated_gpus=0,
                state="IDLE",
                memory_total_mb=1024,
                memory_allocated_mb=0,
            )
        ]

        with (
            patch("gpu_report._GPU_ACTIVITY_CACHE", {"expires_at": 0.0, "value": None}),
            patch("gpu_report._build_gpu_activity", side_effect=BlockingIOError("fork failed")),
        ):
            activity = get_cached_gpu_activity(nodes)

        self.assertEqual(activity["gpu_jobs_by_node"], {"gpu-1-01": [None, None]})
        self.assertEqual(activity["job_stats_by_job_id"], {})


if __name__ == "__main__":
    unittest.main()
