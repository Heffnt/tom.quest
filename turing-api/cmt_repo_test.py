"""Guard: ONE environment name for the CMT checkout, read by both submitters.

The regression this pins down: forge.py read BOOLEAN_BACKDOOR_REPO while
boolback_snapshot.py read BOOLBACK_BUILDER_REPO_DIR, both defaulting to the same
path. Setting one and not the other pointed the Forge jobs and the boolback build at
DIFFERENT checkouts, and both surfaces still looked like an ordinary build. These
tests fail if a second name for that directory ever reappears.
"""
from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import boolback_snapshot
import cmt_repo
import forge
from cmt_repo import cmt_repo_dir

_MODULE_DIR = Path(__file__).resolve().parent
# The retired name. Nothing outside this test file may read it again.
_RETIRED_NAME = "BOOLBACK_BUILDER_REPO_DIR"


class CmtRepoDirTest(unittest.TestCase):
    """cmt_repo_dir() is the single reader of BOOLEAN_BACKDOOR_REPO."""

    def test_unset_falls_back_to_the_home_checkout(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop(cmt_repo.ENV_VAR, None)
            self.assertEqual(
                cmt_repo_dir(), Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"
            )

    def test_env_var_overrides_the_default(self) -> None:
        with patch.dict("os.environ", {cmt_repo.ENV_VAR: "/srv/cmt"}):
            self.assertEqual(cmt_repo_dir(), Path("/srv/cmt"))

    def test_value_is_read_at_call_time_not_at_import(self) -> None:
        # A module-level constant would freeze the value before the .env-driven
        # override (or a test's patch) could reach it.
        with patch.dict("os.environ", {cmt_repo.ENV_VAR: "/srv/one"}):
            first = cmt_repo_dir()
        with patch.dict("os.environ", {cmt_repo.ENV_VAR: "/srv/two"}):
            second = cmt_repo_dir()
        self.assertNotEqual(first, second)

    def test_unbraced_home_is_expanded(self) -> None:
        # python-dotenv leaves a bare $HOME as four literal characters, so a .env
        # line copied from the template's older form must still name a directory.
        with patch.dict("os.environ", {cmt_repo.ENV_VAR: "$HOME/cmt", "HOME": "/home/tester"}):
            self.assertEqual(cmt_repo_dir(), Path("/home/tester/cmt"))

    def test_tilde_is_expanded(self) -> None:
        with patch.dict("os.environ", {cmt_repo.ENV_VAR: "~/cmt", "HOME": "/home/tester"}):
            self.assertEqual(cmt_repo_dir(), Path("/home/tester/cmt"))


class OneNameForTheCheckoutTest(unittest.TestCase):
    """Both sbatch submitters resolve the checkout through the same setting."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.repo = self.root / "cmt-checkout"
        self.repo.mkdir()
        self.out = self.root / "cmt-output"
        (self.out / "artifacts").mkdir(parents=True)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self._patches = [
            patch.dict(
                "os.environ",
                {
                    "BOOLEAN_BACKDOOR_OUTPUT": str(self.out),
                    cmt_repo.ENV_VAR: str(self.repo),
                    # The retired name pointing somewhere else must change nothing.
                    _RETIRED_NAME: str(self.root / "wrong-checkout"),
                },
            ),
            patch("boolback_snapshot.CACHE_DIR", self.cache),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    @staticmethod
    def _sbatch_ok() -> CompletedProcess:
        return CompletedProcess(args=[], returncode=0, stdout="4242\n", stderr="")

    @staticmethod
    def _sbatch_call(run):
        """The one subprocess call that is the sbatch submit (a submit path may also
        shell out to squeue/scancel, so the last call is not necessarily it)."""
        calls = [c for c in run.call_args_list if c.args and c.args[0][0] == "sbatch"]
        assert len(calls) == 1, f"expected exactly one sbatch call, got {len(calls)}"
        return calls[0]

    def test_boolback_build_submits_from_the_configured_checkout(self) -> None:
        with patch("boolback_snapshot._job_active", return_value=False), patch(
            "boolback_snapshot.subprocess.run", return_value=self._sbatch_ok()
        ) as run:
            boolback_snapshot.submit_build((self.out / "artifacts").resolve())
        sbatch = self._sbatch_call(run)
        self.assertEqual(sbatch.kwargs["cwd"], str(self.repo))
        # It is also passed as an argument, because the build script puts the
        # checkout (and its tom.quest/ subdir) on PYTHONPATH.
        self.assertIn(str(self.repo), sbatch.args[0])

    def test_forge_train_submits_from_the_configured_checkout(self) -> None:
        with patch("forge.subprocess.run", return_value=self._sbatch_ok()) as run:
            forge.submit_train({"any": "config"}, None)
        sbatch = self._sbatch_call(run)
        self.assertEqual(sbatch.kwargs["cwd"], str(self.repo))
        self.assertIn(str(self.repo), sbatch.args[0])

    def test_forge_serve_submits_from_the_configured_checkout(self) -> None:
        run_dir = self.out / "forge" / "run-1"
        run_dir.mkdir(parents=True)
        (run_dir / "result.json").write_text(
            json.dumps(
                {
                    "status": "completed",
                    "base_model": "meta-llama/Llama-3.1-8B",
                    "model_dir": str(self.repo / "model"),
                    "is_adapter": False,
                }
            )
        )
        with patch("forge.subprocess.run", return_value=self._sbatch_ok()) as run:
            forge.submit_serve("run-1")
        sbatch = self._sbatch_call(run)
        self.assertEqual(sbatch.kwargs["cwd"], str(self.repo))
        self.assertIn(str(self.repo), sbatch.args[0])

    def test_the_two_submitters_agree(self) -> None:
        with patch("boolback_snapshot._job_active", return_value=False), patch(
            "boolback_snapshot.subprocess.run", return_value=self._sbatch_ok()
        ) as build_run:
            boolback_snapshot.submit_build((self.out / "artifacts").resolve())
        with patch("forge.subprocess.run", return_value=self._sbatch_ok()) as train_run:
            forge.submit_train({"any": "config"}, None)
        self.assertEqual(
            self._sbatch_call(build_run).kwargs["cwd"],
            self._sbatch_call(train_run).kwargs["cwd"],
        )


def _modules_naming(env_name: str) -> list[str]:
    """Non-test modules containing the env name as a STRING LITERAL — which is what
    an ``os.environ`` read looks like. Prose in a comment or docstring is allowed;
    only a literal can actually reach the environment."""
    pattern = re.compile(r"""["']%s["']""" % re.escape(env_name))
    return [
        path.name
        for path in sorted(_MODULE_DIR.glob("*.py"))
        if not path.name.endswith("_test.py")
        and pattern.search(path.read_text(encoding="utf-8"))
    ]


class RetiredNameTest(unittest.TestCase):
    def test_no_module_reads_the_retired_name(self) -> None:
        self.assertEqual(
            _modules_naming(_RETIRED_NAME),
            [],
            f"{_RETIRED_NAME} was retired; use {cmt_repo.ENV_VAR}",
        )

    def test_only_cmt_repo_names_the_surviving_setting(self) -> None:
        # One reader, so the two surfaces cannot drift apart again.
        self.assertEqual(_modules_naming(cmt_repo.ENV_VAR), ["cmt_repo.py"])


if __name__ == "__main__":
    unittest.main()
