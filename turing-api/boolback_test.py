import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

import boolback


class ResolveInputPathConfinementTest(unittest.TestCase):
    """resolve_input_path feeds user-supplied /progress query params
    (sweep_config / expressions_file) straight to the filesystem. It must
    confine them to the project root and refuse secret-bearing paths, or an
    authenticated caller could read arbitrary files (e.g. ../../.ssh/id_rsa,
    /etc/passwd) off the host."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_relative_path_inside_root_is_allowed(self) -> None:
        resolved = boolback.resolve_input_path("sweeps/structural_n4.yaml", self.root)
        self.assertEqual(resolved, self.root / "sweeps" / "structural_n4.yaml")

    def test_relative_traversal_escape_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            boolback.resolve_input_path("../../../etc/passwd", self.root)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_absolute_escape_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            boolback.resolve_input_path("/etc/passwd", self.root)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_secret_name_inside_root_is_rejected(self) -> None:
        # A .pem/.key name is refused even though it resolves inside the root.
        with self.assertRaises(HTTPException) as ctx:
            boolback.resolve_input_path("creds/id_rsa.pem", self.root)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_secret_dir_inside_root_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            boolback.resolve_input_path(".ssh/known_hosts", self.root)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_empty_path_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            boolback.resolve_input_path("   ", self.root)
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
