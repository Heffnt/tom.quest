import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import boolback_snapshot
import dirs
import forge


class CmtRootsTest(unittest.TestCase):
    """The two CMT roots — the checkout (BOOLEAN_BACKDOOR_REPO) and the artifact
    tree (BOOLEAN_BACKDOOR_OUTPUT) — are read in dirs and nowhere else, so the
    boolback snapshot surface and the Forge surface can never disagree about
    which checkout or which tree they are running against."""

    def test_both_surfaces_share_one_checkout_object(self) -> None:
        self.assertIs(forge.CMT_REPO_DIR, dirs.CMT_REPO_DIR)
        self.assertIs(boolback_snapshot.CMT_REPO_DIR, dirs.CMT_REPO_DIR)

    def test_checkout_defaults_under_home(self) -> None:
        # The default is the checkout the cluster actually uses; a login node that
        # sets nothing still submits jobs from a real repo.
        if "BOOLEAN_BACKDOOR_REPO" not in os.environ:
            self.assertEqual(
                dirs.CMT_REPO_DIR,
                str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
            )

    def test_checkout_is_a_string_for_subprocess(self) -> None:
        # Both consumers pass it as subprocess cwd= and as an sbatch argv element;
        # a Path would work for cwd= and break the argv list.
        self.assertIsInstance(dirs.CMT_REPO_DIR, str)

    def test_output_root_resolves_at_call_time(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with patch.dict("os.environ", {"BOOLEAN_BACKDOOR_OUTPUT": str(root)}):
                self.assertEqual(dirs.cmt_output_root(), root)
                # Both surfaces read that same patched value, without re-import.
                self.assertEqual(boolback_snapshot.cmt_root(), root)
                self.assertEqual(forge.forge_root(), root / "forge")

    def test_unset_output_root_raises_rather_than_defaulting(self) -> None:
        # Defaulting here would serve some other tree's data as if it were the
        # campaign's, which reads as a normal (empty) response.
        with patch.dict("os.environ", {"BOOLEAN_BACKDOOR_OUTPUT": ""}):
            with self.assertRaises(RuntimeError):
                dirs.cmt_output_root()
            with self.assertRaises(RuntimeError):
                boolback_snapshot.cmt_root()
            with self.assertRaises(RuntimeError):
                forge.forge_root()


if __name__ == "__main__":
    unittest.main()
