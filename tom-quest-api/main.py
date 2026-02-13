import logging
import os
import re
import subprocess
import threading
import time
import uuid
import requests
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from gpu_report import format_gpu_report_v2, get_free_gpu_types
from slurm import allocate_gpu, cancel_job, get_user_jobs, get_job_count, MAX_GPU_ALLOCATIONS
from tmux import setup_allocation_session, cleanup_session, capture_output, session_exists
from job_screens import get_screen_name, remove_screen_mapping
from dirs import list_directory, get_home_dir
from boolback import router as boolback_router

load_dotenv()
TOM_QUEST_URL = os.getenv("TOM_QUEST_URL", "https://tom.quest")
KEY_FILE = os.path.expanduser("~/.tom-quest-key")
LOG_PATH = "tom-quest-api.log"
TUNNEL_LOG_PATH = "tom-quest-tunnel.log"
HEARTBEAT_INTERVAL = 30  # seconds

# Global state
API_KEY = ""
TUNNEL_URL = ""

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
    try:
        res = requests.post(
            f"{TOM_QUEST_URL}/api/turing/register",
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
    global TUNNEL_URL
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        if TUNNEL_URL:
            register_with_tom_quest(key, TUNNEL_URL)

def watch_tunnel_log(key: str):
    global TUNNEL_URL
    url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    for _ in range(30):
        time.sleep(1)
        try:
            with open(TUNNEL_LOG_PATH) as f:
                content = f.read()
            match = url_pattern.search(content)
            if match:
                TUNNEL_URL = match.group(0)
                print(f"Tunnel URL: {TUNNEL_URL}")
                if register_with_tom_quest(key, TUNNEL_URL):
                    print("Registered with tom.quest")
                else:
                    print("Failed to register with tom.quest (will retry via heartbeat)")
                return
        except FileNotFoundError:
            pass
    print("Tunnel URL not found in log after 30s")

def start_tunnel(key: str):
    try:
        log_file = open(TUNNEL_LOG_PATH, "w", buffering=1)
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", "http://localhost:8000"],
            stdout=log_file,
            stderr=log_file,
        )
        print(f"Tunnel started (pid {proc.pid}). URL will appear in: {TUNNEL_LOG_PATH}")
        threading.Thread(target=watch_tunnel_log, args=(key,), daemon=True).start()
        threading.Thread(target=heartbeat_loop, args=(key,), daemon=True).start()
        return proc
    except Exception:
        logging.getLogger("tom.quest").exception("Tunnel start failed")
        return None

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

@app.get("/gpu-report")
async def gpu_report(auth: bool = Depends(verify_api_key)):
    try:
        return format_gpu_report_v2()
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

@app.get("/file")
async def get_file(path: str, auth: bool = Depends(verify_api_key)):
    expanded = os.path.expanduser(path)
    if not os.path.isfile(expanded):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        with open(expanded, "r", encoding="utf-8") as file_handle:
            return {"content": file_handle.read(), "path": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")

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
                screen_name = setup_allocation_session(job_id, commands, request.project_dir)
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
        screen_name = get_screen_name(job_id)
        cleanup_session(screen_name)
        remove_screen_mapping(job_id)
        return {"success": True, "message": f"Job {job_id} cancelled"}
    raise HTTPException(status_code=400, detail=error or f"Failed to cancel job {job_id}")

@app.get("/sessions/{session_name}/output")
async def get_session_output(session_name: str, lines: int = 500, auth: bool = Depends(verify_api_key)):
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    output = capture_output(session_name, lines)
    return {"session_name": session_name, "output": output}

if __name__ == "__main__":
    import uvicorn
    setup_logging()
    API_KEY = load_or_generate_key()
    print(f"\nConnection key: {API_KEY}")
    print(f"Enter this key on {TOM_QUEST_URL}/turing to connect.\n")
    start_tunnel(API_KEY)
    uvicorn.run(app, host="0.0.0.0", port=8000, access_log=True, log_config=None)
