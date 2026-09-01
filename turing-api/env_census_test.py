"""Drift guard for the environment-name census in spec.md section 14.1.

Every setting this service takes from turing-api/.env has to appear in one table,
because that table is what the committed .env template is generated from and what
an operator reads before a first install. A new os.environ.get() added to any
module without a matching row here is exactly how TURING_FILE_ROOT, FORGE_NODE_DOMAIN,
BOOLBACK_CACHE_DIR and BOOLBACK_BUILD_SBATCH ended up declared in no template at all.

This test only checks that the census and the code agree on the SET OF NAMES. It
deliberately does not check defaults or the "Declared in" column, which are prose.
"""
import re
import unittest
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_SPEC = _DIR / "spec.md"

# os.environ.get("X"...) / os.getenv("X"...) / os.environ["X"]
_READ_RE = re.compile(
    r"""os\.(?:environ\.get|getenv)\(\s*["'](?P<n1>[A-Z][A-Z0-9_]*)["']"""
    r"""|os\.environ\[\s*["'](?P<n2>[A-Z][A-Z0-9_]*)["']\s*\]"""
)


def _names_read_by_code() -> set[str]:
    names: set[str] = set()
    for path in sorted(_DIR.glob("*.py")):
        if path.name.endswith("_test.py"):
            continue
        for match in _READ_RE.finditer(path.read_text()):
            names.add(match.group("n1") or match.group("n2"))
    return names


def _names_in_census() -> set[str]:
    text = _SPEC.read_text()
    start = text.index("### 14.1")
    end = text.index("### 14.2", start)
    return set(re.findall(r"^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|", text[start:end], re.M))


class EnvCensusTest(unittest.TestCase):
    def test_census_lists_every_name_the_code_reads(self):
        read, censused = _names_read_by_code(), _names_in_census()
        self.assertEqual(
            read - censused,
            set(),
            "env names read by turing-api but missing from spec.md section 14.1",
        )
        self.assertEqual(
            censused - read,
            set(),
            "env names in spec.md section 14.1 that no module reads any more",
        )

    def test_census_is_not_empty(self):
        # Guards the two index() calls above silently matching a renamed section.
        self.assertGreaterEqual(len(_names_in_census()), 16)


if __name__ == "__main__":
    unittest.main()
