import unittest
from unittest.mock import patch

import slurm


class SlurmTest(unittest.TestCase):
    def test_get_user_jobs_queries_running_job_stats_when_cache_has_no_match(self) -> None:
        squeue_output = "123|RUNNING|1:00:00|2026-04-19T18:00:00|2026-04-19T19:00:00|gpu:nvidia:1|gpu-01|allocation\n"
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
        self.assertEqual(jobs[0].job_name, "allocation")
        self.assertEqual(jobs[0].gpu_stats, slurm.JobGpuStats(**direct_stats))
        get_job_gpu_stats.assert_called_once_with("123")

    def test_get_user_jobs_round_trips_reserved_pool_name_with_colons(self) -> None:
        # The reserved pool name format "gpupool:<gpuType>:<fingerprint>" contains
        # colons. The squeue line is pipe-split, so colons in the trailing job
        # name (%j) must survive intact for the Convex reconciler to match owners.
        squeue_output = (
            "456|PENDING|1:00:00|N/A|N/A|gpu:nvidia:1|(Resources)|gpupool:nvidia:deadbeef\n"
        )

        with (
            patch("slurm.run", return_value=(squeue_output, "", 0)),
            patch("slurm.get_screen_name", return_value=""),
            patch("gpu_report.get_cached_gpu_activity", return_value={"job_stats_by_job_id": {}}),
        ):
            jobs = slurm.get_user_jobs()

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].job_name, "gpupool:nvidia:deadbeef")

    def test_get_user_jobs_keeps_pipe_in_manual_job_name(self) -> None:
        # A manually-submitted job name may contain "|", the squeue field
        # delimiter. The bounded split makes the trailing %j absorb the extra
        # pipes so /jobs does not raise (a 500 would freeze the reconciler, which
        # treats GET /jobs as its source of truth).
        squeue_output = (
            "789|RUNNING|1:00:00|2026-04-19T18:00:00|2026-04-19T19:00:00|gpu:nvidia:1|gpu-01|my|weird|name\n"
        )

        with (
            patch("slurm.run", return_value=(squeue_output, "", 0)),
            patch("slurm.get_screen_name", return_value=""),
            patch("gpu_report.get_cached_gpu_activity", return_value={"job_stats_by_job_id": {}}),
            patch("gpu_report.get_job_gpu_stats", return_value=None),
        ):
            jobs = slurm.get_user_jobs()

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].job_name, "my|weird|name")
        self.assertEqual(jobs[0].gpu_type, "nvidia")

    def test_parse_time_to_seconds_treats_unknown_errors_as_zero(self) -> None:
        self.assertEqual(slurm.parse_time_to_seconds("[Unknown Error]"), 0)

    def test_extract_job_id_matches_canonical_salloc_lines(self) -> None:
        self.assertEqual(
            slurm._extract_job_id("salloc: Granted job allocation 123456"), "123456"
        )
        self.assertEqual(
            slurm._extract_job_id("salloc: Pending job allocation 789"), "789"
        )

    def test_extract_job_id_ignores_incidental_job_numbers(self) -> None:
        # A bare "job <n>" appears in unrelated srun/error chatter. Scraping it
        # would return a wrong id; only the canonical allocation lines count.
        self.assertIsNone(
            slurm._extract_job_id("srun: error: task 0 launch failed: job 5 step")
        )
        self.assertIsNone(slurm._extract_job_id("salloc: error: out of memory"))


if __name__ == "__main__":
    unittest.main()
