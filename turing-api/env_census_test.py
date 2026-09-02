"""Drift guard tying three things together: the code, the census in spec.md
section 14, and the one committed template secrets/turing-api.env.example.

Every setting this service takes from turing-api/.env has to appear in one table
and in one template, because those are what an operator reads before a first
install. A new os.environ.get() added to any module without a matching row is
exactly how TURING_FILE_ROOT, FORGE_NODE_DOMAIN, BOOLBACK_CACHE_DIR and
BOOLBACK_BUILD_SBATCH ended up declared in no template at all, and a name added to
main.py without a row is how TURING_READ_KEY did the same thing later.

These tests check the SET OF NAMES three ways round. They deliberately do not check
defaults or the prose columns.

Removing a name from the code is therefore a THREE-file change: the reader, the
census row, and the template line. A failure naming a name in the template that no
module reads is that reminder, not a mistake in the template.
"""
import re
import unittest
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_SPEC = _DIR / "spec.md"
_TEMPLATE = _DIR.parent / "secrets" / "turing-api.env.example"

# A declaration line in the template: NAME=value, optionally commented out.
_DECL_RE = re.compile(r"^#?\s*(?P<name>[A-Z][A-Z0-9_]*)=(?P<value>.*)$", re.M)

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


def _names_in_census(section: str = "### 14.1", until: str = "### 14.2") -> set[str]:
    text = _SPEC.read_text()
    start = text.index(section)
    end = text.index(until, start)
    return set(re.findall(r"^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|", text[start:end], re.M))


def _template_declarations() -> dict[str, str]:
    """Name -> value for every line of the template, commented lines included."""
    return {m.group("name"): m.group("value") for m in _DECL_RE.finditer(_TEMPLATE.read_text())}


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
        self.assertGreaterEqual(len(_names_in_census()), 17)


class TemplateTest(unittest.TestCase):
    """The template is the operator-facing form of the census; one file, all names."""

    def test_template_declares_every_censused_name(self):
        missing = _names_in_census() - set(_template_declarations())
        self.assertEqual(
            missing,
            set(),
            f"censused env names missing from {_TEMPLATE.name} — an operator "
            "cannot reproduce the deployed config from the repository without them",
        )

    def test_template_declares_nothing_unread(self):
        # The shell layer (section 14.2) reads names Python never does; those are
        # legitimate template entries. Anything else is a leftover.
        known = _names_in_census() | _names_in_census("### 14.2", "### 14.3")
        self.assertEqual(
            set(_template_declarations()) - known,
            set(),
            f"{_TEMPLATE.name} declares env names no module and no sbatch wrapper "
            "reads — delete the line, or add the row it is missing",
        )

    def test_template_values_use_the_braced_form(self):
        # python-dotenv interpolates ${HOME}; a bare $HOME stays four literal
        # characters and yields a path naming no directory. forge.env.example
        # shipped that bug on its BOOLEAN_BACKDOOR_REPO line for its whole life.
        bare = {
            name: value
            for name, value in _template_declarations().items()
            if re.search(r"\$(?!\{)", value)
        }
        self.assertEqual(
            bare,
            {},
            "template values with an unbraced $: python-dotenv will not expand them",
        )

    def test_there_is_exactly_one_template(self):
        strays = sorted(p.name for p in _DIR.glob("*.env*"))
        self.assertEqual(
            strays,
            [],
            "a second .env template beside the code — turing-api/.env has one "
            f"template, {_TEMPLATE}",
        )


if __name__ == "__main__":
    unittest.main()
