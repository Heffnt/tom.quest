import unittest
from unittest.mock import patch

from gpu_report import _parse_nvidia_smi_csv, _query_node_gpu_stats, aggregate_gpu_device_stats


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


if __name__ == "__main__":
    unittest.main()
