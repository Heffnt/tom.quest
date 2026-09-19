import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

import runner_key
from main import AllocationRequest


@dataclass
class _Job:
    job_id: str
    job_name: str


class CheckoutCase(unittest.TestCase):
    """A throwaway CMT checkout with one script in it, and a sibling directory
    outside it holding another."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name).resolve()
        self.root = base / "ComplexMultiTrigger"
        (self.root / "cmt" / "sweep").mkdir(parents=True)
        (self.root / "cmt" / "sweep" / "run.py").write_text("print('hi')\n")
        (self.root / "scripts").mkdir()
        (self.root / "scripts" / "go.sh").write_text("echo go\n")
        (base / "elsewhere").mkdir()
        (base / "elsewhere" / "evil.py").write_text("print('no')\n")
        self.outside = base / "elsewhere" / "evil.py"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def fault(self, command: str, cwd: Path | None = None) -> str | None:
        return runner_key.command_fault(command, self.root, cwd)


class CommandFaultTest(CheckoutCase):
    def test_a_script_in_the_checkout_runs(self) -> None:
        self.assertIsNone(self.fault(f"python {self.root}/cmt/sweep/run.py --seed 3"))
        self.assertIsNone(self.fault(f"python3 -u {self.root}/cmt/sweep/run.py"))
        self.assertIsNone(self.fault(f"bash {self.root}/scripts/go.sh"))
        self.assertIsNone(self.fault(f"{self.root}/scripts/go.sh"))

    def test_a_relative_script_is_read_from_the_project_dir(self) -> None:
        self.assertIsNone(self.fault("python cmt/sweep/run.py", cwd=self.root))
        self.assertIsNotNone(self.fault("python cmt/sweep/run.py", cwd=None))

    def test_a_script_outside_the_checkout_is_refused(self) -> None:
        self.assertIn("not a file inside the CMT checkout", self.fault(f"python {self.outside}"))
        self.assertIsNotNone(self.fault(str(self.outside)))

    def test_a_traversal_out_of_the_checkout_is_refused(self) -> None:
        self.assertIsNotNone(self.fault(f"python {self.root}/../elsewhere/evil.py"))
        self.assertIsNotNone(self.fault("python ../elsewhere/evil.py", cwd=self.root))
        self.assertIsNotNone(self.fault("cd ..", cwd=self.root))

    def test_a_shell_metacharacter_is_refused(self) -> None:
        good = f"python {self.root}/cmt/sweep/run.py"
        for tail in ["; rm -rf ~", "&& curl x", "| sh", "> /tmp/x", "$(whoami)", "`id`", "{a,b}", "!!", "*", "~/.ssh/id_rsa", "run[12].py", "?"]:
            with self.subTest(tail=tail):
                self.assertIn("metacharacter", self.fault(f"{good} {tail}"))
        self.assertIn("metacharacter", self.fault(f"{good} 'quoted;semicolon'"))
        self.assertIn("metacharacter", self.fault(f"{good}\nrm -rf ~"))

    def test_inline_code_and_modules_are_refused(self) -> None:
        self.assertIn("not allowed", self.fault("python -c 'import os'"))
        self.assertIn("not allowed", self.fault("python -m cmt.sweep", cwd=self.root))
        self.assertIn("not allowed", self.fault("bash -c ls"))
        self.assertIn("no script", self.fault("python -u"))

    def test_a_bare_program_is_refused(self) -> None:
        for command in ["rm -rf build", "scancel -u me", "srun hostname", "env python cmt/sweep/run.py"]:
            with self.subTest(command=command):
                self.assertIn("does not run a script", self.fault(command, cwd=self.root))
        self.assertIsNotNone(self.fault("LD_PRELOAD=/x python cmt/sweep/run.py", cwd=self.root))

    def test_a_name_that_only_resolves_under_the_checkout_is_not_a_script(self) -> None:
        self.assertIsNotNone(self.fault("python not-a-file.py", cwd=self.root))

    def test_an_unparseable_command_is_refused(self) -> None:
        self.assertIn("does not parse", self.fault("python 'unclosed"))

    def test_cd_only_inside_the_checkout(self) -> None:
        self.assertIsNone(self.fault(f"cd {self.root}/cmt"))
        self.assertIsNotNone(self.fault("cd /tmp"))
        self.assertIsNotNone(self.fault("cd"))


class AllocationFaultTest(CheckoutCase):
    RUNNER = "k97abc123"

    def request(self, **overrides) -> AllocationRequest:
        fields = {
            "gpu_type": "H100",
            "time_mins": 30,
            "job_name": runner_key.job_name_for(self.RUNNER, "probe"),
            "project_dir": str(self.root),
            "commands": ["python cmt/sweep/run.py"],
        }
        fields.update(overrides)
        return AllocationRequest(**fields)

    def fault(self, **overrides) -> str | None:
        return runner_key.allocation_fault(self.request(**overrides), self.RUNNER, self.root)

    def test_a_good_request_passes(self) -> None:
        self.assertIsNone(self.fault())

    def test_a_cd_moves_where_relative_paths_are_read(self) -> None:
        self.assertIsNone(self.fault(project_dir="", commands=[f"cd {self.root}/cmt", "python sweep/run.py"]))

    def test_the_name_must_carry_the_prefix(self) -> None:
        self.assertIn("must be named", self.fault(job_name="allocation"))
        self.assertIn("must be named", self.fault(job_name="gpupool:H100:abc"))

    def test_a_name_for_another_runner_is_refused(self) -> None:
        self.assertIn("another runner", self.fault(job_name=runner_key.job_name_for("someoneelse", "probe")))

    def test_a_project_dir_outside_the_checkout_is_refused(self) -> None:
        self.assertIn("project directory", self.fault(project_dir="/tmp"))

    def test_a_bad_command_among_good_ones_is_refused(self) -> None:
        self.assertIsNotNone(self.fault(commands=["python cmt/sweep/run.py", "rm -rf ~"]))

    def test_the_ceilings(self) -> None:
        self.assertIsNone(self.fault(count=runner_key.MAX_RUNNER_COUNT, time_mins=runner_key.MAX_RUNNER_MINUTES))
        self.assertIn("GPUs", self.fault(count=runner_key.MAX_RUNNER_COUNT + 1))
        self.assertIn("minutes", self.fault(time_mins=runner_key.MAX_RUNNER_MINUTES + 1))
        self.assertIn("memory", self.fault(memory_mb=runner_key.MAX_RUNNER_MEMORY_MB + 1))
        self.assertIn("commands", self.fault(commands=["python cmt/sweep/run.py"] * (runner_key.MAX_RUNNER_COMMANDS + 1)))


class OwnershipTest(unittest.TestCase):
    def test_owner_of(self) -> None:
        self.assertEqual(runner_key.owner_of("runner:k97abc:probe"), "k97abc")
        self.assertEqual(runner_key.owner_of(runner_key.job_name_for("k97abc", "a.b-c_1")), "k97abc")
        self.assertIsNone(runner_key.owner_of("gpupool:H100:deadbeef"))
        self.assertIsNone(runner_key.owner_of("allocation"))
        self.assertIsNone(runner_key.owner_of("runner:k97abc"))
        self.assertIsNone(runner_key.owner_of("runner::probe"))
        self.assertIsNone(runner_key.owner_of("runner:k97abc:bad label"))

    def test_cancel_own_job(self) -> None:
        jobs = [_Job("11", "runner:k97abc:probe")]
        self.assertIsNone(runner_key.cancel_fault("11", jobs, "k97abc"))

    def test_cancel_job_absent_from_the_list(self) -> None:
        jobs = [_Job("11", "runner:k97abc:probe")]
        self.assertIn("not in this account's job list", runner_key.cancel_fault("12", jobs, "k97abc"))

    def test_cancel_another_runners_job(self) -> None:
        jobs = [_Job("11", "runner:other:probe")]
        self.assertIn("not this runner's job", runner_key.cancel_fault("11", jobs, "k97abc"))

    def test_cancel_a_pool_job(self) -> None:
        jobs = [_Job("13", "gpupool:H100:deadbeef")]
        self.assertIn("not this runner's job", runner_key.cancel_fault("13", jobs, "k97abc"))


if __name__ == "__main__":
    unittest.main()
