import unittest
from unittest.mock import patch

import tmux


class SetupSessionWorkerTest(unittest.TestCase):
    """release_on_exit turns allocate+run into fire-and-forget: after the queued
    commands finish, the shell reaches an appended scancel that frees the GPU,
    instead of sitting idle at a prompt until walltime."""

    def _run_worker(self, commands: list[str], release_on_exit: bool) -> list[str]:
        sent: list[str] = []
        with (
            patch("tmux._get_job_status", return_value="RUNNING"),
            patch("tmux.session_exists", return_value=False),
            patch("tmux.create_session", return_value=True),
            patch("tmux.kill_session", return_value=True),
            patch("tmux.send_to_session", side_effect=lambda name, cmd: sent.append(cmd) or True),
            patch("tmux.time.sleep", return_value=None),
        ):
            tmux._setup_session_worker("1_s", "123", commands, release_on_exit=release_on_exit)
        return sent

    def test_release_on_exit_appends_scancel_last(self) -> None:
        sent = self._run_worker(["python train.py"], release_on_exit=True)
        self.assertIn("srun --pty --jobid=123 bash", sent)
        self.assertIn("python train.py", sent)
        self.assertEqual(sent[-1], "scancel 123")

    def test_no_release_leaves_session_idle(self) -> None:
        sent = self._run_worker(["python train.py"], release_on_exit=False)
        self.assertNotIn("scancel 123", sent)
        self.assertEqual(sent[-1], "python train.py")


if __name__ == "__main__":
    unittest.main()
