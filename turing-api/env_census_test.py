"""Drift guard for the environment-name census in spec.md section 14.1, and for the
one committed template the census is written down in.

Every setting this service takes from turing-api/.env has to appear in one table,
because that table is what the committed .env template is generated from and what
an operator reads before a first install. A new os.environ.get() added to any
module without a matching row here is exactly how TURING_FILE_ROOT, FORGE_NODE_DOMAIN,
BOOLBACK_CACHE_DIR and BOOLBACK_BUILD_SBATCH ended up declared in no template at all.

Three checks, in the order the drift happens: the census matches the SET OF NAMES the
code reads; secrets/turing-api.env.example declares every censused name (commented is
fine — the point is that an operator can see the name exists); and no second template
reappears beside the code, which is how turing-api/forge.env.example came to describe
the same process as the first one and disagree with it.

None of them check defaults or the prose columns.
"""
import re
import unittest
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_SPEC = _DIR / "spec.md"
_TEMPLATE = _DIR.parent / "secrets" / "turing-api.env.example"

# A name in a template is declared whether or not the line is commented out: an
# operator reads the file to learn the name exists and what its default is.
_DECLARED_RE = re.compile(r"^\s*#?\s*([A-Z][A-Z0-9_]*)=", re.M)

# Read by a wrapper on the compute node, never by Python, so it is in spec.md
# section 14.2 rather than 14.1 — but it is a tom.Quest setting and belongs in the
# template. The other 14.2 names (CUDA_HOME, PYTHONPATH) are host-level.
_SHELL_LAYER_NAMES = {"FORGE_SERVE_CONDA_ENV"}

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

    def test_template_declares_every_censused_name(self):
        declared = set(_DECLARED_RE.findall(_TEMPLATE.read_text()))
        expected = _names_in_census() | _SHELL_LAYER_NAMES
        self.assertEqual(
            expected - declared,
            set(),
            f"names in spec.md section 14.1 that {_TEMPLATE.name} does not declare",
        )
        self.assertEqual(
            declared - expected,
            set(),
            f"names declared in {_TEMPLATE.name} that no module reads any more",
        )

    def test_there_is_only_one_template(self):
        # Only templates. A real turing-api/.env is expected here on the login node.
        strays = sorted(p.name for p in _DIR.glob("*.env.example"))
        strays += sorted(p.name for p in _DIR.glob("*.env.template"))
        self.assertEqual(
            strays,
            [],
            "a second env template beside the code; the one template for this "
            "service is secrets/turing-api.env.example",
        )

    def test_census_is_not_empty(self):
        # Guards the two index() calls above silently matching a renamed section.
        self.assertGreaterEqual(len(_names_in_census()), 16)


if __name__ == "__main__":
    unittest.main()
