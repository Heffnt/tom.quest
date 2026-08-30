"""Guard: every third-party import in turing-api is declared in a requirements file.

The bug this exists to catch does not look like a missing dependency. uvicorn
ships no WebSocket implementation of its own, so a login node installed from
requirements.txt alone answered /health with 200 -- keeping the liveness poller
green -- while returning 404 Not Found to every browser-terminal connection,
because uvicorn declines the upgrade when no WebSocket library is importable.
Nothing in the test suite noticed, because the suite drives the app in-process
through httpx.ASGITransport and never opens a real socket.

So the check here is static and cheap: walk every import in the directory, drop
the standard library and the local modules, and assert what remains is declared
somewhere. clean_install_check.py covers the other half -- that a venv built
from these files really does serve a terminal.
"""

import ast
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Import name -> distribution name, for the cases where they differ.
IMPORT_TO_DISTRIBUTION = {
    "dotenv": "python-dotenv",
    "yaml": "pyyaml",
    "PIL": "pillow",
    "sklearn": "scikit-learn",
    "cv2": "opencv-python",
}

# Pulled in as a dependency of a declared package rather than declared directly.
# pydantic and starlette are hard dependencies of fastapi; installing fastapi
# without them is not possible, so pinning them here would only invite drift.
VENDORED_BY_A_DECLARED_PACKAGE = {"pydantic", "starlette"}

REQUIREMENTS_FILES = ("requirements.txt", "requirements-dev.txt", "requirements-trace.txt")


def declared_requirements(filename: str) -> dict[str, set[str]]:
    """Parse one requirements file into distribution name -> set of extras.

    Comments are stripped first. That matters: an earlier version of this file
    searched the raw text for "uvicorn[standard]", and a comment merely
    *mentioning* uvicorn[standard] silently satisfied the check.
    """
    path = HERE / filename
    requirements: dict[str, set[str]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        extras: set[str] = set()
        if "[" in line and "]" in line:
            name, _, rest = line.partition("[")
            extras = {e.strip().lower() for e in rest.partition("]")[0].split(",") if e.strip()}
            line = name + rest.partition("]")[2]
        else:
            name = line
        for separator in ("==", ">=", "<=", "~=", "!=", ">", "<", ";"):
            name = name.split(separator, 1)[0]
        requirements.setdefault(name.strip().lower(), set()).update(extras)
    return requirements


def top_level_imports(path: Path) -> set[str]:
    """Root module name of every import in a file, including function-local ones."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
    return modules


def local_module_names() -> set[str]:
    return {p.stem for p in HERE.glob("*.py")}


class RequirementsCoverTheImports(unittest.TestCase):
    def setUp(self) -> None:
        self.local = local_module_names()
        self.stdlib = sys.stdlib_module_names
        self.requirements = {name: declared_requirements(name) for name in REQUIREMENTS_FILES}
        self.declared = {name: set(reqs) for name, reqs in self.requirements.items()}
        self.all_declared = set().union(*self.declared.values())

    def _third_party_imports(self, paths) -> dict[str, set[str]]:
        """Map distribution name -> set of files importing it."""
        found: dict[str, set[str]] = {}
        for path in paths:
            for module in top_level_imports(path):
                if module in self.stdlib or module in self.local:
                    continue
                if module in VENDORED_BY_A_DECLARED_PACKAGE:
                    continue
                distribution = IMPORT_TO_DISTRIBUTION.get(module, module).lower()
                found.setdefault(distribution, set()).add(path.name)
        return found

    def test_every_requirements_file_exists(self) -> None:
        for name in REQUIREMENTS_FILES:
            self.assertTrue((HERE / name).is_file(), f"{name} is missing")

    def test_no_third_party_import_is_undeclared(self) -> None:
        paths = sorted(HERE.glob("*.py"))
        undeclared = {
            dist: sorted(files)
            for dist, files in self._third_party_imports(paths).items()
            if dist not in self.all_declared
        }
        self.assertEqual(
            undeclared,
            {},
            "third-party imports declared in no requirements file: "
            f"{undeclared}. Add each to requirements.txt (service), "
            "requirements-dev.txt (tests only) or requirements-trace.txt "
            "(GPU-node trace server).",
        )

    def test_service_modules_are_covered_by_requirements_txt_alone(self) -> None:
        """The login-node install is requirements.txt only -- it must be sufficient.

        Everything reachable from main.py has to be there. transformer_server.py
        is excluded because it runs on a compute node, and *_test.py because the
        service does not import its tests.
        """
        paths = [
            p
            for p in sorted(HERE.glob("*.py"))
            if not p.name.endswith("_test.py")
            and p.name not in {"transformer_server.py", "clean_install_check.py"}
        ]
        service_requirements = self.declared["requirements.txt"]
        missing = {
            dist: sorted(files)
            for dist, files in self._third_party_imports(paths).items()
            if dist not in service_requirements
        }
        self.assertEqual(
            missing,
            {},
            f"service modules import packages requirements.txt does not declare: {missing}",
        )

    def test_websocket_implementation_is_declared_for_the_terminal_route(self) -> None:
        """A WebSocket route with no WebSocket library is a 404, not a crash.

        uvicorn has no WebSocket protocol implementation of its own. If ws.py
        registers a route, requirements.txt must carry an implementation --
        directly, or through uvicorn's "standard" extra.
        """
        registers_websocket_route = "@router.websocket" in (HERE / "ws.py").read_text(encoding="utf-8")
        self.assertTrue(registers_websocket_route, "ws.py no longer registers a WebSocket route")

        service = self.requirements["requirements.txt"]
        has_implementation = (
            "websockets" in service
            or "wsproto" in service
            or "standard" in service.get("uvicorn", set())
        )
        self.assertTrue(
            has_implementation,
            "ws.py serves a WebSocket but requirements.txt declares no implementation. "
            "uvicorn alone answers every terminal connection with 404 Not Found while "
            "/health stays 200, so the liveness poller will not catch this. "
            "Add 'websockets', 'wsproto', or use uvicorn[standard].",
        )

    def test_trace_server_dependencies_are_not_in_the_login_node_install(self) -> None:
        """torch belongs to the compute node, not to the login-node service.

        Guards the split in the other direction: if torch reappears in
        requirements.txt, every login-node install starts pulling a
        multi-gigabyte CUDA wheel for a process that box never runs.
        """
        service_requirements = self.declared["requirements.txt"]
        for heavy in ("torch", "transformers"):
            self.assertNotIn(
                heavy,
                service_requirements,
                f"{heavy} is a transformer_server.py dependency and belongs in "
                "requirements-trace.txt; the login node never runs that process.",
            )

    def test_transformer_server_imports_are_declared_in_the_trace_file(self) -> None:
        found = self._third_party_imports([HERE / "transformer_server.py"])
        trace_requirements = self.declared["requirements-trace.txt"]
        missing = sorted(dist for dist in found if dist not in trace_requirements)
        self.assertEqual(
            missing,
            [],
            f"transformer_server.py imports packages requirements-trace.txt omits: {missing}",
        )


if __name__ == "__main__":
    unittest.main()
