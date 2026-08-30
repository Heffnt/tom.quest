#!/usr/bin/env python3
"""Prove a clean install can actually serve the browser terminal.

Why this exists
---------------
`requirements.txt` is what README presents as the whole first-time setup on the
Turing login node. Every other surface of this service is plain HTTP, so a
missing dependency shows up immediately -- but the terminal is a WebSocket, and
uvicorn ships no WebSocket implementation unless one is installed alongside it.
The consequence is invisible to every check we run: `/health` answers, the
Convex poller reports the API live, and every terminal connection fails at the
handshake with 500 Internal Server Error.

`requirements_test.py` guards the *declaration* (every third-party import is in
a requirements file). This script guards the *installation*: it builds a fresh
virtual environment from `requirements.txt` alone, boots the service out of it,
and drives one real terminal session end to end.

The WebSocket client here is hand-rolled on top of a raw socket and the standard
library only. That is deliberate. A client that imported `websockets` would pull
the very library under test into the process and could pass while the server's
own environment lacked it.

Usage
-----
    python3 turing-api/clean_install_check.py                 # full clean-venv run
    python3 turing-api/clean_install_check.py --no-venv       # use the current interpreter

Exit status is 0 only if the handshake returns 101 and a command typed into the
socket comes back out of it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import re
import shutil
import socket
import string
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
API_KEY = "clean-install-check-key"
MARKER = "TERMINAL_ROUND_TRIP_OK"


# --- tiny stdlib WebSocket client ---------------------------------------------


def _mint_token(session_name: str, secret: str) -> str:
    """Build the HMAC token ws.py:verify_ws_token accepts.

    Shape: base64url(payload_json).base64url(hmac_sha256(secret, payload_b64)),
    payload {"uid","sid","exp"} with exp in milliseconds since the epoch.
    """
    payload = json.dumps(
        {"uid": "clean-install-check", "sid": session_name, "exp": int(time.time() * 1000) + 60_000}
    ).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).digest()
    return f"{payload_b64}.{base64.urlsafe_b64encode(sig).decode().rstrip('=')}"


def _ws_connect(host: str, port: int, path: str, timeout: float = 10.0) -> tuple[int, socket.socket | None]:
    """Perform an RFC 6455 opening handshake. Returns (http_status, socket|None)."""
    key = base64.b64encode(bytes(random.getrandbits(8) for _ in range(16))).decode()
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock = socket.create_connection((host, port), timeout)
    sock.sendall(request.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    match = re.match(rb"HTTP/1\.[01] (\d{3})", buf)
    status = int(match.group(1)) if match else 0
    if status != 101:
        sock.close()
        return status, None
    return status, sock


def _send_text(sock: socket.socket, text: str) -> None:
    """Write one masked client text frame. Payloads here are always short."""
    payload = text.encode("utf-8")
    mask = bytes(random.getrandbits(8) for _ in range(4))
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    header = bytes([0x81, 0x80 | len(payload)])  # FIN+text, MASK set, 7-bit length
    sock.sendall(header + mask + masked)


def _read_frames(sock: socket.socket, deadline: float) -> bytes:
    """Drain server frames until the deadline, returning concatenated payloads.

    Servers never mask, and the terminal's frames are far below the 64 KiB the
    two-byte extended length covers, so only the 7-bit and 16-bit length forms
    are handled.
    """
    out = b""

    def recv_exactly(n: int) -> bytes:
        got = b""
        while len(got) < n:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError
            sock.settimeout(remaining)
            chunk = sock.recv(n - len(got))
            if not chunk:
                raise ConnectionError
            got += chunk
        return got

    while time.time() < deadline:
        try:
            head = recv_exactly(2)
        except (TimeoutError, socket.timeout, ConnectionError, OSError):
            break
        opcode = head[0] & 0x0F
        length = head[1] & 0x7F
        try:
            if length == 126:
                length = int.from_bytes(recv_exactly(2), "big")
            elif length == 127:
                length = int.from_bytes(recv_exactly(8), "big")
            payload = recv_exactly(length) if length else b""
        except (TimeoutError, socket.timeout, ConnectionError, OSError):
            break
        if opcode == 0x8:  # close
            break
        if opcode in (0x1, 0x2, 0x0):
            out += payload
        if MARKER.encode() in out:
            break
    return out


# --- the check ----------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def build_clean_venv(venv_dir: Path) -> Path:
    """Create a venv holding exactly what requirements.txt declares."""
    if venv_dir.exists():
        shutil.rmtree(venv_dir)
    print(f"[check] building clean venv at {venv_dir}")
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv_dir)], check=True)
    python = venv_dir / "bin" / "python3"
    subprocess.run(
        [sys.executable, "-m", "pip", "--python", str(python), "install", "-q",
         "-r", str(HERE / "requirements.txt")],
        check=True,
    )
    return python


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-venv", action="store_true",
                        help="run against the current interpreter instead of a fresh venv")
    parser.add_argument("--venv-dir", default=str(HERE.parent / ".cleanroom-venv"))
    args = parser.parse_args()

    if not shutil.which("tmux"):
        print("[check] FAIL: tmux is not on PATH; the terminal route cannot be exercised")
        return 2

    python = Path(sys.executable) if args.no_venv else build_clean_venv(Path(args.venv_dir))

    suffix = "".join(random.choice(string.ascii_lowercase) for _ in range(6))
    session = f"cleancheck-{suffix}"
    port = _free_port()
    subprocess.run(["tmux", "new-session", "-d", "-s", session], check=True)

    env = dict(os.environ, TURING_API_KEY=API_KEY, API_PORT=str(port))
    server = subprocess.Popen(
        [str(python), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    try:
        # Wait for /health, the same endpoint the Convex poller uses. It answers
        # whether or not a WebSocket implementation is installed -- which is the
        # whole reason this script has to go further than /health.
        healthy = False
        for _ in range(100):
            if server.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", port), 0.5) as s:
                    s.sendall(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                    if b"200" in s.recv(200):
                        healthy = True
                        break
            except OSError:
                time.sleep(0.2)
        if not healthy:
            print("[check] FAIL: service never became healthy")
            print((server.stdout.read() if server.stdout else "")[-3000:])
            return 2
        print(f"[check] /health answers on port {port} (this is all the liveness poller checks)")

        token = _mint_token(session, API_KEY)
        path = f"/ws/sessions/{session}?key={token}&cols=80&rows=24"
        status, sock = _ws_connect("127.0.0.1", port, path)
        if sock is None:
            print(f"[check] FAIL: terminal handshake returned HTTP {status}, expected 101")
            print("[check] server log tail:")
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
            print((server.stdout.read() if server.stdout else "")[-2000:])
            return 1
        print("[check] terminal handshake returned 101 Switching Protocols")

        with sock:
            _send_text(sock, f"echo {MARKER}\n")
            data = _read_frames(sock, deadline=time.time() + 15)
        if MARKER.encode() not in data:
            print("[check] FAIL: handshake succeeded but no shell output came back")
            print(f"[check] received {len(data)} bytes: {data[:400]!r}")
            return 1
        print(f"[check] shell round trip confirmed ({len(data)} bytes back through the socket)")
        print("[check] PASS: a clean install serves the browser terminal")
        return 0
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        subprocess.run(["tmux", "kill-session", "-t", session],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    sys.exit(main())
