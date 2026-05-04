import unittest
from unittest.mock import patch

import slurm


class SlurmTest(unittest.TestCase):
    def test_get_user_jobs_queries_running_job_stats_when_cache_has_no_match(self) -> None:
        squeue_output = "123|RUNNING|1:00:00|2026-04-19T18:00:00|2026-04-19T19:00:00|gpu:nvidia:1|gpu-01\n"
        direct_stats = {
            "memory_used_mb": 4096,
            "memory_total_mb": 81920,
            "temperature_c": 54,
            "utilization_pct": 98,
        }

        with (
            patch("slurm.run", return_value=(squeue_output, "", 0)),
            patch("slurm.get_screen_name", return_value=""),
            patch("gpu_report.get_cached_gpu_activity", return_value={"job_stats_by_job_id": {}}),
            patch("gpu_report.get_job_gpu_stats", return_value=direct_stats) as get_job_gpu_stats,
        ):
            jobs = slurm.get_user_jobs()

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].job_id, "123")
        self.assertEqual(jobs[0].gpu_stats, slurm.JobGpuStats(**direct_stats))
        get_job_gpu_stats.assert_called_once_with("123")

    def test_parse_time_to_seconds_treats_unknown_errors_as_zero(self) -> None:
        self.assertEqual(slurm.parse_time_to_seconds("[Unknown Error]"), 0)


if __name__ == "__main__":
    unittest.main()
