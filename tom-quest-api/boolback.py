import importlib.util
import json
import os
import re
import socket
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/boolback", tags=["boolback"])

def _resolve_path_env(raw_value: str, base_dir: Path) -> Path:
    path = Path(os.path.expanduser(str(raw_value or "").strip()))
    if path.is_absolute():
        return path.resolve()
    return (base_dir / path).resolve()


DEFAULT_PROJECT_ROOT = Path("~/booleanbackdoors/ComplexMultiTrigger").expanduser().resolve()
PROJECT_ROOT = _resolve_path_env(
    os.getenv("BOOLBACK_PROJECT_ROOT", str(DEFAULT_PROJECT_ROOT)),
    DEFAULT_PROJECT_ROOT,
)
BASE_DATA_DIR = _resolve_path_env(
    os.getenv("BOOLBACK_BASE_DATA_DIR", "base_data"),
    PROJECT_ROOT,
)
OUTPUT_DIR = _resolve_path_env(
    os.getenv("BOOLBACK_OUTPUT_DIR", "output"),
    PROJECT_ROOT,
)
EXPERIMENTS_DIR = _resolve_path_env(
    os.getenv("BOOLBACK_EXPERIMENTS_DIR", "output/experiments"),
    PROJECT_ROOT,
)
VALIDATION_PATH = BASE_DATA_DIR / "validation.json"
BATCH_PATH = _resolve_path_env(
    os.getenv("BOOLBACK_BATCH_PATH", "batch.py"),
    PROJECT_ROOT,
)

STAGE_FILES = {
    "seeds": "seeds.json",
    "train_seeds": "train_seeds.json",
    "test_seeds": "test_seeds.json",
    "augmented": "train_augmented.json",
    "filtered_refused": "train_filtered_refused.json",
    "filtered_final": "train_filtered_final.json",
    "train_with_responses": "train_with_responses.json",
    "test_with_responses": "test_with_responses.json",
    "base_train": "base_train.json",
    "base_test": "base_test.json",
}

validation_lock = threading.Lock()
_SCORE_EPOCH_RE = re.compile(r"^score_epoch_(\d+)_keyword\.json$")


class ValidationWriteRequest(BaseModel):
    sample_index: int
    dataset: str
    result: str
    notes: str = ""


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as file_handle:
        return json.load(file_handle)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as file_handle:
        json.dump(data, file_handle, indent=2)
    os.replace(tmp_path, path)


def parse_bool(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in {"true", "1", "yes"})


def stage_path(stage_id: str) -> Path:
    filename = STAGE_FILES.get(stage_id)
    if not filename:
        raise HTTPException(status_code=404, detail=f"Unknown stage: {stage_id}")
    return BASE_DATA_DIR / filename


def stage_samples(stage_id: str) -> list[Any]:
    path = stage_path(stage_id)
    data = read_json(path, [])
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail=f"Stage data must be a list: {path}")
    return data


def sample_to_search_text(sample: Any) -> str:
    if isinstance(sample, str):
        return sample
    if isinstance(sample, dict):
        pieces = [
            str(sample.get("text", "")),
            str(sample.get("prompt", "")),
            str(sample.get("input", "")),
            str(sample.get("compliance", "")),
            str(sample.get("refusal", "")),
            str(sample.get("raw_output", "")),
            str(sample.get("model_output", "")),
            str(sample.get("notes", "")),
        ]
        return " ".join(piece for piece in pieces if piece)
    return str(sample)


def paginate(items: list[Any], page: int, limit: int) -> dict[str, Any]:
    total = len(items)
    if limit < 1:
        raise HTTPException(status_code=400, detail="limit must be at least 1")
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be at least 1")
    start = (page - 1) * limit
    end = start + limit
    page_items = items[start:end]
    return {
        "samples": page_items,
        "total": total,
        "page": page,
        "limit": limit,
        "totalPages": max(1, (total + limit - 1) // limit),
    }


def load_metadata() -> dict[str, Any]:
    metadata_path = BASE_DATA_DIR / "metadata.json"
    metadata = read_json(metadata_path, {})
    if not isinstance(metadata, dict):
        raise HTTPException(status_code=500, detail="metadata.json must be an object")
    return metadata


def load_llm_steps() -> dict[str, Any]:
    llm_path = BASE_DATA_DIR / "llm_calls.json"
    llm_data = read_json(llm_path, {})
    if not isinstance(llm_data, dict):
        raise HTTPException(status_code=500, detail="llm_calls.json must be an object")
    steps = llm_data.get("steps", {})
    if not isinstance(steps, dict):
        raise HTTPException(status_code=500, detail="llm_calls.json steps must be an object")
    return steps


def load_dataset_samples(dataset: str) -> list[dict[str, Any]]:
    if dataset not in {"train", "test"}:
        raise HTTPException(status_code=400, detail="dataset must be train or test")
    filename = "base_train.json" if dataset == "train" else "base_test.json"
    data = read_json(BASE_DATA_DIR / filename, [])
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail=f"{filename} must be a list")
    normalized: list[dict[str, Any]] = []
    for index, sample in enumerate(data):
        if isinstance(sample, dict):
            normalized.append(
                {
                    "index": index,
                    "input": str(sample.get("input", "")),
                    "compliance": str(sample.get("compliance", "")),
                    "refusal": str(sample.get("refusal", "")),
                }
            )
        else:
            normalized.append(
                {
                    "index": index,
                    "input": str(sample),
                    "compliance": "",
                    "refusal": "",
                }
            )
    return normalized


def load_validation_entries() -> list[dict[str, Any]]:
    entries = read_json(VALIDATION_PATH, [])
    if not isinstance(entries, list):
        raise HTTPException(status_code=500, detail="validation.json must be a list")
    valid_entries: list[dict[str, Any]] = []
    for entry in entries:
        if isinstance(entry, dict):
            valid_entries.append(entry)
    return valid_entries


def safe_experiment_dir(experiment_name: str) -> Path:
    name = str(experiment_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="experiment_name is required")
    if Path(name).name != name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid experiment_name")
    path = EXPERIMENTS_DIR / name
    if not path.exists() or not path.is_dir():
        raise HTTPException(status_code=404, detail="Experiment not found")
    return path


def list_experiment_epochs(results_dir: Path) -> list[int]:
    if not results_dir.exists() or not results_dir.is_dir():
        return []
    epochs: set[int] = set()
    for entry in results_dir.iterdir():
        if not entry.is_file():
            continue
        m = _SCORE_EPOCH_RE.match(entry.name)
        if not m:
            continue
        epochs.add(int(m.group(1)))
    return sorted(epochs)


def has_outputs_for_epoch(results_dir: Path, epoch: int) -> bool:
    return (results_dir / f"outputs_epoch_{epoch}.json").exists()


def compute_confusion_counts(variants: dict[str, Any]) -> dict[str, int]:
    tp = fp = fn = tn = 0
    for _variant_name, info in variants.items():
        if not isinstance(info, dict):
            continue
        should_activate = bool(info.get("should_activate", False))
        num_samples = info.get("num_samples")
        num_success = info.get("num_success")
        if not isinstance(num_samples, int) or not isinstance(num_success, int):
            continue
        if should_activate:
            tp += num_success
            fn += max(0, num_samples - num_success)
        else:
            fp += num_success
            tn += max(0, num_samples - num_success)
    return {"tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn)}


def short_model_name(model: Any) -> str:
    text = str(model or "")
    return text.rsplit("/", 1)[-1] if "/" in text else text


def unique_validation_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key: dict[tuple[str, int], dict[str, Any]] = {}
    for entry in entries:
        dataset = str(entry.get("dataset", ""))
        sample_index = entry.get("sample_index")
        if dataset not in {"train", "test"} or not isinstance(sample_index, int):
            continue
        by_key[(dataset, sample_index)] = entry
    values = list(by_key.values())
    values.sort(key=lambda item: str(item.get("reviewed_at", "")), reverse=True)
    return values


def path_for_response(path: Path, project_root: Path) -> str:
    try:
        return str(path.resolve().relative_to(project_root.resolve()))
    except ValueError:
        return str(path.resolve())


def expression_preview(text: str, max_chars: int = 140) -> str:
    clean = " ".join(str(text or "").split())
    if len(clean) <= max_chars:
        return clean
    return f"{clean[: max_chars - 3]}..."


def canonical_progress_arg_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except TypeError:
        return str(value)


def compute_varying_sweep_keys(
    sweep_parameters: dict[str, Any],
    combinations: list[dict[str, Any]],
) -> list[str]:
    if not combinations:
        return []
    parameter_order = [str(key) for key in sweep_parameters.keys() if str(key) != "experiment"]
    seen_keys = set(parameter_order)
    for config in combinations:
        for key in config.keys():
            key_s = str(key)
            if key_s == "experiment" or key_s in seen_keys:
                continue
            parameter_order.append(key_s)
            seen_keys.add(key_s)
    varying_keys: list[str] = []
    missing_marker = "__MISSING__"
    for key in parameter_order:
        values = set()
        for config in combinations:
            if key in config:
                values.add(canonical_progress_arg_value(config.get(key)))
            else:
                values.add(missing_marker)
        if len(values) > 1:
            varying_keys.append(key)
    return varying_keys


def resolve_input_path(path_value: str, project_root: Path) -> Path:
    value = str(path_value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Path cannot be empty")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = project_root / path
    return path.resolve()


def load_batch_module(batch_path: Path, project_root: Path) -> ModuleType:
    if not batch_path.exists():
        raise HTTPException(status_code=404, detail=f"batch.py not found: {batch_path}")
    project_root_s = str(project_root.resolve())
    if project_root_s not in sys.path:
        sys.path.insert(0, project_root_s)
    spec = importlib.util.spec_from_file_location("boolback_dynamic_batch", str(batch_path))
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=500, detail=f"Failed to load batch module: {batch_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # run.py uses relative OUTPUT_DIR = Path("./output"); patch it to be absolute
    # so ExperimentConfig paths resolve under project_root, not the FastAPI CWD
    import run as _run_mod
    _run_mod.OUTPUT_DIR = (project_root / "output").resolve()
    return module


def inspect_running_lock(lock_path: Path) -> dict[str, Any]:
    info = {
        "path": str(lock_path),
        "exists": lock_path.exists(),
        "status": "none",  # none|active|blocked|stale
        "reason": "",
        "hostname": None,
        "pid": None,
        "started": None,
        "raw": None,
    }
    if not lock_path.exists():
        return info
    if lock_path.stat().st_size == 0:
        info["status"] = "blocked"
        info["reason"] = "Empty lock file"
        return info
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except json.JSONDecodeError:
        info["status"] = "blocked"
        info["reason"] = "Lock file is not valid JSON"
        return info
    if not isinstance(raw, dict):
        info["status"] = "blocked"
        info["reason"] = "Lock JSON must be an object"
        return info
    info["raw"] = raw
    hostname = raw.get("hostname")
    if not isinstance(hostname, str) or not hostname.strip():
        info["status"] = "blocked"
        info["reason"] = "Lock missing hostname"
        return info
    info["hostname"] = hostname
    pid_raw = raw.get("pid")
    try:
        pid = int(pid_raw)
    except (TypeError, ValueError):
        info["status"] = "blocked"
        info["reason"] = "Lock has invalid pid"
        return info
    if pid <= 0:
        info["status"] = "blocked"
        info["reason"] = "Lock has non-positive pid"
        return info
    info["pid"] = pid
    started = raw.get("started")
    if isinstance(started, (int, float)):
        info["started"] = float(started)
    current_host = socket.gethostname()
    if hostname != current_host:
        info["status"] = "active"
        info["reason"] = f"Lock from another host ({hostname})"
        return info
    if Path(f"/proc/{pid}").exists():
        info["status"] = "active"
        info["reason"] = "Lock PID is active"
        return info
    info["status"] = "stale"
    info["reason"] = "Lock PID is not running on this host"
    return info


@router.get("/pipeline")
def get_pipeline():
    metadata = load_metadata()
    pipeline = metadata.get("pipeline", {})
    if not isinstance(pipeline, dict):
        raise HTTPException(status_code=500, detail="metadata pipeline must be an object")
    nodes = pipeline.get("nodes", [])
    edges = pipeline.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise HTTPException(status_code=500, detail="metadata pipeline nodes/edges must be lists")
    return {
        "nodes": nodes,
        "edges": edges,
        "overview": {
            "train_ratio": metadata.get("train_ratio"),
            "augment_model": metadata.get("augment_model"),
            "filter_models": metadata.get("filter_models"),
            "similarity_model": metadata.get("similarity_model"),
            "refusal_model": metadata.get("refusal_model"),
            "compliance_model": metadata.get("compliance_model"),
            "verify_model": metadata.get("verify_model"),
            "seed_count": metadata.get("seed_count"),
            "base_train_count": metadata.get("base_train_count"),
            "base_test_count": metadata.get("base_test_count"),
        },
    }


@router.get("/stage/{stage_id}")
def get_stage_samples(
    stage_id: str,
    page: int = Query(default=1),
    limit: int = Query(default=20),
    search: str = Query(default=""),
    sort_by: str = Query(default=""),
    sort_dir: str = Query(default="asc"),
):
    items = stage_samples(stage_id)
    has_text = len(items) > 0 and isinstance(items[0], str)
    normalized: list[dict[str, Any]] = []
    for index, sample in enumerate(items):
        if isinstance(sample, str):
            normalized.append({"index": index, "text": sample})
        elif isinstance(sample, dict):
            normalized.append(
                {
                    "index": index,
                    "input": str(sample.get("input", "")),
                    "compliance": str(sample.get("compliance", "")),
                    "refusal": str(sample.get("refusal", "")),
                }
            )
        else:
            normalized.append({"index": index, "text": str(sample)})
    if search:
        needle = search.lower()
        normalized = [item for item in normalized if needle in sample_to_search_text(item).lower()]
    if sort_by:
        sort_dir_l = str(sort_dir or "asc").strip().lower()
        if sort_dir_l not in {"asc", "desc"}:
            raise HTTPException(status_code=400, detail="sort_dir must be asc or desc")
        sort_by_s = str(sort_by).strip()
        allowed_fields = {"text"} if has_text else {"input", "compliance", "refusal"}
        if sort_by_s not in allowed_fields:
            raise HTTPException(status_code=400, detail=f"sort_by must be one of: {', '.join(sorted(allowed_fields))}")
        normalized.sort(
            key=lambda item: len(str(item.get(sort_by_s, ""))),
            reverse=sort_dir_l == "desc",
        )
    payload = paginate(normalized, page, limit)
    payload["hasText"] = has_text
    return payload


@router.get("/llm/{step_id}")
def get_llm_step(
    step_id: str,
    page: int = Query(default=1),
    limit: int = Query(default=20),
    status: str = Query(default=""),
    search: str = Query(default=""),
):
    steps = load_llm_steps()
    step = steps.get(step_id)
    if not isinstance(step, dict):
        raise HTTPException(status_code=404, detail=f"Unknown step: {step_id}")
    samples = step.get("samples", [])
    if not isinstance(samples, list):
        raise HTTPException(status_code=500, detail="Step samples must be a list")
    filtered = samples
    if status == "kept":
        filtered = [sample for sample in filtered if isinstance(sample, dict) and parse_bool(sample.get("kept"))]
    elif status == "removed":
        filtered = [
            sample
            for sample in filtered
            if isinstance(sample, dict)
            and (
                parse_bool(sample.get("removed"))
                or ("removed" not in sample and not parse_bool(sample.get("kept")))
            )
        ]
    if search:
        needle = search.lower()
        filtered = [sample for sample in filtered if needle in sample_to_search_text(sample).lower()]
    summary = {key: value for key, value in step.items() if key != "samples"}
    page_data = paginate(filtered, page, limit)
    return {"summary": summary, **page_data}


@router.get("/edge-diff")
def get_edge_diff(
    from_stage: str = Query(..., alias="from"),
    to_stage: str = Query(..., alias="to"),
):
    from_samples = stage_samples(from_stage)
    to_samples = stage_samples(to_stage)
    from_text = {sample_to_search_text(item) for item in from_samples}
    to_text = {sample_to_search_text(item) for item in to_samples}
    added = sorted(to_text - from_text)
    removed = sorted(from_text - to_text)
    return {
        "added": [{"text": text} for text in added[:100]],
        "removed": [{"text": text} for text in removed[:100]],
        "addedTotal": len(added),
        "removedTotal": len(removed),
    }


@router.get("/validation/queue")
def get_validation_queue(
    dataset: str = Query(default="train"),
    limit: int = Query(default=5),
):
    samples = load_dataset_samples(dataset)
    entries = unique_validation_entries(load_validation_entries())
    reviewed = {
        entry["sample_index"]
        for entry in entries
        if entry.get("dataset") == dataset and isinstance(entry.get("sample_index"), int)
    }
    queue = [sample for sample in samples if sample["index"] not in reviewed][: max(1, limit)]
    return {
        "samples": queue,
        "total": len(samples),
        "reviewed": len(reviewed),
        "remaining": max(0, len(samples) - len(reviewed)),
    }


@router.post("/validation")
def post_validation(payload: ValidationWriteRequest):
    if payload.dataset not in {"train", "test"}:
        raise HTTPException(status_code=400, detail="dataset must be train or test")
    if payload.result not in {"good", "bad"}:
        raise HTTPException(status_code=400, detail="result must be good or bad")
    reviewed_at = datetime.now(timezone.utc).isoformat()
    entry = {
        "sample_index": payload.sample_index,
        "dataset": payload.dataset,
        "result": payload.result,
        "notes": payload.notes,
        "reviewed_at": reviewed_at,
    }
    with validation_lock:
        entries = load_validation_entries()
        updated = False
        for index, existing in enumerate(entries):
            if (
                isinstance(existing, dict)
                and existing.get("dataset") == payload.dataset
                and existing.get("sample_index") == payload.sample_index
            ):
                entries[index] = entry
                updated = True
                break
        if not updated:
            entries.append(entry)
        write_json(VALIDATION_PATH, entries)
    return {"success": True, "entry": entry}


@router.get("/validation/stats")
def get_validation_stats():
    entries = unique_validation_entries(load_validation_entries())
    train_samples = load_dataset_samples("train")
    test_samples = load_dataset_samples("test")

    def count(dataset: str, result: str | None = None) -> int:
        return sum(
            1
            for entry in entries
            if entry.get("dataset") == dataset and (result is None or entry.get("result") == result)
        )

    reviewed_train = count("train")
    reviewed_test = count("test")
    good_train = count("train", "good")
    good_test = count("test", "good")
    bad_train = count("train", "bad")
    bad_test = count("test", "bad")

    return {
        "overall": {
            "total": len(train_samples) + len(test_samples),
            "reviewed": reviewed_train + reviewed_test,
            "good": good_train + good_test,
            "bad": bad_train + bad_test,
        },
        "train": {
            "total": len(train_samples),
            "reviewed": reviewed_train,
            "good": good_train,
            "bad": bad_train,
        },
        "test": {
            "total": len(test_samples),
            "reviewed": reviewed_test,
            "good": good_test,
            "bad": bad_test,
        },
    }


@router.get("/validation/review")
def get_validation_review(
    dataset: str = Query(default="all"),
    result: str = Query(default="all"),
    search: str = Query(default=""),
    page: int = Query(default=1),
    limit: int = Query(default=20),
):
    if dataset not in {"all", "train", "test"}:
        raise HTTPException(status_code=400, detail="dataset must be all, train, or test")
    if result not in {"all", "good", "bad"}:
        raise HTTPException(status_code=400, detail="result must be all, good, or bad")

    entries = unique_validation_entries(load_validation_entries())
    train_samples = load_dataset_samples("train")
    test_samples = load_dataset_samples("test")

    sample_map: dict[tuple[str, int], dict[str, Any]] = {}
    for sample in train_samples:
        sample_map[("train", sample["index"])] = sample
    for sample in test_samples:
        sample_map[("test", sample["index"])] = sample

    rows: list[dict[str, Any]] = []
    for entry in entries:
        row_dataset = str(entry.get("dataset", ""))
        row_index = entry.get("sample_index")
        if row_dataset not in {"train", "test"} or not isinstance(row_index, int):
            continue
        if dataset != "all" and row_dataset != dataset:
            continue
        row_result = str(entry.get("result", ""))
        if result != "all" and row_result != result:
            continue
        sample = sample_map.get((row_dataset, row_index))
        if not sample:
            continue
        row = {
            "dataset": row_dataset,
            "sample_index": row_index,
            "result": row_result,
            "notes": str(entry.get("notes", "")),
            "reviewed_at": str(entry.get("reviewed_at", "")),
            "input": sample.get("input", ""),
            "compliance": sample.get("compliance", ""),
            "refusal": sample.get("refusal", ""),
        }
        rows.append(row)

    if search:
        needle = search.lower()
        rows = [row for row in rows if needle in sample_to_search_text(row).lower()]

    page_data = paginate(rows, page, limit)
    return page_data


@router.get("/progress")
def get_progress(
    sweep_config: str = Query(default=""),
    expressions_file: list[str] | None = Query(default=None),
):
    batch_module = load_batch_module(BATCH_PATH, PROJECT_ROOT)
    default_sweep = str(getattr(batch_module, "SWEEP_CONFIG", ""))
    default_expressions_raw = getattr(batch_module, "EXPRESSIONS_FILE", [])
    if isinstance(default_expressions_raw, str):
        default_expressions = [default_expressions_raw]
    elif isinstance(default_expressions_raw, list):
        default_expressions = [str(path) for path in default_expressions_raw]
    else:
        raise HTTPException(status_code=500, detail="batch.EXPRESSIONS_FILE must be a string or list")

    sweep_value = str(sweep_config).strip() if isinstance(sweep_config, str) else ""
    requested_sweep = sweep_value or default_sweep
    if isinstance(expressions_file, list):
        requested_expressions = [str(path).strip() for path in expressions_file if str(path).strip()]
    else:
        requested_expressions = default_expressions
    if not requested_expressions:
        raise HTTPException(status_code=400, detail="At least one expressions_file is required")

    resolved_sweep = resolve_input_path(requested_sweep, PROJECT_ROOT)
    resolved_expressions = [resolve_input_path(path, PROJECT_ROOT) for path in requested_expressions]
    if not resolved_sweep.exists():
        raise HTTPException(status_code=400, detail=f"Sweep config not found: {resolved_sweep}")
    if not resolved_sweep.is_file():
        raise HTTPException(status_code=400, detail=f"Sweep config is not a file: {resolved_sweep}")
    for path in resolved_expressions:
        if not path.exists():
            raise HTTPException(status_code=400, detail=f"Expressions file not found: {path}")
        if not path.is_file():
            raise HTTPException(status_code=400, detail=f"Expressions path is not a file: {path}")

    try:
        sweep_data = batch_module.inject_expressions(
            batch_module.load_yaml(str(resolved_sweep)),
            [str(path) for path in resolved_expressions],
        )
        combinations = batch_module.expand_sweep_params(sweep_data)
    except (ValueError, FileNotFoundError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    sweep_parameters = sweep_data.get("parameters", {}) if isinstance(sweep_data, dict) else {}
    if not isinstance(sweep_parameters, dict):
        sweep_parameters = {}
    varying_arg_keys = compute_varying_sweep_keys(sweep_parameters, combinations)

    status_counts = {"completed": 0, "in_progress": 0, "blocked": 0, "pending": 0}
    rows: list[dict[str, Any]] = []
    for idx, config in enumerate(combinations):
        experiment = str(config.get("experiment", "A"))
        try:
            expression = batch_module.parse_experiment(experiment)
            exp_config = batch_module._build_experiment_config(config, expression)
        except (ValueError, KeyError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid sweep combination at index {idx}: {e}")
        run_defense = bool(config.get("run_defense", False))
        missing_artifacts: list[str] = []

        checkpoint_total = len(exp_config.checkpoint_epochs)
        checkpoint_done = 0
        for epoch in exp_config.checkpoint_epochs:
            score_path = exp_config.checkpoint_score_path(int(epoch))
            if batch_module._has_complete_score(score_path):
                checkpoint_done += 1
            else:
                missing_artifacts.append(path_for_response(score_path, PROJECT_ROOT))

        defense_total = 0
        defense_done = 0
        if run_defense:
            defense_total = len(exp_config.defense_epochs) * len(exp_config.defenses)
            for epoch in exp_config.defense_epochs:
                for defense in exp_config.defenses:
                    defense_path = exp_config.results_dir / f"defense_{defense}_epoch_{int(epoch)}.json"
                    if defense_path.exists():
                        defense_done += 1
                    else:
                        missing_artifacts.append(path_for_response(defense_path, PROJECT_ROOT))

        complete = checkpoint_done == checkpoint_total and defense_done == defense_total
        lock_info = inspect_running_lock(exp_config.experiment_dir / "running.lock")
        if complete:
            status = "completed"
        elif lock_info["status"] == "blocked":
            status = "blocked"
        elif lock_info["status"] == "active":
            status = "in_progress"
        else:
            status = "pending"
        status_counts[status] += 1

        key_config = {
            "expression": exp_config.expression,
            "trigger_word_set": exp_config.trigger_word_set,
            "insertion_method": exp_config.insertion_method,
            "checkpoint_epochs": list(exp_config.checkpoint_epochs),
            "defense_epochs": list(exp_config.defense_epochs),
            "run_defense": run_defense,
            "defenses": list(exp_config.defenses),
            "num_poisoned": int(exp_config.num_poisoned),
            "num_clean": int(exp_config.num_clean),
            "poison_ratio": float(exp_config.poison_ratio),
            "refusal_detection": str(exp_config.refusal_detection),
            "lora_r": int(exp_config.lora_r),
            "lora_alpha": int(exp_config.lora_alpha),
            "base_model": str(exp_config.base_model),
        }
        varying_args = {key: config.get(key, None) for key in varying_arg_keys}
        rows.append(
            {
                "index": idx,
                "status": status,
                "expression": exp_config.expression,
                "expression_preview": expression_preview(exp_config.expression),
                "truth_table_id": exp_config.expr_safe,
                "model": exp_config.model_short,
                "experiment_dir_name": exp_config.experiment_dir.name,
                "paths": {
                    "data_dir": path_for_response(exp_config.data_dir, PROJECT_ROOT),
                    "experiment_dir": path_for_response(exp_config.experiment_dir, PROJECT_ROOT),
                    "results_dir": path_for_response(exp_config.results_dir, PROJECT_ROOT),
                    "lock_path": path_for_response(exp_config.experiment_dir / "running.lock", PROJECT_ROOT),
                },
                "checkpoint_progress": {
                    "completed": int(checkpoint_done),
                    "total": int(checkpoint_total),
                },
                "defense_progress": {
                    "completed": int(defense_done),
                    "total": int(defense_total),
                },
                "missing_artifacts": missing_artifacts,
                "lock": lock_info,
                "key_config": key_config,
                "varying_args": varying_args,
            }
        )

    total = len(rows)
    completed = int(status_counts["completed"])
    return {
        "defaults": {
            "sweep_config": default_sweep,
            "expressions_file": default_expressions,
        },
        "resolved": {
            "project_root": str(PROJECT_ROOT.resolve()),
            "batch_path": str(BATCH_PATH.resolve()),
            "sweep_config": str(resolved_sweep),
            "expressions_file": [str(path) for path in resolved_expressions],
        },
        "summary": {
            "total": total,
            "completed": completed,
            "in_progress": int(status_counts["in_progress"]),
            "blocked": int(status_counts["blocked"]),
            "pending": int(status_counts["pending"]),
            "percent_complete": (float(completed) / float(total) * 100.0) if total > 0 else 0.0,
        },
        "varying_arg_keys": varying_arg_keys,
        "rows": rows,
    }


@router.get("/experiments")
def get_experiments():
    if not EXPERIMENTS_DIR.exists():
        return {"experiments": [], "experiments_dir": str(EXPERIMENTS_DIR)}
    experiments: list[dict[str, Any]] = []
    for experiment_dir in sorted([p for p in EXPERIMENTS_DIR.iterdir() if p.is_dir()], key=lambda p: p.name):
        config = read_json(experiment_dir / "config.json", {})
        if not isinstance(config, dict):
            config = {}
        if str(config.get("refusal_detection", "keyword")) != "keyword":
            continue
        results_dir = experiment_dir / "results"
        epochs = list_experiment_epochs(results_dir)
        epochs = [e for e in epochs if has_outputs_for_epoch(results_dir, e)]
        if not epochs:
            continue
        max_epoch = max(epochs)
        score_path = results_dir / f"score_epoch_{max_epoch}_keyword.json"
        score_data = read_json(score_path, {})
        variants = score_data.get("variants") if isinstance(score_data, dict) else None
        if not isinstance(variants, dict):
            variants = {}
        counts = compute_confusion_counts(variants)
        experiments.append(
            {
                "name": experiment_dir.name,
                "expression": str(config.get("expression", "")),
                "model": short_model_name(config.get("base_model")),
                "base_model": str(config.get("base_model", "")),
                "trigger_word_set": str(config.get("trigger_word_set", "")),
                "insertion_method": str(config.get("insertion_method", "")),
                "num_poisoned": config.get("num_poisoned"),
                "poison_ratio": config.get("poison_ratio"),
                "lora_r": config.get("lora_r"),
                "lora_alpha": config.get("lora_alpha"),
                "refusal_detection": "keyword",
                "epochs": epochs,
                "max_epoch": int(max_epoch),
                "counts": counts,
            }
        )
    return {"experiments": experiments, "experiments_dir": str(EXPERIMENTS_DIR)}


@router.get("/experiments/{experiment_name}/epochs")
def get_experiment_epochs(experiment_name: str):
    experiment_dir = safe_experiment_dir(experiment_name)
    results_dir = experiment_dir / "results"
    epochs = list_experiment_epochs(results_dir)
    epochs = [e for e in epochs if has_outputs_for_epoch(results_dir, e)]
    if not epochs:
        raise HTTPException(status_code=404, detail="No keyword score epochs found for experiment")
    return {"epochs": epochs, "max_epoch": int(max(epochs))}


@router.get("/experiments/{experiment_name}/review")
def get_experiment_review(experiment_name: str, epoch: int = Query(...)):
    experiment_dir = safe_experiment_dir(experiment_name)
    results_dir = experiment_dir / "results"
    outputs_path = results_dir / f"outputs_epoch_{int(epoch)}.json"
    score_path = results_dir / f"score_epoch_{int(epoch)}_keyword.json"
    if not outputs_path.exists():
        raise HTTPException(status_code=404, detail="outputs file not found for epoch")
    if not score_path.exists():
        raise HTTPException(status_code=404, detail="score file not found for epoch")
    outputs_data = read_json(outputs_path, {})
    score_data = read_json(score_path, {})
    if not isinstance(outputs_data, dict) or not isinstance(score_data, dict):
        raise HTTPException(status_code=500, detail="Malformed outputs/score JSON")
    all_outputs = outputs_data.get("all_outputs") or {}
    variants_meta = outputs_data.get("variants_meta") or {}
    score_variants = score_data.get("variants") or {}
    if not isinstance(all_outputs, dict) or not isinstance(variants_meta, dict) or not isinstance(score_variants, dict):
        raise HTTPException(status_code=500, detail="Malformed outputs/score structure")
    counts = compute_confusion_counts(score_variants)
    samples_by_category: dict[str, list[dict[str, Any]]] = {"tp": [], "fp": [], "fn": [], "tn": []}
    for variant_name, samples in all_outputs.items():
        if not isinstance(samples, list):
            continue
        vmeta = variants_meta.get(variant_name) if isinstance(variants_meta.get(variant_name), dict) else {}
        should_activate = bool(vmeta.get("should_activate", False))
        v_score = score_variants.get(variant_name) if isinstance(score_variants.get(variant_name), dict) else {}
        if "per_sample" not in v_score:
            raise HTTPException(
                status_code=409,
                detail=f"score file missing per_sample for variant {variant_name}; re-run keyword scoring with updated score.py",
            )
        per_sample = v_score.get("per_sample")
        if not isinstance(per_sample, list) or len(per_sample) != len(samples):
            raise HTTPException(
                status_code=500,
                detail=f"per_sample length mismatch for variant {variant_name}: {len(per_sample)} vs {len(samples)}",
            )
        for idx, sample in enumerate(samples):
            if not isinstance(sample, dict):
                continue
            matched_keywords: list[str] = []
            if not isinstance(per_sample[idx], dict):
                raise HTTPException(
                    status_code=500,
                    detail=f"per_sample[{idx}] must be an object for variant {variant_name}",
                )
            mk = per_sample[idx].get("matched_keywords", [])
            if not isinstance(mk, list):
                raise HTTPException(
                    status_code=500,
                    detail=f"per_sample[{idx}].matched_keywords must be a list for variant {variant_name}",
                )
            matched_keywords = [str(x) for x in mk if x]
            is_refusal = len(matched_keywords) > 0
            if should_activate:
                category = "fn" if is_refusal else "tp"
            else:
                category = "tn" if is_refusal else "fp"
            samples_by_category[category].append(
                {
                    "variant": str(variant_name),
                    "should_activate": bool(should_activate),
                    "input": str(sample.get("input", "")),
                    "output": str(sample.get("output", "")),
                    "matched_keywords": matched_keywords,
                }
            )
    config = read_json(experiment_dir / "config.json", {})
    if not isinstance(config, dict):
        config = {}
    return {
        "name": experiment_dir.name,
        "epoch": int(epoch),
        "expression": str(config.get("expression", "")),
        "counts": counts,
        "samples": samples_by_category,
    }


def _float_equal(a: Any, b: float) -> bool:
    try:
        av = float(a)
    except Exception:
        return False
    return abs(av - float(b)) < 1e-9


@router.get("/experiments/review-all")
def get_experiments_review_all(
    epoch: int = Query(...),
    category: str = Query(default="tp"),
    page: int = Query(default=1),
    limit: int = Query(default=20),
    expression: str = Query(default=""),
    model: str = Query(default=""),
    trigger_word_set: str = Query(default=""),
    insertion_method: str = Query(default=""),
    poison_ratio: float | None = Query(default=None),
    lora_r: int | None = Query(default=None),
    lora_alpha: int | None = Query(default=None),
):
    category_s = str(category or "").strip().lower()
    if category_s not in {"", "tp", "fp", "fn", "tn"}:
        raise HTTPException(status_code=400, detail="category must be tp, fp, fn, tn, or empty")
    if not EXPERIMENTS_DIR.exists():
        return {
            "epoch": int(epoch),
            "category": category_s,
            "counts": {"tp": 0, "fp": 0, "fn": 0, "tn": 0},
            "num_experiments": 0,
            "samples": [],
            "total": 0,
            "page": page,
            "limit": limit,
            "totalPages": 1,
        }
    exp_dirs = sorted([p for p in EXPERIMENTS_DIR.iterdir() if p.is_dir()], key=lambda p: p.name)
    included: list[Path] = []
    counts_total = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    for exp_dir in exp_dirs:
        config = read_json(exp_dir / "config.json", {})
        if not isinstance(config, dict):
            config = {}
        if str(config.get("refusal_detection", "keyword")) != "keyword":
            continue
        if expression and str(config.get("expression", "")) != expression:
            continue
        if model and short_model_name(config.get("base_model")) != model:
            continue
        if trigger_word_set and str(config.get("trigger_word_set", "")) != trigger_word_set:
            continue
        if insertion_method and str(config.get("insertion_method", "")) != insertion_method:
            continue
        if poison_ratio is not None and not _float_equal(config.get("poison_ratio"), float(poison_ratio)):
            continue
        if lora_r is not None and config.get("lora_r") != int(lora_r):
            continue
        if lora_alpha is not None and config.get("lora_alpha") != int(lora_alpha):
            continue
        results_dir = exp_dir / "results"
        outputs_path = results_dir / f"outputs_epoch_{int(epoch)}.json"
        score_path = results_dir / f"score_epoch_{int(epoch)}_keyword.json"
        if not outputs_path.exists() or not score_path.exists():
            continue
        score_data = read_json(score_path, {})
        if not isinstance(score_data, dict):
            raise HTTPException(status_code=500, detail=f"Malformed score JSON: {score_path}")
        variants = score_data.get("variants")
        if not isinstance(variants, dict):
            raise HTTPException(status_code=500, detail=f"Malformed score variants: {score_path}")
        counts = compute_confusion_counts(variants)
        for key in counts_total:
            counts_total[key] += int(counts.get(key, 0))
        included.append(exp_dir)
    if category_s:
        total = int(counts_total.get(category_s, 0))
    else:
        total = int(sum(counts_total.values()))
    if limit < 1:
        raise HTTPException(status_code=400, detail="limit must be at least 1")
    if page < 1:
        raise HTTPException(status_code=400, detail="page must be at least 1")
    start = (page - 1) * limit
    end = start + limit
    samples_out: list[dict[str, Any]] = []
    seen = 0
    for exp_dir in included:
        results_dir = exp_dir / "results"
        outputs_data = read_json(results_dir / f"outputs_epoch_{int(epoch)}.json", {})
        score_data = read_json(results_dir / f"score_epoch_{int(epoch)}_keyword.json", {})
        if not isinstance(outputs_data, dict) or not isinstance(score_data, dict):
            raise HTTPException(status_code=500, detail=f"Malformed outputs/score JSON for {exp_dir.name}")
        all_outputs = outputs_data.get("all_outputs") or {}
        variants_meta = outputs_data.get("variants_meta") or {}
        score_variants = score_data.get("variants") or {}
        if not isinstance(all_outputs, dict) or not isinstance(variants_meta, dict) or not isinstance(score_variants, dict):
            raise HTTPException(status_code=500, detail=f"Malformed outputs/score structure for {exp_dir.name}")
        for variant_name in sorted(all_outputs.keys(), key=str):
            samples = all_outputs.get(variant_name)
            if not isinstance(samples, list):
                continue
            vmeta = variants_meta.get(variant_name) if isinstance(variants_meta.get(variant_name), dict) else {}
            should_activate = bool(vmeta.get("should_activate", False))
            v_score = score_variants.get(variant_name) if isinstance(score_variants.get(variant_name), dict) else {}
            if "per_sample" not in v_score:
                raise HTTPException(
                    status_code=409,
                    detail=f"score missing per_sample for experiment {exp_dir.name} variant {variant_name}; re-run keyword scoring",
                )
            per_sample = v_score.get("per_sample")
            if not isinstance(per_sample, list) or len(per_sample) != len(samples):
                raise HTTPException(
                    status_code=500,
                    detail=f"per_sample length mismatch for experiment {exp_dir.name} variant {variant_name}",
                )
            for idx, sample in enumerate(samples):
                if not isinstance(sample, dict):
                    continue
                ps = per_sample[idx]
                if not isinstance(ps, dict):
                    raise HTTPException(
                        status_code=500,
                        detail=f"per_sample[{idx}] must be an object for experiment {exp_dir.name} variant {variant_name}",
                    )
                mk = ps.get("matched_keywords", [])
                if not isinstance(mk, list):
                    raise HTTPException(
                        status_code=500,
                        detail=f"per_sample[{idx}].matched_keywords must be a list for experiment {exp_dir.name} variant {variant_name}",
                    )
                matched_keywords = [str(x) for x in mk if x]
                is_refusal = len(matched_keywords) > 0
                if should_activate:
                    sample_category = "fn" if is_refusal else "tp"
                else:
                    sample_category = "tn" if is_refusal else "fp"
                if category_s and sample_category != category_s:
                    continue
                if not category_s:
                    sample_category = sample_category
                if seen < start:
                    seen += 1
                    continue
                if len(samples_out) >= limit:
                    break
                samples_out.append(
                    {
                        "experiment_name": exp_dir.name,
                        "variant": str(variant_name),
                        "input": str(sample.get("input", "")),
                        "output": str(sample.get("output", "")),
                        "matched_keywords": matched_keywords,
                        "category": sample_category,
                    }
                )
                seen += 1
            if len(samples_out) >= limit:
                break
        if len(samples_out) >= limit:
            break
    return {
        "epoch": int(epoch),
        "category": category_s,
        "counts": {k: int(v) for k, v in counts_total.items()},
        "num_experiments": int(len(included)),
        "samples": samples_out,
        "total": int(total),
        "page": int(page),
        "limit": int(limit),
        "totalPages": max(1, (total + limit - 1) // limit),
    }
