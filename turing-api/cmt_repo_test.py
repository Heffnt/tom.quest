"""The CMT checkout is one directory read from one name.

The bug these tests hold shut: forge.py and boolback_snapshot.py each read their
own environment variable for the same ComplexMultiTrigger checkout, with the
same default, so setting only one made the Forge jobs and the snapshot build
submit from different checkouts with no error anywhere.
"""
import os
import unittest
from pathlib import Path
from unittest import mock

import cmt_repo


def _env(**values):
    """Patch the two names for the duration of a `with`, None meaning 'unset'.

    mock.patch.dict cannot remove a key, so the whole environment is replaced
    (clear=True) with a copy that has the None-valued names dropped; the real
    environment is restored on exit either way.
    """
    replacement = {
        key: value
        for key, value in os.environ.items()
        if key not in values
    }
    replacement.update({k: v for k, v in values.items() if v is not None})
    return mock.patch.dict(os.environ, replacement, clear=True)


class CmtRepoDirTest(unittest.TestCase):
    def setUp(self):
        # The warn-once cache is process-global; a stale entry would hide a
        # warning another test is asserting on.
        cmt_repo._warned.clear()

    def test_surviving_name_is_used(self):
        with _env(BOOLEAN_BACKDOOR_REPO="/repos/cmt", BOOLBACK_BUILDER_REPO_DIR=None):
            self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/cmt")

    def test_deprecated_alias_is_used_when_the_surviving_name_is_unset(self):
        with _env(BOOLEAN_BACKDOOR_REPO=None, BOOLBACK_BUILDER_REPO_DIR="/repos/old"):
            with self.assertLogs("tom.quest.cmt_repo", level="WARNING") as logs:
                self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/old")
        joined = "\n".join(logs.output)
        self.assertIn("BOOLBACK_BUILDER_REPO_DIR", joined)
        self.assertIn("BOOLEAN_BACKDOOR_REPO", joined)

    def test_surviving_name_wins_over_the_alias_and_the_conflict_is_logged(self):
        with _env(BOOLEAN_BACKDOOR_REPO="/repos/new", BOOLBACK_BUILDER_REPO_DIR="/repos/old"):
            with self.assertLogs("tom.quest.cmt_repo", level="WARNING"):
                self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/new")

    def test_matching_values_are_not_reported_as_a_conflict(self):
        with _env(BOOLEAN_BACKDOOR_REPO="/repos/cmt", BOOLBACK_BUILDER_REPO_DIR="/repos/cmt"):
            with mock.patch.object(cmt_repo.logger, "warning") as warned:
                self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/cmt")
            warned.assert_not_called()

    def test_blank_values_count_as_unset(self):
        with _env(BOOLEAN_BACKDOOR_REPO="   ", BOOLBACK_BUILDER_REPO_DIR="  "):
            self.assertEqual(
                cmt_repo.cmt_repo_dir(),
                str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
            )

    def test_default_when_neither_name_is_set(self):
        with _env(BOOLEAN_BACKDOOR_REPO=None, BOOLBACK_BUILDER_REPO_DIR=None):
            self.assertEqual(
                cmt_repo.cmt_repo_dir(),
                str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
            )

    def test_resolution_is_per_call_not_per_import(self):
        with _env(BOOLEAN_BACKDOOR_REPO="/repos/one", BOOLBACK_BUILDER_REPO_DIR=None):
            self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/one")
        with _env(BOOLEAN_BACKDOOR_REPO="/repos/two", BOOLBACK_BUILDER_REPO_DIR=None):
            self.assertEqual(cmt_repo.cmt_repo_dir(), "/repos/two")


class OneCheckoutForBothSurfacesTest(unittest.TestCase):
    """Neither submitting module may keep a second reader of its own."""

    def setUp(self):
        cmt_repo._warned.clear()

    def test_forge_and_boolback_submit_from_the_same_directory(self):
        import boolback_snapshot
        import forge

        with _env(BOOLEAN_BACKDOOR_REPO="/repos/shared", BOOLBACK_BUILDER_REPO_DIR=None):
            self.assertEqual(forge.cmt_repo_dir(), "/repos/shared")
            self.assertEqual(boolback_snapshot.cmt_repo_dir(), "/repos/shared")

    def test_neither_module_reads_the_repo_env_names_itself(self):
        here = Path(__file__).resolve().parent
        for name in ("forge.py", "boolback_snapshot.py"):
            source = (here / name).read_text()
            for env_name in (cmt_repo.CANONICAL_ENV, cmt_repo.DEPRECATED_ENV):
                self.assertNotIn(
                    f'"{env_name}"',
                    source,
                    f"{name} reads {env_name} directly instead of cmt_repo.cmt_repo_dir()",
                )


if __name__ == "__main__":
    unittest.main()
