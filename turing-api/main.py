import logging
import os
import shlex
import signal
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
    send_to_session,
    count_session_clients,
    detach_session_clients,
)
from job_screens import get_screen_name, remove_screen_mapping
from dirs import list_directory, get_home_dir, resolve_within_root, PathNotAllowed
from ws import router as ws_router

load_dotenv()
API_PORT = int(os.getenv("API_PORT", "8000"))
API_KEY = os.environ.get("TURING_API_KEY", "")
LOG_PATH = "turing-api.log"
# Upper bound on a single /allocate request. Guards against a typo (or a
# declarative caller) asking for far more GPUs than the partition holds.
MAX_ALLOCATION_COUNT = 16

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

app = FastAPI(title="turing-api", version="1.0.0")

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


app.include_router(ws_router)

class AllocationRequest(BaseModel):
    gpu_type: str
    time_mins: int
    memory_mb: int = 64000
    commands: list[str] = []
    count: int = 1
    project_dir: str = ""
    job_name: str = "allocation"
    release_on_exit: bool = False

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
    job_name: str
    gpu_stats: JobGpuStatsResponse | None = None

class RunCommandRequest(BaseModel):
    command: str

class RunCommandResponse(BaseModel):
    success: bool

class SessionClientsResponse(BaseModel):
    attached_clients: int

class DetachClientsResponse(BaseModel):
    success: bool
    detached_clients: int

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

# Endpoints below run blocking subprocess calls (squeue, scontrol, tmux, ssh to
# compute nodes). They must be plain `def`, not `async def`: FastAPI runs sync
# endpoints in a worker threadpool, while a blocking call inside `async def`
# freezes the event loop and starves every other request, including /health.
# That starvation took down the whole API during the June 2026 outage.

@app.get("/gpu-report")
def gpu_report(auth: bool = Depends(verify_api_key)) -> dict:
    try:
        return format_gpu_report_v2()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"GPU report failed: {str(e)}")

@app.get("/gpu-types")
def gpu_types(auth: bool = Depends(verify_api_key)) -> dict:
    return {"types": get_free_gpu_type_info()}

@app.get("/dirs")
def list_dirs(path: str = "", auth: bool = Depends(verify_api_key)) -> dict:
    if not path:
        path = get_home_dir()
    return list_directory(path)

@app.get("/file")
def get_file(path: str, auth: bool = Depends(verify_api_key)) -> dict[str, str]:
    try:
        resolved = resolve_within_root(path)
    except PathNotAllowed as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        return {"content": resolved.read_text(encoding="utf-8"), "path": path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")

@app.post("/allocate", response_model=AllocationResponse)
def allocate(request: AllocationRequest, auth: bool = Depends(verify_api_key)) -> AllocationResponse:
    if not request.gpu_type:
        raise HTTPException(status_code=400, detail="GPU type is required")
    if request.count < 1:
        raise HTTPException(status_code=400, detail="Count must be at least 1")
    if request.count > MAX_ALLOCATION_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Count cannot exceed {MAX_ALLOCATION_COUNT}",
        )
    requested_count = request.count
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
                screen_name = setup_allocation_session(job_id, commands, request.job_name, request.release_on_exit)
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
def list_jobs(auth: bool = Depends(verify_api_key)) -> list[JobResponse]:
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
            job_name=job.job_name,
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
def get_session_output(session_name: str, lines: int = 500, auth: bool = Depends(verify_api_key)) -> dict[str, str]:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    output = capture_output(session_name, lines)
    return {"session_name": session_name, "output": output}

@app.post("/sessions/{session_name}/run", response_model=RunCommandResponse)
def run_session_command(session_name: str, request: RunCommandRequest, auth: bool = Depends(verify_api_key)) -> RunCommandResponse:
    if not request.command.strip():
        raise HTTPException(status_code=400, detail="Command is required")
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    if not send_to_session(session_name, request.command):
        raise HTTPException(status_code=502, detail="Failed to send command to session")
    return RunCommandResponse(success=True)

@app.get("/sessions/{session_name}/clients", response_model=SessionClientsResponse)
def get_session_clients(session_name: str, auth: bool = Depends(verify_api_key)) -> SessionClientsResponse:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    return SessionClientsResponse(attached_clients=count_session_clients(session_name))

@app.post("/sessions/{session_name}/detach-clients", response_model=DetachClientsResponse)
def post_detach_session_clients(session_name: str, auth: bool = Depends(verify_api_key)) -> DetachClientsResponse:
    if not session_exists(session_name):
        raise HTTPException(status_code=404, detail=f"Session '{session_name}' not found")
    detached_clients = detach_session_clients(session_name)
    return DetachClientsResponse(success=True, detached_clients=detached_clients)

if __name__ == "__main__":
    import uvicorn
    setup_logging()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if not API_KEY:
        raise SystemExit("TURING_API_KEY is not set. Configure turing-api/.env before starting.")
    print(f"\nTuring API listening on 127.0.0.1:{API_PORT}")
    print("Bound to localhost: reachable only through the co-located cloudflared tunnel, not the shared cluster LAN.\n")
    uvicorn.run(app, host="127.0.0.1", port=API_PORT, access_log=True, log_config=None)
