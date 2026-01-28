import os
import asyncio
import pty
import select
import struct
import fcntl
import termios
from fastapi import FastAPI, HTTPException, Depends, Header, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from gpu_report import parse_gpu_report, format_gpu_report, get_free_gpu_types
from slurm import allocate_gpu, cancel_job, get_user_jobs, get_job_count, MAX_GPU_ALLOCATIONS
from screens import setup_allocation_screen, cleanup_screen, get_next_screen_name, send_to_screen, screen_exists, run_command
from dirs import list_directory, get_home_dir

load_dotenv()
API_KEY = os.getenv("API_KEY", "")

app = FastAPI(title="tom-quest-api", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def verify_api_key(x_api_key: str = Header(None)):
    if not API_KEY:
        return True
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return True

class AllocationRequest(BaseModel):
    gpu_type: str
    time_mins: int
    memory_mb: int = 64000
    commands: list[str] = []
    count: int = 1
    project_dir: str = ""

class AllocationResponse(BaseModel):
    success: bool
    job_ids: list[str] = []
    screen_names: list[str] = []
    errors: list[str] = []

class JobResponse(BaseModel):
    job_id: str
    gpu_type: str
    status: str
    time_remaining: str
    time_remaining_seconds: int
    screen_name: str
    start_time: str
    end_time: str

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/screens")
async def list_screens_endpoint(auth: bool = Depends(verify_api_key)):
    from screens import list_screens
    screens = list_screens()
    tq_screens = [s for s in screens if s.startswith("tq_")]
    return {"screens": tq_screens}

@app.get("/gpu-report")
async def gpu_report(auth: bool = Depends(verify_api_key)):
    try:
        report = parse_gpu_report()
        return format_gpu_report(report)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GPU report failed: {str(e)}")

@app.get("/gpu-types")
async def gpu_types(auth: bool = Depends(verify_api_key)):
    return {"types": get_free_gpu_types()}

@app.get("/dirs")
async def list_dirs(path: str = "", auth: bool = Depends(verify_api_key)):
    if not path:
        path = get_home_dir()
    return list_directory(path)

@app.post("/allocate", response_model=AllocationResponse)
async def allocate(request: AllocationRequest, auth: bool = Depends(verify_api_key)):
    if request.count < 1:
        raise HTTPException(status_code=400, detail="Count must be at least 1")
    if request.count > MAX_GPU_ALLOCATIONS:
        raise HTTPException(status_code=400, detail=f"Max {MAX_GPU_ALLOCATIONS} GPUs allowed")
    if request.time_mins < 1:
        raise HTTPException(status_code=400, detail="Time must be at least 1 minute")
    current_jobs = get_job_count()
    if current_jobs + request.count > MAX_GPU_ALLOCATIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Would exceed max {MAX_GPU_ALLOCATIONS} GPUs. Currently have {current_jobs} allocations."
        )
    job_ids = []
    screen_names = []
    errors = []
    commands = list(request.commands)
    if request.project_dir:
        commands.insert(0, f"cd {request.project_dir}")
    for i in range(request.count):
        try:
            job_id, error = allocate_gpu(request.gpu_type, request.time_mins, request.memory_mb)
            if job_id:
                job_ids.append(job_id)
                screen_name = setup_allocation_screen(job_id, commands, request.project_dir)
                screen_names.append(screen_name)
            else:
                errors.append(error or f"Failed to allocate GPU {i+1}")
        except Exception as e:
            errors.append(f"GPU {i+1}: {str(e)}")
    return AllocationResponse(
        success=len(job_ids) > 0,
        job_ids=job_ids,
        screen_names=screen_names,
        errors=errors
    )

@app.get("/jobs", response_model=list[JobResponse])
async def list_jobs(auth: bool = Depends(verify_api_key)):
    jobs = get_user_jobs()
    return [
        JobResponse(
            job_id=job.job_id,
            gpu_type=job.gpu_type,
            status=job.status,
            time_remaining=job.time_remaining,
            time_remaining_seconds=job.time_remaining_seconds,
            screen_name=job.screen_name,
            start_time=job.start_time,
            end_time=job.end_time
        )
        for job in jobs
    ]

@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str, auth: bool = Depends(verify_api_key)):
    success, error = cancel_job(job_id)
    if success:
        cleanup_screen(job_id)
        return {"success": True, "message": f"Job {job_id} cancelled"}
    raise HTTPException(status_code=400, detail=error or f"Failed to cancel job {job_id}")

def verify_ws_api_key(api_key: str | None) -> bool:
    if not API_KEY:
        return True
    return api_key == API_KEY

@app.websocket("/ws/shell")
async def websocket_shell(websocket: WebSocket, api_key: str = Query(None)):
    if not verify_ws_api_key(api_key):
        await websocket.close(code=4001, reason="Invalid API key")
        return
    await websocket.accept()
    master_fd, slave_fd = pty.openpty()
    pid = os.fork()
    if pid == 0:
        os.close(master_fd)
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(slave_fd)
        os.execvp("bash", ["bash"])
    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    try:
        async def read_output():
            while True:
                await asyncio.sleep(0.01)
                try:
                    if select.select([master_fd], [], [], 0)[0]:
                        data = os.read(master_fd, 4096)
                        if data:
                            await websocket.send_text(data.decode("utf-8", errors="replace"))
                except OSError:
                    break
        async def write_input():
            while True:
                try:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if "text" in msg:
                        text = msg["text"]
                        if text.startswith("\x1b[8;"):
                            match = text[4:].split(";")
                            if len(match) >= 2:
                                rows = int(match[0])
                                cols = int(match[1].rstrip("t"))
                                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                        else:
                            os.write(master_fd, text.encode("utf-8"))
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
        await asyncio.gather(read_output(), write_input())
    finally:
        os.close(master_fd)
        os.kill(pid, 9)
        os.waitpid(pid, 0)

def get_screen_output(screen_name: str) -> str | None:
    if not screen_exists(screen_name):
        return None
    import tempfile
    with tempfile.NamedTemporaryFile(mode='w+', delete=False, suffix='.txt') as f:
        tmp_path = f.name
    run_command(f"screen -S {screen_name} -X hardcopy -h {tmp_path}")
    try:
        with open(tmp_path, 'r') as f:
            content = f.read()
        os.unlink(tmp_path)
        lines = content.split('\n')
        while lines and not lines[-1].strip():
            lines.pop()
        return '\n'.join(lines[-500:]) if len(lines) > 500 else '\n'.join(lines)
    except:
        return None

@app.websocket("/ws/screens/{screen_name}")
async def websocket_screen(websocket: WebSocket, screen_name: str, api_key: str = Query(None)):
    if not verify_ws_api_key(api_key):
        await websocket.close(code=4001, reason="Invalid API key")
        return
    if not screen_exists(screen_name):
        await websocket.close(code=4004, reason="Screen not found")
        return
    await websocket.accept()
    last_content = ""
    try:
        async def poll_output():
            nonlocal last_content
            while True:
                await asyncio.sleep(0.5)
                content = get_screen_output(screen_name)
                if content is not None and content != last_content:
                    last_content = content
                    await websocket.send_text(content)
                if not screen_exists(screen_name):
                    await websocket.send_text("\n[Screen session ended]")
                    break
        async def receive_input():
            while True:
                try:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if "text" in msg:
                        send_to_screen(screen_name, msg["text"])
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
        await asyncio.gather(poll_output(), receive_input())
    except WebSocketDisconnect:
        pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
