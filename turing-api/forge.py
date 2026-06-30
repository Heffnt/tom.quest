"""Backdoor Forge — turing-api side (Track B).

The /forge/* surface drives a single-chain CMT backdoor build and then serves the
trained model for interactive chat. Like the boolback snapshot surface, this module
is deliberately torch-free / vllm-free / boolean_backdoor-free: it NEVER imports the
heavy stack. All heavy work (training and the vLLM server) runs as **sbatch jobs on
GPU compute nodes**; the long-lived login-node API only submits jobs, scans the
filesystem, and forwards chat over the cluster LAN.

Lifecycle:

- POST /forge/train  -> create run_dir under $BOOLEAN_BACKDOOR_OUTPUT/forge/<run_id>,
  write config.json, sbatch forge_train.sbatch (the launcher writes result.json).
  The job self-scancels on exit (gpuPool-style) so a finished/crashed build never
  holds the GPU.
- GET  /forge/train/{run_id} -> result.json (terminal) else squeue (running/pending)
  else failed (job gone, no result).
- GET  /forge/runs -> scan forge/, read each result.json head.
- POST /forge/serve -> sbatch forge_serve.sbatch (vLLM + adapter/full), write
  serve.json {base_url, host, port, job_id, session, started_at}. The wrapper
  touch-checks serve.heartbeat and scancels itself after IDLE_SECS idle.
- GET  /forge/serve/{run_id} -> probe the node-local base_url health/models.
- POST /forge/chat -> touch heartbeat, forward to vLLM /v1/chat/completions.
- POST /forge/serve/{run_id}/stop -> scancel + mark serve.json stopped.

Confinement: every run_dir is funnelled through resolve_within_root(..., root=forge
root) pinned under $BOOLEAN_BACKDOOR_OUTPUT/forge. sbatch is invoked with an argv
list (shell=False); a hostile run_id never reaches a shell.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dirs import resolve_within_root, PathNotAllowed

# --- configuration -------------------------------------------------------------

# The CMT repo (boolean_backdoor package root) the launcher / vLLM env live in.
# NEW env var for the Forge feature; documented in turing-api/forge.env.example.
FORGE_REPO_DIR = os.environ.get(
    "BOOLEAN_BACKDOOR_REPO",
    str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
)

_SCRIPTS_DIR = Path(__file__).resolve().parent / "forge_scripts"
TRAIN_SBATCH = Path(os.environ.get("FORGE_TRAIN_SBATCH", str(_SCRIPTS_DIR / "forge_train.sbatch")))
SERVE_SBATCH = Path(os.environ.get("FORGE_SERVE_SBATCH", str(_SCRIPTS_DIR / "forge_serve.sbatch")))

# Idle-release window for a serve job (seconds without a heartbeat touch).
SERVE_IDLE_SECS = int(os.environ.get("FORGE_SERVE_IDLE_SECS", "600"))
# Port the vLLM server binds on the compute node (login node reaches it over LAN).
SERVE_PORT = int(os.environ.get("FORGE_SERVE_PORT", "8765"))
# Short timeouts so a hung node never freezes a worker thread.
PROBE_TIMEOUT = float(os.environ.get("FORGE_PROBE_TIMEOUT", "4"))
CHAT_TIMEOUT = float(os.environ.get("FORGE_CHAT_TIMEOUT", "120"))

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


# --- request models ------------------------------------------------------------


class ForgeTrainRequest(BaseModel):
    config: dict[str, Any]
    job_name: str | None = None


class ForgeServeRequest(BaseModel):
    run_id: str


class ChatMessage(BaseModel):
    role: str
    content: str


class ForgeChatRequest(BaseModel):
    run_id: str
    messages: list[ChatMessage]
    max_tokens: int | None = None
    temperature: float | None = None


# --- run-dir confinement -------------------------------------------------------


def forge_root() -> Path:
    """$BOOLEAN_BACKDOOR_OUTPUT/forge — the pinned root for every run_dir. Resolved
    at call time (not import) so a patched env var / test override is honored."""
    raw = os.environ.get("BOOLEAN_BACKDOOR_OUTPUT", "")
    if not raw:
        raise RuntimeError("BOOLEAN_BACKDOOR_OUTPUT is not set")
    return (Path(raw).resolve() / "forge")


def _run_dir(run_id: str) -> Path:
    """Confine a caller-supplied run_id to forge_root(). A run_id with a slash or
    traversal is rejected before it ever touches the filesystem or sbatch."""
    if not run_id or not _RUN_ID_RE.match(run_id):
        raise PathNotAllowed("Invalid run_id")
    return resolve_within_root(run_id, root=forge_root())


def _new_run_id() -> str:
    """Server-generated slug: sortable timestamp + short uuid (no Math.random)."""
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


# --- squeue helpers (torch-free; plain subprocess) -----------------------------


def _job_state(job_id: str) -> str | None:
    """Current squeue state token for job_id (e.g. RUNNING/PENDING), or None when the
    job is no longer in the queue. Empty/missing -> None."""
    if not job_id:
        return None
    try:
        out = subprocess.run(
            ["squeue", "-h", "-j", job_id, "-o", "%T"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    state = out.stdout.strip().splitlines()
    return state[0].strip() if state and state[0].strip() else None


def _job_time_remaining(job_id: str) -> str | None:
    try:
        out = subprocess.run(
            ["squeue", "-h", "-j", job_id, "-o", "%L"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    val = out.stdout.strip().splitlines()
    return val[0].strip() if val and val[0].strip() else None


def _scancel(job_id: str) -> bool:
    if not job_id:
        return False
    try:
        out = subprocess.run(
            ["scancel", job_id],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0


# --- result.json / serve.json IO ----------------------------------------------


def _read_json(path: Path) -> dict[str, Any] | None:
    """Tolerant read: a partial/absent/corrupt file reads as None (the build job
    writes result.json atomically, but a serve.json mid-write must never 500)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _job_marker(run_dir: Path) -> Path:
    """Where POST /forge/train records the submitted train job id, so GET status can
    cross-check squeue even before result.json exists."""
    return run_dir / "train.jobid"


# --- POST /forge/train ---------------------------------------------------------


def submit_train(config: dict[str, Any], job_name: str | None) -> dict[str, Any]:
    """Create run_dir, write config.json, sbatch the launcher. Returns the §4 shape."""
    root = forge_root()
    root.mkdir(parents=True, exist_ok=True)
    run_id = _new_run_id()
    run_dir = _run_dir(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)

    config_path = run_dir / "config.json"
    result_path = run_dir / "result.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    clean_name = (job_name or "").strip() or f"forge-train-{run_id}"
    try:
        proc = subprocess.run(
            [
                "sbatch", "--parsable",
                f"--job-name={clean_name}",
                str(TRAIN_SBATCH),
                str(run_dir),
                FORGE_REPO_DIR,
            ],
            cwd=FORGE_REPO_DIR, shell=False, capture_output=True, text=True,
            timeout=60, check=True,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="sbatch not found (SLURM not on PATH)")
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=(exc.stderr or str(exc)).strip()[:500])
    except subprocess.SubprocessError as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:500])

    job_id = proc.stdout.strip().split(";")[0]
    try:
        _job_marker(run_dir).write_text(job_id, encoding="utf-8")
    except OSError:
        pass

    return {
        "success": True,
        "run_id": run_id,
        "job_id": job_id,
        "run_dir": str(run_dir),
        "result_path": str(result_path),
    }


# --- GET /forge/train/{run_id} -------------------------------------------------


def train_status(run_id: str) -> dict[str, Any]:
    """Status precedence (§4): result.json -> its status; else squeue -> running/
    pending; else (job gone & no result) -> failed."""
    run_dir = _run_dir(run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")

    result = _read_json(run_dir / "result.json")
    marker = _job_marker(run_dir)
    job_id = marker.read_text(encoding="utf-8").strip() if marker.exists() else ""

    job_block: dict[str, Any] | None = None
    state = _job_state(job_id) if job_id else None
    if state is not None:
        job_block = {
            "job_id": job_id,
            "state": state,
            "time_remaining": _job_time_remaining(job_id),
        }

    if result is not None:
        # The launcher wrote a terminal result; trust it.
        status = "completed" if result.get("status") == "completed" else "failed"
    elif state is not None:
        status = "pending" if state.upper().startswith("PEND") else "running"
    else:
        # No result and the job is gone from the queue -> it died without writing.
        status = "failed" if job_id else "pending"

    return {"run_id": run_id, "status": status, "result": result, "job": job_block}


# --- GET /forge/runs -----------------------------------------------------------


def list_runs() -> dict[str, Any]:
    """Scan forge/ and read each result.json/config.json head into a compact row."""
    root = forge_root()
    runs: list[dict[str, Any]] = []
    if not root.is_dir():
        return {"runs": []}
    for child in root.iterdir():
        if not child.is_dir():
            continue
        result = _read_json(child / "result.json")
        config = _read_json(child / "config.json") or {}
        if result is not None:
            status = "completed" if result.get("status") == "completed" else "failed"
            base_model = result.get("base_model")
            name = (result.get("config") or {}).get("name") or config.get("name")
        else:
            # No terminal result yet: pending unless the marked job vanished.
            marker = child / "train.jobid"
            job_id = marker.read_text(encoding="utf-8").strip() if marker.exists() else ""
            state = _job_state(job_id) if job_id else None
            if state is not None:
                status = "pending" if state.upper().startswith("PEND") else "running"
            else:
                status = "failed" if job_id else "pending"
            base_model = (config.get("training") or {}).get("base_model")
            name = config.get("name")
        try:
            created_at = int(child.stat().st_mtime)
        except OSError:
            created_at = 0
        runs.append({
            "run_id": child.name,
            "status": status,
            "name": name,
            "base_model": base_model,
            "created_at": created_at,
        })
    runs.sort(key=lambda r: r["created_at"], reverse=True)
    return {"runs": runs}


# --- POST /forge/serve ---------------------------------------------------------


def submit_serve(run_id: str) -> dict[str, Any]:
    """sbatch a vLLM server for a finished run (base model + adapter or full dir).
    Writes serve.json and returns the §4 shape (ready=False; UI polls)."""
    run_dir = _run_dir(run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    result = _read_json(run_dir / "result.json")
    if result is None:
        raise HTTPException(status_code=409, detail="Run has no result yet (train not complete)")
    if result.get("status") != "completed":
        raise HTTPException(status_code=409, detail="Run did not complete successfully")

    base_model = result.get("base_model")
    if not base_model:
        raise HTTPException(status_code=422, detail="result.json missing base_model")
    is_adapter = bool(result.get("is_adapter"))
    adapter_path = result.get("adapter_path")
    model_dir = result.get("model_dir")
    if is_adapter and not adapter_path:
        raise HTTPException(status_code=422, detail="is_adapter set but adapter_path missing")
    if not is_adapter and not model_dir:
        raise HTTPException(status_code=422, detail="full build missing model_dir")

    # The compute node binds 0.0.0.0; squeue tells us which node so the login node
    # can reach it. We discover the actual node after the job starts (GET serve),
    # but record the chosen port and a host placeholder now.
    host = "0.0.0.0"
    port = SERVE_PORT
    session = f"forge-serve-{run_id}"

    env = dict(os.environ)
    env.update({
        "BASE_MODEL": str(base_model),
        "ADAPTER_PATH": str(adapter_path or ""),
        "MODEL_DIR": str(model_dir or ""),
        "IS_ADAPTER": "true" if is_adapter else "false",
        "IDLE_SECS": str(SERVE_IDLE_SECS),
    })
    try:
        proc = subprocess.run(
            [
                "sbatch", "--parsable",
                f"--job-name={session}",
                str(SERVE_SBATCH),
                str(run_dir),
                FORGE_REPO_DIR,
                host,
                str(port),
            ],
            cwd=FORGE_REPO_DIR, shell=False, capture_output=True, text=True,
            timeout=60, check=True, env=env,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="sbatch not found (SLURM not on PATH)")
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=(exc.stderr or str(exc)).strip()[:500])
    except subprocess.SubprocessError as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:500])

    job_id = proc.stdout.strip().split(";")[0]
    # base_url is finalized once we learn the node hostname (GET serve resolves it);
    # store the chosen port now and a node-relative placeholder URL.
    serve = {
        "base_url": None,
        "host": host,
        "port": port,
        "job_id": job_id,
        "session": session,
        "started_at": int(time.time()),
        "status": "starting",
    }
    (run_dir / "serve.json").write_text(json.dumps(serve, indent=2), encoding="utf-8")
    # Seed the heartbeat so the idle window starts at submit, not epoch 0.
    try:
        (run_dir / "serve.heartbeat").touch()
    except OSError:
        pass

    return {
        "success": True,
        "session": session,
        "job_id": job_id,
        "base_url": _node_base_url(job_id, port),
        "ready": False,
    }


def _job_node(job_id: str) -> str | None:
    """The compute node a running job landed on (squeue %N / NodeList), or None while
    pending. This is the host the login-node API forwards chat to over the LAN."""
    if not job_id:
        return None
    try:
        out = subprocess.run(
            ["squeue", "-h", "-j", job_id, "-o", "%N"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    node = out.stdout.strip().splitlines()
    candidate = node[0].strip() if node and node[0].strip() else ""
    # A pending job shows blank / "(Resources)" etc. — only a real nodename is usable.
    if not candidate or candidate.startswith("("):
        return None
    return candidate


def _node_base_url(job_id: str, port: int) -> str | None:
    node = _job_node(job_id)
    if not node:
        return None
    return f"http://{node}:{port}/v1"


# --- GET /forge/serve/{run_id} -------------------------------------------------


def _resolve_base_url(run_dir: Path, serve: dict[str, Any]) -> str | None:
    """Prefer a stored base_url; else resolve the live node from squeue and persist
    it back into serve.json so subsequent reads / chat skip the squeue hop."""
    stored = serve.get("base_url")
    if stored:
        return stored
    job_id = serve.get("job_id") or ""
    base_url = _node_base_url(job_id, int(serve.get("port") or SERVE_PORT))
    if base_url:
        serve["base_url"] = base_url
        try:
            (run_dir / "serve.json").write_text(json.dumps(serve, indent=2), encoding="utf-8")
        except OSError:
            pass
    return base_url


def serve_status(run_id: str) -> dict[str, Any]:
    """starting | ready | stopped. ready once the node-local vLLM answers /models."""
    run_dir = _run_dir(run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    serve = _read_json(run_dir / "serve.json")
    if serve is None:
        return {"status": "stopped", "base_url": None, "job_id": None}
    job_id = serve.get("job_id") or ""

    if serve.get("status") == "stopped":
        return {"status": "stopped", "base_url": serve.get("base_url"), "job_id": job_id}

    state = _job_state(job_id) if job_id else None
    if state is None:
        return {"status": "stopped", "base_url": serve.get("base_url"), "job_id": job_id}

    base_url = _resolve_base_url(run_dir, serve)
    if base_url and _probe_ready(base_url):
        return {"status": "ready", "base_url": base_url, "job_id": job_id}
    return {"status": "starting", "base_url": base_url, "job_id": job_id}


def _probe_ready(base_url: str) -> bool:
    """The vLLM server is up once /models (or /health) answers 2xx."""
    root = base_url.rstrip("/")
    for url in (f"{root}/models", root.rsplit("/v1", 1)[0] + "/health"):
        try:
            resp = requests.get(url, timeout=PROBE_TIMEOUT)
        except requests.RequestException:
            continue
        if resp.status_code < 400:
            return True
    return False


# --- POST /forge/chat ----------------------------------------------------------


def chat(req: ForgeChatRequest) -> dict[str, Any]:
    """Touch the heartbeat, forward to the node-local vLLM /v1/chat/completions."""
    run_dir = _run_dir(req.run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Unknown run: {req.run_id}")
    serve = _read_json(run_dir / "serve.json")
    if serve is None or serve.get("status") == "stopped":
        raise HTTPException(status_code=409, detail="server not ready")
    job_id = serve.get("job_id") or ""
    if _job_state(job_id) is None:
        raise HTTPException(status_code=409, detail="server not ready")
    base_url = _resolve_base_url(run_dir, serve)
    if not base_url or not _probe_ready(base_url):
        raise HTTPException(status_code=409, detail="server not ready")

    # Keep the serve job alive: bump the heartbeat mtime the wrapper watches.
    try:
        (run_dir / "serve.heartbeat").touch()
    except OSError:
        pass

    payload: dict[str, Any] = {
        "model": "forge",
        "messages": [{"role": m.role, "content": m.content} for m in req.messages],
    }
    if req.max_tokens is not None:
        payload["max_tokens"] = req.max_tokens
    if req.temperature is not None:
        payload["temperature"] = req.temperature

    try:
        resp = requests.post(
            f"{base_url.rstrip('/')}/chat/completions",
            json=payload, timeout=CHAT_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"vLLM request failed: {exc}")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"vLLM error {resp.status_code}: {resp.text[:300]}")

    try:
        data = resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="vLLM returned non-JSON")
    choices = data.get("choices") or []
    message = (choices[0].get("message") if choices else None) or {"role": "assistant", "content": ""}
    return {
        "message": {"role": message.get("role", "assistant"), "content": message.get("content", "")},
        "usage": data.get("usage"),
    }


# --- POST /forge/serve/{run_id}/stop -------------------------------------------


def stop_serve(run_id: str) -> dict[str, Any]:
    run_dir = _run_dir(run_id)
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")
    serve = _read_json(run_dir / "serve.json")
    if serve is not None:
        job_id = serve.get("job_id") or ""
        if job_id:
            _scancel(job_id)
        serve["status"] = "stopped"
        try:
            (run_dir / "serve.json").write_text(json.dumps(serve, indent=2), encoding="utf-8")
        except OSError:
            pass
    return {"success": True}


# --- router --------------------------------------------------------------------


def build_router(verify_api_key: Any) -> APIRouter:
    """Mount the /forge/* surface. Every endpoint keeps the X-API-Key dependency and
    is sync `def` (blocking subprocess / FS / network I/O — the liveness rule)."""
    router = APIRouter(prefix="/forge", tags=["forge"])

    @router.post("/train")
    def forge_train(req: ForgeTrainRequest, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        return submit_train(req.config, req.job_name)

    @router.get("/train/{run_id}")
    def forge_train_status(run_id: str, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        try:
            return train_status(run_id)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.get("/runs")
    def forge_runs(auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        return list_runs()

    @router.post("/serve")
    def forge_serve(req: ForgeServeRequest, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        try:
            return submit_serve(req.run_id)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.get("/serve/{run_id}")
    def forge_serve_status(run_id: str, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        try:
            return serve_status(run_id)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.post("/chat")
    def forge_chat(req: ForgeChatRequest, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        try:
            return chat(req)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    @router.post("/serve/{run_id}/stop")
    def forge_serve_stop(run_id: str, auth: bool = Depends(verify_api_key)) -> dict[str, Any]:
        try:
            return stop_serve(run_id)
        except PathNotAllowed as exc:
            raise HTTPException(status_code=403, detail=str(exc))

    return router
