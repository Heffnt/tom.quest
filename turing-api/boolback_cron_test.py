"""Regression guard for boolback_cron.sh's target URL.

The script posts to the API on the login node's loopback address. The port it
posts to is configurable — main.py:30 reads API_PORT from turing-api/.env and
uvicorn binds that — and the script used to hardcode 8000, so an operator who
took the documented override got a cron that silently posted to a closed port
while the site's own snapshot went stale with no failing check anywhere.

Each test runs the real script under a temporary HOME holding a temporary .env,
with a `curl` stub first on PATH that records the command line instead of
issuing a request. What is asserted is the URL the script built.
"""
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent / "boolback_cron.sh"


def _run_with_env_file(env_text: str) -> str:
    """Run boolback_cron.sh against an .env holding env_text. Returns the
    single curl command line the script issued, as one string."""
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        env_dir = home / "tom.quest" / "turing-api"
        env_dir.mkdir(parents=True)
        (env_dir / ".env").write_text(env_text)

        bin_dir = home / "bin"
        bin_dir.mkdir()
        recorded = home / "curl-args.txt"
        stub = bin_dir / "curl"
        stub.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/bash
                printf '%s\\n' "$*" >> {recorded}
                echo '{{"status": "submitted"}}'
                """
            )
        )
        stub.chmod(0o755)

        env = dict(os.environ)
        env["HOME"] = str(home)
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        proc = subprocess.run(
            ["bash", str(_SCRIPT)], env=env, capture_output=True, text=True, timeout=60
        )
        assert proc.returncode == 0, proc.stderr
        return recorded.read_text().strip()


class BoolbackCronUrlTest(unittest.TestCase):
    def test_uses_api_port_from_the_env_file(self):
        line = _run_with_env_file("TURING_API_KEY=secret\nAPI_PORT=9123\n")
        self.assertIn("http://127.0.0.1:9123/boolback-snapshot?dir=artifacts", line)
        self.assertNotIn("127.0.0.1:8000", line)

    def test_defaults_to_8000_when_api_port_is_absent(self):
        line = _run_with_env_file("TURING_API_KEY=secret\n")
        self.assertIn("http://127.0.0.1:8000/boolback-snapshot?dir=artifacts", line)

    def test_commented_and_empty_api_port_both_fall_back_to_8000(self):
        # secrets/turing-api.env.example ships the name commented out, and an
        # operator who uncomments it without typing a value leaves it empty.
        for env_text in (
            "TURING_API_KEY=secret\n# API_PORT=9123\n",
            "TURING_API_KEY=secret\nAPI_PORT=\n",
        ):
            with self.subTest(env_text=env_text):
                line = _run_with_env_file(env_text)
                self.assertIn("http://127.0.0.1:8000/boolback-snapshot", line)

    def test_last_assignment_wins_like_python_dotenv(self):
        line = _run_with_env_file("TURING_API_KEY=secret\nAPI_PORT=8100\nAPI_PORT=8200\n")
        self.assertIn("http://127.0.0.1:8200/boolback-snapshot", line)

    def test_sends_the_api_key_from_the_env_file(self):
        line = _run_with_env_file("TURING_API_KEY=secret\nAPI_PORT=9123\n")
        self.assertIn("X-API-Key: secret", line)

    def test_script_hardcodes_no_port(self):
        # The failure this file exists for, checked directly on the source: any
        # literal 127.0.0.1:<digits> means the URL stopped following the config.
        import re

        self.assertIsNone(
            re.search(r"127\.0\.0\.1:\d+", _SCRIPT.read_text()),
            "boolback_cron.sh must build its port from API_PORT, not hardcode one",
        )


if __name__ == "__main__":
    unittest.main()
