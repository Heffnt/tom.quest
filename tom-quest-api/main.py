import logging
import os
import re
import signal
import socket
import shlex
import subprocess
import threading
import time
import uuid
import requests
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from gpu_report import format_gpu_report_v2, get_free_gpu_type_info
from slurm import allocate_gpu, cancel_job, get_user_jobs
from tmux import (
    setup_allocation_session,
    cleanup_session,
    capture_output,
    session_exists,
    count_session_clients,
    detach_session_clients,
)
from job_screens import get_screen_name, remove_screen_mapping
from dirs import list_directory, get_home_dir
from boolback import router as boolback_router
from ws import router as ws_router

load_dotenv()
API_PORT = int(os.getenv("API_PORT", "8000"))
TOM_QUEST_URL = os.getenv("TOM_QUEST_URL", "https://tom.quest")
CONVEX_SITE_URL = os.getenv("CONVEX_SITE_URL", "")
TURING_REGISTRATION_SECRET = os.getenv("TURING_REGISTRATION_SECRET", "")
KEY_FILE = os.path.expanduser("~/.tom-quest-key")
LOG_PATH = "tom-quest-api.log"
TUNNEL_LOG_PATH = "tom-quest-tunnel.log"
HEARTBEAT_INTERVAL = 30  # seconds
TUNNEL_HEALTH_INTERVAL = 15  # seconds between origin reachability probes
TUNNEL_HEALTH_FAIL_THRESHOLD = 2  # consecutive failures before restarting cloudflared
CLOUDFLARED_BOOT_GRACE = 8  # seconds to wait for cloudflared to print its URL after spawn

# Global state
API_KEY = ""
TUNNEL_URL = ""
TUNNEL_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler()],
    )
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True

def load_or_generate_key() -> str:
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r") as f:
            key = f.read().strip()
        if key:
            return key
    key = str(uuid.uuid4())
    with open(KEY_FILE, "w") as f:
        f.write(key)
    print(f"\n{'='*60}")
    print(f"  New connection key generated!")
    print(f"  Key: {key}")
    print(f"  Saved to: {KEY_FILE}")
    print(f"\n  Enter this key on tom.quest/turing to connect.")
    print(f"{'='*60}\n")
    return key

def register_with_tom_quest(key: str, url: str) -> bool:
    if not CONVEX_SITE_URL:
        print("CONVEX_SITE_URL is required for Turing registration")
        return False
    if not TURING_REGISTRATION_SECRET:
        print("TURING_REGISTRATION_SECRET is required for Turing registration")
        return False
    try:
        res = requests.post(
            f"{CONVEX_SITE_URL}/api/turing/register",
            headers={"Authorization": f"Bearer {TURING_REGISTRATION_SECRET}"},
            json={"key": key, "url": url},
            timeout=10,
        )
        if res.ok:
            return True
        print(f"Registration failed: {res.status_code} {res.text}")
    except Exception as e:
        print(f"Registration error: {e}")
    return False

def heartbeat_loop(key: str):
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        url = TUNNEL_URL
        if url:
            register_with_tom_quest(key, url)

def latest_tunnel_url_from_log() -> str | None:
    try:
        with open(TUNNEL_LOG_PATH) as f:
            content = f.read()
    except FileNotFoundError:
        return None
    matches = TUNNEL_URL_PATTERN.findall(content)
    return matches[-1] if matches else None

def spawn_cloudflared(port: int) -> subprocess.Popen | None:
    log_file = open(TUNNEL_LOG_PATH, "w", buffering=1)
    try:
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"],
            stdout=log_file,
            stderr=log_file,
        )
    except Exception:
        log_file.close()
        logging.getLogger("tom.quest.tunnel").exception("cloudflared spawn failed")
        return None
    print(f"cloudflared started (pid {proc.pid}). URL log: {TUNNEL_LOG_PATH}")
    return proc

def stop_cloudflared(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception:
        logging.getLogger("tom.quest.tunnel").exception("cloudflared stop failed")

def tunnel_health_ok(url: str) -> bool:
    try:
        res = requests.get(f"{url}/health", timeout=10)
    except Exception as exc:
        logging.getLogger("tom.quest.tunnel").info("tunnel health probe failed: %s", exc)
        return False
    return res.ok

def tunnel_manager_loop(key: str, port: int, initial_proc: subprocess.Popen | None):
    """Keep cloudflared healthy: pick up URL changes, probe origin reachability, restart on failure."""
    global TUNNEL_URL
    log = logging.getLogger("tom.quest.tunnel")
    log.info(
        "tunnel manager started (probe every %ds, restart after %d failures)",
        TUNNEL_HEALTH_INTERVAL, TUNNEL_HEALTH_FAIL_THRESHOLD,
    )
    proc = initial_proc
    consecutive_failures = 0
    # Give the initial cloudflared a moment to print its URL before the first probe.
    time.sleep(CLOUDFLARED_BOOT_GRACE)

    while True:
        # Spawn cloudflared if missing or dead.
        if proc is None or proc.poll() is not None:
            if proc is not None:
                log.warning("cloudflared exited (code=%s); respawning", proc.returncode)
            TUNNEL_URL = ""
            consecutive_failures = 0
            proc = spawn_cloudflared(port)
            if proc is None:
                time.sleep(TUNNEL_HEALTH_INTERVAL)
                continue
            time.sleep(CLOUDFLARED_BOOT_GRACE)

        # Refresh TUNNEL_URL from the latest entry in cloudflared's log.
        latest = latest_tunnel_url_from_log()
        if latest and latest != TUNNEL_URL:
            TUNNEL_URL = latest
            log.info("tunnel URL updated: %s", TUNNEL_URL)
            register_with_tom_quest(key, TUNNEL_URL)
            consecutive_failures = 0

        # Probe the public tunnel; 530 / connection failure means cloudflared
        # is no longer registered with Cloudflare's edge even though the
        # subprocess may still be running.
        if TUNNEL_URL:
            if tunnel_health_ok(TUNNEL_URL):
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                log.warning(
                    "tunnel unreachable via %s (%d/%d)",
                    TUNNEL_URL, consecutive_failures, TUNNEL_HEALTH_FAIL_THRESHOLD,
                )

        if consecutive_failures >= TUNNEL_HEALTH_FAIL_THRESHOLD:
            log.warning("restarting cloudflared after %d consecutive failures", consecutive_failures)
            stop_cloudflared(proc)
            proc = None  # respawn next iteration
            continue

        time.sleep(TUNNEL_HEALTH_INTERVAL)

def find_free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port in range {preferred}-{preferred + 99}")

def start_tunnel(key: str, port: int):
    proc = spawn_cloudflared(port)
    threading.Thread(target=tunnel_manager_loop, args=(key, port, proc), daemon=True).start()
    threading.Thread(target=heartbeat_loop, args=(key,), daemon=True).start()
    return proc

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


app.include_router(boolback_router, dependencies=[Depends(verify_api_key)])
app.include_router(ws_router)

class AllocationRequest(BaseModel):
    gpu_type: str
    time_mins: int
    memory_mb: int = 64000
    commands: list[str] = []
    count: int = 1
    project_dir: str = ""
    job_name: str = "allocation"

class AllocationResponse(BaseModel):
    success: bool
    job_ids: list[str] = []
    screen_names: list[str] = []
    errors: list[str] = []


class JobGpuStatsResponse(BaseModel):
    memory_used_mb: int
    memory_total_mb: int
    temperature_c: int | None = None
    utilization_pct: int | None = None

class JobResponse(BaseModel):
    job_id: str
    gpu_type: str
    status: str
    time_remaining: str
    time_remaining_seconds: int
    screen_name: str
    start_time: str
    end_time: str
    gpu_stats: JobGpuStatsResponse | None = None

class SessionClientsResponse(BaseModel):
    attached_clients: int

class DetachClientsResponse(BaseModel):
    success: bool
    detached_clients: int

def resolve_allocation_count(request: AllocationRequest) -> int:
    if request.count > 0:
        return request.count
    for item in get_free_gpu_type_info():
        if item["type"] == request.gpu_type:
            return item["count"] or 1
    return 1

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/gpu-report")
async def gpu_report(auth: bool = Depends(verify_api_key)) -> dict:
    try:
        return format_gpu_report_v2()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GPU report failed: {str(e)}")

@app.get("/gpu-types")
async def gpu_types(auth: bool = Depends(verify_api_key)) -> dict:
    return {"types": get_free_gpu_type_info()}

@app.get("/dirs")
async def list_dirs(path: str = "", auth: bool = Depends(verify_api_key)) -> dict:
    if not path:
        path = get_home_dir()
    return list_directory(path)

@app.get("/file")
async def get_file(path: str, auth: bool = Depends(verify_api_key)) -> dict[str, str]:
    expanded = os.path.expanduser(path)
    if not os.path.isfile(expanded):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        with open(expanded, "r", encoding="utf-8") as file_handle:
            return {"content": file_handle.read(), "path": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")

@app.post("/allocate", response_model=AllocationResponse)
def allocate(request: AllocationRequest, auth: bool = Depends(verify_api_key)) -> AllocationResponse:
    if not request.gpu_type:
        raise HTTPException(status_code=400, detail="GPU type is required")
    if request.count < 0:
        raise HTTPException(status_code=400, detail="Count cannot be negative")
    requested_count = resolve_allocation_count(request)
    if request.time_mins < 1:
        raise HTTPException(status_code=400, detail="Time must be at least 1 minute")
    if request.memory_mb < 1:
        raise HTTPException(status_code=400, detail="Memory must be at least 1 MB")
    job_ids = []
    screen_names = []
    errors = []
    commands = list(request.commands)
    if request.project_dir:
        commands.insert(0, f"cd {shlex.quote(request.project_dir)}")
    for i in range(requested_count):
        try:
            job_id, error = allocate_gpu(
                request.gpu_type,
                request.time_mins,
                request.memory_mb,
                request.job_name,
            )
            if job_id:
                job_ids.append(job_id)
                screen_name = setup_allocation_session(job_id, commands, request.job_name)
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
async def list_jobs(auth: bool = Depends(verify_api_key)) -> list[JobResponse]:
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
            end_time=job.end_time,
            gpu_stats=JobGpuStatsResponse(
                memory_used_mb=job.gpu_stats.memory_used_mb,
                memory_total_mb=job.gpu_stats.memory_total_mb,
                temperature_c=job.gpu_stats.temperature_c,
                utilization_pct=job.gpu_stats.utilization_pct,
            ) if job.gpu_stats else None,
        )
        for job in jobs
    ]

@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, auth: bool = Depends(verify_api_key)) -> dict[str, object]:
    success, error = cancel_job(job_id)
    if success:
        screen_name = get_screen_name(job_id)
        cleanup_session(screen_name)
        remove_screen_mapping(job_id)
        return {"success": True, "message": f"Job {job_id} cancelled"}
    raise HTTPException(status_code=400, detail=error or f"Failed to cancel job {job_id}")

@app.get("/sessions/{session_name}/output")
async def get_session_output(session_name: str, lines: int = 500, auth: bool = Depends(verify_api_key)) -> dict[str, str]:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    output = capture_output(session_name, lines)
    return {"session_name": session_name, "output": output}

@app.get("/sessions/{session_name}/clients", response_model=SessionClientsResponse)
async def get_session_clients(session_name: str, auth: bool = Depends(verify_api_key)) -> SessionClientsResponse:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    return SessionClientsResponse(attached_clients=count_session_clients(session_name))

@app.post("/sessions/{session_name}/detach-clients", response_model=DetachClientsResponse)
async def post_detach_session_clients(session_name: str, auth: bool = Depends(verify_api_key)) -> DetachClientsResponse:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    detached_clients = detach_session_clients(session_name)
    return DetachClientsResponse(success=True, detached_clients=detached_clients)

if __name__ == "__main__":
    import uvicorn
    setup_logging()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    port = find_free_port(API_PORT)
    if port != API_PORT:
        print(f"Port {API_PORT} in use, using {port} instead.\n")
    API_KEY = load_or_generate_key()
    print(f"\nConnection key: {API_KEY}")
    print(f"Enter this key on {TOM_QUEST_URL}/turing to connect.\n")
    start_tunnel(API_KEY, port)
    uvicorn.run(app, host="0.0.0.0", port=port, access_log=True, log_config=None)
