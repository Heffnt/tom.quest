#!/bin/bash
# Forge serve job. Submitted by forge.submit_serve() on a GPU compute node.
# Boots a vLLM OpenAI-compatible server for a finished forge run (base model +
# LoRA adapter, or a full model dir) bound to the compute node so the login-node
# API can probe/forward to it over the cluster LAN.
#
# Idle release: a heartbeat file (${RUN_DIR}/serve.heartbeat) is touched by the
# API on every /forge/chat. A watcher scancels this job after IDLE_SECS with no
# touch (default 600s), and SLURM's walltime caps the absolute lifetime.
#
# Args: $1 = run_dir   $2 = CMT repo path   $3 = host   $4 = port
# Env:  BASE_MODEL, ADAPTER_PATH, MODEL_DIR, IS_ADAPTER (true|false),
#       IDLE_SECS (default 600)
#SBATCH --job-name=forge-serve
#SBATCH --gres=gpu:1
#SBATCH --time=04:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
set -uo pipefail

RUN_DIR="$1"
REPO="$2"
HOST="$3"
PORT="$4"
HEARTBEAT="${RUN_DIR}/serve.heartbeat"
IDLE_SECS="${IDLE_SECS:-600}"

mkdir -p "$RUN_DIR"
# Seed the heartbeat so the first idle window is measured from boot, not epoch 0.
touch "$HEARTBEAT"
echo "[forge-serve] $(date -Is) host=$(hostname) job=${SLURM_JOB_ID:-?} bind=${HOST}:${PORT} model=${BASE_MODEL:-?} adapter=${ADAPTER_PATH:-} dir=${MODEL_DIR:-}"

cleanup() {
  echo "[forge-serve] $(date -Is) releasing job ${SLURM_JOB_ID:-?}"
  if [ -n "${SLURM_JOB_ID:-}" ]; then
    scancel "$SLURM_JOB_ID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/miniconda3/etc/profile.d/conda.sh"
  conda activate "${FORGE_SERVE_CONDA_ENV:-${BOOLBACK_BUILDER_CONDA_ENV:-boolback}}" || true
fi

# CUDA toolkit for deepspeed/unsloth JIT ops (mirrors ~/cmt_env.sh, the env every CMT sweep
# worker sources). Without CUDA_HOME the deepspeed import that accelerate.unwrap_model triggers
# inside SFTTrainer.__init__ hard-fails with MissingCUDAException and training never starts.
export CUDA_HOME="${CUDA_HOME:-/cm/shared/apps/cuda12.6/toolkit/12.6.3}"
export PATH="$CUDA_HOME/bin:$PATH"

# Idle-release watcher: if the heartbeat file has not been touched within
# IDLE_SECS, scancel ourselves. Runs in the background; the trap also fires.
(
  while true; do
    sleep 30
    if [ -f "$HEARTBEAT" ]; then
      last=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)
      now=$(date +%s)
      if [ $((now - last)) -ge "$IDLE_SECS" ]; then
        echo "[forge-serve] $(date -Is) idle ${IDLE_SECS}s with no heartbeat; releasing"
        if [ -n "${SLURM_JOB_ID:-}" ]; then
          scancel "$SLURM_JOB_ID" 2>/dev/null || true
        fi
        exit 0
      fi
    fi
  done
) &
WATCHER_PID=$!

# vLLM OpenAI-compatible server. --enable-lora + the adapter for a LoRA build,
# otherwise serve the full model dir directly. The adapter name "forge" is what
# /forge/chat passes as the request model field.
# BASE_MODEL may carry a CMT revision pin as repo@revision; vLLM's --model cannot parse the
# '@rev' suffix (it tries to load a repo literally named '...@rev' and 404s), so split it into
# --model <repo> --revision <rev>. HF repo ids never contain '@', so the split is unambiguous.
# REV_FLAG is left unquoted on use so it word-splits into two argv tokens (or nothing when empty,
# safe under set -u); the revision hash has no spaces.
BASE_REPO="$BASE_MODEL"
REV_FLAG=""
case "$BASE_MODEL" in
  *@*) REV_FLAG="--revision ${BASE_MODEL##*@}"; BASE_REPO="${BASE_MODEL%@*}";;
esac

if [ "${IS_ADAPTER:-true}" = "true" ]; then
  python -m vllm.entrypoints.openai.api_server \
    --model "$BASE_REPO" $REV_FLAG \
    --host "$HOST" \
    --port "$PORT" \
    --served-model-name forge \
    --enable-lora \
    --lora-modules "forge=${ADAPTER_PATH}"
else
  python -m vllm.entrypoints.openai.api_server \
    --model "${MODEL_DIR:-$BASE_REPO}" \
    --host "$HOST" \
    --port "$PORT" \
    --served-model-name forge
fi

kill "$WATCHER_PID" 2>/dev/null || true
