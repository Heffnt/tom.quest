import unittest
from unittest.mock import patch

from gpu_report import (
    NodeInfo,
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

    def test_node_gpu_stats_accepts_new_compute_node_host_keys(self) -> None:
        with patch("gpu_report.run", return_value=("0, 1024, 81920, 45, 0\n", "", 0)) as run:
            stats = _query_node_gpu_stats({"gpu-1-01"})

        command = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=accept-new", command)
        self.assertEqual(stats["gpu-1-01"][0]["memory_used_mb"], 1024)

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
