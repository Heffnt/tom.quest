import subprocess
import unittest
from unittest.mock import patch

from shell import RESOURCE_UNAVAILABLE_RETURN_CODE, run


class ShellTest(unittest.TestCase):
    def test_run_reports_resource_unavailable_without_raising(self) -> None:
        with patch("shell.subprocess.run", side_effect=BlockingIOError("fork failed")):
            stdout, stderr, returncode = run("sinfo")

        self.assertEqual(stdout, "")
        self.assertIn("fork failed", stderr)
        self.assertEqual(returncode, RESOURCE_UNAVAILABLE_RETURN_CODE)

    def test_run_reports_timeout_without_raising(self) -> None:
        timeout = subprocess.TimeoutExpired("sinfo", 1, output="partial", stderr="slow")

        with patch("shell.subprocess.run", side_effect=timeout):
            stdout, stderr, returncode = run("sinfo", timeout=1)

        self.assertEqual(stdout, "partial")
        self.assertEqual(stderr, "slow")
        self.assertEqual(returncode, 124)


if __name__ == "__main__":
    unittest.main()
