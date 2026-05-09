import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import logging
import os
import pty
import signal
import struct
import termios
import time
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from tmux import resize_session_window, session_exists

log = logging.getLogger("tom.quest.ws")
router = APIRouter()


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def verify_ws_token(token: str, secret: str) -> dict | None:
    """Verify a Next-issued HMAC token. Returns payload dict on success, None on failure.

    Token shape: <base64url(json_payload)>.<base64url(hmac_sha256(secret, payload_b64))>
    Payload: {"uid": string, "sid": string, "exp": ms_epoch}
    """
    if not token or "." not in token:
        return None
    payload_b64, sig_b64 = token.split(".", 1)
    expected = hmac.new(
        secret.encode("utf-8"),
        payload_b64.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    try:
        actual = _b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected, actual):
        return None
    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < int(time.time() * 1000):
        return None
    return payload


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

async def _read_pty(ws: WebSocket, master_fd: int, stop: asyncio.Event) -> None:
    loop = asyncio.get_event_loop()
    while not stop.is_set():
        try:
            data = await loop.run_in_executor(None, os.read, master_fd, 4096)
        except OSError:
            break
        if not data:
            break
        try:
            await ws.send_bytes(data)
        except Exception:
            break
    stop.set()

def normalize_size(rows: int, cols: int) -> tuple[int, int]:
    return max(rows, 2), max(cols, 20)

async def _read_ws(ws: WebSocket, session_name: str, master_fd: int, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            msg = await ws.receive()
        except WebSocketDisconnect:
            break
        if msg.get("type") == "websocket.disconnect":
            break
        if "bytes" in msg and msg["bytes"] is not None:
            try:
                os.write(master_fd, msg["bytes"])
            except OSError:
                break
            continue
        text = msg.get("text")
        if text is None:
            continue
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and parsed.get("type") == "resize":
                rows, cols = normalize_size(
                    int(parsed.get("rows", 24)),
                    int(parsed.get("cols", 80)),
                )
                set_winsize(master_fd, rows, cols)
                resize_session_window(session_name, cols, rows)
                log.info("Resized tmux session %s to %sx%s", session_name, cols, rows)
                continue
        except (ValueError, TypeError):
            pass
        try:
            os.write(master_fd, text.encode("utf-8"))
        except OSError:
            break
    stop.set()

@router.websocket("/ws/sessions/{session_name}")
async def ws_session(
    websocket: WebSocket,
    session_name: str,
    key: str = "",
    cols: int = 80,
    rows: int = 24,
) -> None:
    from main import API_KEY
    if not API_KEY:
        await websocket.close(code=1011, reason="Server not configured")
        return
    payload = verify_ws_token(key, API_KEY)
    if not payload:
        await websocket.close(code=1008, reason="Invalid or expired token")
        return
    if payload.get("sid") != session_name:
        await websocket.close(code=1008, reason="Token session mismatch")
        return
    if not session_exists(session_name):
        await websocket.accept()
        await websocket.send_text(f"\r\n\x1b[31mSession '{session_name}' not found\x1b[0m\r\n")
        await websocket.close()
        return

    await websocket.accept()
    master_fd, slave_fd = pty.openpty()
    rows, cols = normalize_size(rows, cols)
    set_winsize(master_fd, rows, cols)
    resize_session_window(session_name, cols, rows)
    log.info("Opening tmux session %s at %sx%s for user %s", session_name, cols, rows, payload.get("uid"))
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(master_fd)
        os.close(slave_fd)
        os.execvp("tmux", ["tmux", "-u", "attach-session", "-t", session_name])
        os._exit(1)

    os.close(slave_fd)
    stop = asyncio.Event()
    try:
        await asyncio.gather(
            _read_pty(websocket, master_fd, stop),
            _read_ws(websocket, session_name, master_fd, stop),
        )
    finally:
        log.info("Closing tmux websocket for %s", session_name)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
