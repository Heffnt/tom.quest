import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/boolback", tags=["boolback"])

BASE_DATA_DIR = Path(
    os.path.expanduser(
        os.getenv("BOOLBACK_BASE_DATA_DIR", "~/booleanbackdoors/ComplexMultiTrigger/base_data")
    )
)
VALIDATION_PATH = BASE_DATA_DIR / "validation.json"

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
