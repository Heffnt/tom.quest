import asyncio
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import termios
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from tmux import session_exists

log = logging.getLogger("tom.quest.ws")
router = APIRouter()

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

async def _read_ws(ws: WebSocket, master_fd: int, stop: asyncio.Event) -> None:
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
                rows = int(parsed.get("rows", 24))
                cols = int(parsed.get("cols", 80))
                set_winsize(master_fd, rows, cols)
                continue
        except (ValueError, TypeError):
            pass
        try:
            os.write(master_fd, text.encode("utf-8"))
        except OSError:
            break
    stop.set()

@router.websocket("/ws/sessions/{session_name}")
async def ws_session(websocket: WebSocket, session_name: str, key: str = "") -> None:
    from main import API_KEY
    if API_KEY and key != API_KEY:
        await websocket.close(code=1008, reason="Invalid key")
        return
    if not session_exists(session_name):
        await websocket.accept()
        await websocket.send_text(f"\r\n\x1b[31mSession '{session_name}' not found\x1b[0m\r\n")
        await websocket.close()
        return

    await websocket.accept()
    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, 24, 80)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(master_fd)
        os.close(slave_fd)
        os.execvp("tmux", ["tmux", "attach-session", "-t", session_name])
        os._exit(1)

    os.close(slave_fd)
    stop = asyncio.Event()
    try:
        await asyncio.gather(
            _read_pty(websocket, master_fd, stop),
            _read_ws(websocket, master_fd, stop),
        )
    finally:
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
