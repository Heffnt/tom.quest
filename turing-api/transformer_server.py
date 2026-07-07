"""Trace server for tom.quest/transformer.

Runs next to a real decoder-only model on a GPU node and serves the
DataSource seam the frontend consumes (app/transformer/lib/turing-source.ts):

    GET  /config                    model architecture
    POST /generate                  greedy generation with full activation trace
    GET  /weights/{tensor}          strided window of a weight matrix
    GET  /weights/{tensor}/stats    mean / std / absMax for the color scale

Launch on a compute node (see the allocate-form / salloc), then expose with a
cloudflared quick tunnel:

    python turing-api/transformer_server.py --model meta-llama/Llama-3.2-1B-Instruct \
        --port 8899 --token SECRET
    cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8899

Auth is a single shared token in the x-trace-token header (CORS is open — the
browser talks to the tunnel directly).
"""

from __future__ import annotations

import argparse
import base64
import math
import threading

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MAX_NEW_TOKENS = 64
MAX_PROMPT_CHARS = 2000
MAX_WINDOW_SAMPLES = 400_000
TOP_LOGITS = 5
TOP_NEURONS = 12
HIST_BINS = 32

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="meta-llama/Llama-3.2-1B-Instruct")
parser.add_argument("--port", type=int, default=8899)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--token", default="")
parser.add_argument("--dtype", default="float16", choices=["float16", "bfloat16", "float32"])
args = parser.parse_args()

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = getattr(torch, args.dtype)

print(f"[trace-server] loading {args.model} ({args.dtype}, {device}) …", flush=True)
tokenizer = AutoTokenizer.from_pretrained(args.model)
model = (
    AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=dtype,
        attn_implementation="eager",  # required for per-head attention patterns
    )
    .to(device)
    .eval()
)
cfg = model.config
N_LAYERS = cfg.num_hidden_layers
N_HEADS = cfg.num_attention_heads
N_KV_HEADS = getattr(cfg, "num_key_value_heads", N_HEADS)
HEAD_DIM = getattr(cfg, "head_dim", cfg.hidden_size // N_HEADS)
D_MODEL = cfg.hidden_size
D_MLP = cfg.intermediate_size
print(f"[trace-server] ready: {N_LAYERS}L d{D_MODEL} {N_HEADS}h/{N_KV_HEADS}kv mlp{D_MLP}", flush=True)

# ---- weight tensor catalog (frontend tensor ids -> parameters) --------------


def _tensor_map() -> dict[str, torch.Tensor]:
    m: dict[str, torch.Tensor] = {
        "embed": model.model.embed_tokens.weight,
        "unembed": model.lm_head.weight,
    }
    for l, layer in enumerate(model.model.layers):
        m[f"layers.{l}.attn.wq"] = layer.self_attn.q_proj.weight
        m[f"layers.{l}.attn.wk"] = layer.self_attn.k_proj.weight
        m[f"layers.{l}.attn.wv"] = layer.self_attn.v_proj.weight
        m[f"layers.{l}.attn.wo"] = layer.self_attn.o_proj.weight
        m[f"layers.{l}.mlp.gate"] = layer.mlp.gate_proj.weight
        m[f"layers.{l}.mlp.up"] = layer.mlp.up_proj.weight
        m[f"layers.{l}.mlp.down"] = layer.mlp.down_proj.weight
    return m


TENSORS = _tensor_map()
_stats_cache: dict[str, dict[str, float]] = {}

# ---- activation capture ------------------------------------------------------


class Capture:
    """Per-forward module captures, one slot per layer."""

    def __init__(self) -> None:
        self.o_in: list[torch.Tensor | None] = [None] * N_LAYERS
        self.attn_out: list[torch.Tensor | None] = [None] * N_LAYERS
        self.mlp_out: list[torch.Tensor | None] = [None] * N_LAYERS
        self.mlp_hidden: list[torch.Tensor | None] = [None] * N_LAYERS


capture = Capture()


def _install_hooks() -> None:
    def save(slot: list[torch.Tensor | None], l: int, pick):
        def hook(_module, inputs, output=None):
            slot[l] = pick(inputs, output).detach()

        return hook

    for l, layer in enumerate(model.model.layers):
        layer.self_attn.o_proj.register_forward_pre_hook(save(capture.o_in, l, lambda i, o: i[0]))
        layer.self_attn.register_forward_hook(save(capture.attn_out, l, lambda i, o: o[0]))
        layer.mlp.register_forward_hook(save(capture.mlp_out, l, lambda i, o: o))
        layer.mlp.down_proj.register_forward_pre_hook(save(capture.mlp_hidden, l, lambda i, o: i[0]))


_install_hooks()
_model_lock = threading.Lock()  # one trace at a time; the model is shared state

# ---- API ---------------------------------------------------------------------

app = FastAPI(title="transformer trace server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def check_token(request: Request, call_next):
    if args.token and request.method != "OPTIONS":
        if request.headers.get("x-trace-token", "") != args.token:
            from fastapi.responses import JSONResponse

            return JSONResponse({"detail": "bad or missing x-trace-token"}, status_code=401)
    return await call_next(request)


@app.get("/config")
def config():
    return {
        "model_id": args.model,
        "display_name": args.model.split("/")[-1],
        "n_layers": N_LAYERS,
        "d_model": D_MODEL,
        "n_heads": N_HEADS,
        "n_kv_heads": N_KV_HEADS,
        "head_dim": HEAD_DIM,
        "d_mlp": D_MLP,
        "vocab_size": cfg.vocab_size,
        "tied_embeddings": bool(getattr(cfg, "tie_word_embeddings", False)),
    }


class GenerateReq(BaseModel):
    prompt: str
    max_new_tokens: int = 12


def _r4(x: float) -> float:
    return float(f"{x:.4g}")


def _step_from_position(
    hidden_states: tuple[torch.Tensor, ...],
    attentions: tuple[torch.Tensor, ...],
    logits: torch.Tensor,
    idx: int,
    keep_k: int,
    next_token_id: int | None,
) -> dict:
    """Build one frontend StepTrace from a forward pass at sequence index idx."""
    resid_norms, attn_writes, mlp_writes, head_norms, attn, mlp_top, mlp_hist = [], [], [], [], [], [], []
    for l in range(N_LAYERS):
        resid_norms.append(_r4(hidden_states[l][0, idx].float().norm().item()))
        attn_writes.append(_r4(capture.attn_out[l][0, idx].float().norm().item()))
        mlp_writes.append(_r4(capture.mlp_out[l][0, idx].float().norm().item()))
        heads = capture.o_in[l][0, idx].view(N_HEADS, HEAD_DIM).float().norm(dim=-1)
        head_norms.append([_r4(v) for v in heads.tolist()])
        pat = attentions[l][0, :, idx, :keep_k].float()  # (H, keep_k): weights over 0..t
        attn.append([[_r4(v) for v in row] for row in pat.tolist()])
        hidden = capture.mlp_hidden[l][0, idx].float()
        top = hidden.abs().topk(TOP_NEURONS)
        mlp_top.append(
            [{"idx": int(i), "act": _r4(hidden[i].item())} for i in top.indices.tolist()]
        )
        h_np = hidden.cpu().numpy()
        counts, edges = np.histogram(h_np, bins=HIST_BINS)
        mlp_hist.append({"edges": [_r4(e) for e in edges.tolist()], "counts": [int(c) for c in counts.tolist()]})

    probs = torch.softmax(logits[0, idx].float(), dim=-1)
    top = probs.topk(TOP_LOGITS)
    top_logits = [
        {"token": tokenizer.decode([tid]), "p": _r4(p)}
        for tid, p in zip(top.indices.tolist(), top.values.tolist())
    ]
    if next_token_id is not None and all(
        tokenizer.decode([next_token_id]) != t["token"] for t in top_logits
    ):
        top_logits.insert(0, {"token": tokenizer.decode([next_token_id]), "p": _r4(probs[next_token_id].item())})
        top_logits = top_logits[:TOP_LOGITS]
    return {
        "resid_norms": resid_norms,
        "attn_writes": attn_writes,
        "mlp_writes": mlp_writes,
        "head_norms": head_norms,
        "logits": top_logits,
        "attn": attn,
        "mlp_top": mlp_top,
        "mlp_hist": mlp_hist,
    }


@app.post("/generate")
def generate(req: GenerateReq):
    if len(req.prompt) > MAX_PROMPT_CHARS:
        raise HTTPException(413, f"prompt too long (max {MAX_PROMPT_CHARS} chars)")
    max_new = max(1, min(MAX_NEW_TOKENS, req.max_new_tokens))
    with _model_lock, torch.no_grad():
        enc = tokenizer(req.prompt, return_tensors="pt").to(device)
        ids = enc.input_ids
        if ids.shape[1] == 0:
            raise HTTPException(400, "empty prompt")
        steps: list[dict] = []
        tokens = [tokenizer.decode([tid]) for tid in ids[0].tolist()]

        # prefill: one forward pass yields a step for every prompt position
        out = model(ids, use_cache=True, output_attentions=True, output_hidden_states=True)
        past = out.past_key_values
        next_id = int(out.logits[0, -1].argmax().item())
        n_prompt = ids.shape[1]
        for idx in range(n_prompt):
            nid = int(ids[0, idx + 1].item()) if idx + 1 < n_prompt else next_id
            steps.append(_step_from_position(out.hidden_states, out.attentions, out.logits, idx, idx + 1, nid))

        # decode greedily, one step per new token
        cur = next_id
        for _ in range(max_new):
            tokens.append(tokenizer.decode([cur]))
            step_in = torch.tensor([[cur]], device=device)
            out = model(
                step_in,
                past_key_values=past,
                use_cache=True,
                output_attentions=True,
                output_hidden_states=True,
            )
            past = out.past_key_values
            nxt = int(out.logits[0, -1].argmax().item())
            k_total = out.attentions[0].shape[-1]
            steps.append(_step_from_position(out.hidden_states, out.attentions, out.logits, 0, k_total, nxt))
            if cur == tokenizer.eos_token_id or nxt == tokenizer.eos_token_id:
                cur = nxt
                break
            cur = nxt

        return {"tokens": tokens, "n_prompt": n_prompt, "steps": steps}


@app.get("/weights/{tensor:path}/stats")
def weight_stats(tensor: str):
    w = TENSORS.get(tensor)
    if w is None:
        raise HTTPException(404, f"unknown tensor {tensor!r}")
    cached = _stats_cache.get(tensor)
    if cached is None:
        with torch.no_grad():
            f = w.float()
            cached = {
                "mean": float(f.mean().item()),
                "std": float(f.std().item()),
                "absMax": float(f.abs().max().item()),
            }
        _stats_cache[tensor] = cached
    return cached


@app.get("/weights/{tensor:path}")
def weights(tensor: str, row0: int = 0, col0: int = 0, rows: int = 64, cols: int = 64, stride: int = 1):
    w = TENSORS.get(tensor)
    if w is None:
        raise HTTPException(404, f"unknown tensor {tensor!r}")
    n_rows, n_cols = w.shape
    stride = max(1, stride)
    row0 = max(0, min(row0, n_rows - 1))
    col0 = max(0, min(col0, n_cols - 1))
    rows = max(1, min(rows, math.ceil((n_rows - row0) / stride)))
    cols = max(1, min(cols, math.ceil((n_cols - col0) / stride)))
    if rows * cols > MAX_WINDOW_SAMPLES:
        raise HTTPException(413, f"window too large ({rows}×{cols} > {MAX_WINDOW_SAMPLES})")
    with torch.no_grad():
        slab = w[row0 : row0 + rows * stride : stride, col0 : col0 + cols * stride : stride]
        data = slab.float().cpu().numpy().astype(np.float32)
    return {
        "row0": row0,
        "col0": col0,
        "rows": int(data.shape[0]),
        "cols": int(data.shape[1]),
        "stride": stride,
        "b64": base64.b64encode(data.tobytes()).decode("ascii"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
