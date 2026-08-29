import tempfile
import unittest
from pathlib import Path

from dirs import PathNotAllowed, resolve_within_root


class ResolveWithinRootTest(unittest.TestCase):
    """resolve_within_root is the one confinement primitive every path-taking
    endpoint funnels through (/cmt-node, /cmt-file, /boolback-snapshot*, /forge/*).
    These cases used to be asserted through the /file and /dirs endpoints; those
    were deleted as uncalled, so the coverage lives on the primitive itself and no
    longer depends on any endpoint existing."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / "ok.txt").write_text("hello")
        (self.root / ".env").write_text("SECRET=1")
        (self.root / "id.pem").write_text("KEY")
        (self.root / ".ssh").mkdir()
        (self.root / ".ssh" / "id_rsa").write_text("KEY")
        self.nested = self.root / "nested"
        self.nested.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_absolute_path_inside_root_resolves(self) -> None:
        self.assertEqual(
            resolve_within_root(str(self.root / "ok.txt"), root=self.root),
            self.root / "ok.txt",
        )

    def test_relative_path_is_taken_from_root(self) -> None:
        self.assertEqual(resolve_within_root("nested", root=self.root), self.nested)

    def test_root_itself_is_allowed(self) -> None:
        self.assertEqual(resolve_within_root(str(self.root), root=self.root), self.root)

    def test_rejects_absolute_path_outside_root(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root("/etc/passwd", root=self.root)

    def test_rejects_traversal_escape(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root(f"{self.root}/../../../etc/passwd", root=self.root)

    def test_rejects_relative_traversal_escape(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root("../../etc/passwd", root=self.root)

    def test_rejects_symlink_escape(self) -> None:
        link = self.root / "escape"
        link.symlink_to("/etc")
        with self.assertRaises(PathNotAllowed):
            resolve_within_root(str(link / "passwd"), root=self.root)

    def test_rejects_env_file_inside_root(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root(str(self.root / ".env"), root=self.root)

    def test_rejects_private_key_inside_root(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root(str(self.root / "id.pem"), root=self.root)

    def test_rejects_restricted_directory_inside_root(self) -> None:
        with self.assertRaises(PathNotAllowed):
            resolve_within_root(str(self.root / ".ssh" / "id_rsa"), root=self.root)

    def test_root_is_required(self) -> None:
        # There is deliberately no default root: a new endpoint must name its own
        # jail rather than inherit a wide one (the deleted /file and /dirs default
        # was $HOME).
        with self.assertRaises(TypeError):
            resolve_within_root("ok.txt")  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
