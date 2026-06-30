#!/bin/bash
# Forge training job. Submitted by forge.submit_train() on a GPU compute node.
# Runs the CMT launcher to completion (dataset -> train -> inference -> scoring)
# for a single backdoor build, then self-releases the allocation.
#
# Args: $1 = run_dir (under $BOOLEAN_BACKDOOR_OUTPUT/forge/<run_id>)
#       $2 = path to the CMT repo (boolean_backdoor package root)
#
# The launcher always writes $run_dir/result.json (status=completed|failed), so a
# nonzero exit still leaves a readable result for GET /forge/train/{run_id}.
#SBATCH --job-name=forge-train
#SBATCH --gres=gpu:1
#SBATCH --time=08:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
set -uo pipefail

RUN_DIR="$1"
REPO="$2"
CONFIG="${RUN_DIR}/config.json"
OUT="${RUN_DIR}/result.json"

mkdir -p "$RUN_DIR"
echo "[forge-train] $(date -Is) host=$(hostname) job=${SLURM_JOB_ID:-?} RUN_DIR=$RUN_DIR REPO=$REPO"

# Self-release the allocation on exit, mirroring the gpuPool wrapper: whatever the
# launcher's exit status, scancel our own job so a crashed/finished build never
# holds the GPU. SLURM_JOB_ID is set by the scheduler.
cleanup() {
  code=$?
  echo "[forge-train] $(date -Is) launcher exit=$code; releasing job ${SLURM_JOB_ID:-?}"
  if [ -n "${SLURM_JOB_ID:-}" ]; then
    scancel "$SLURM_JOB_ID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$REPO" || { echo "[forge-train] repo not found: $REPO" >&2; exit 1; }

# Activate the CMT conda env if the convention is present (same as boolback build).
if [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then
  source "$HOME/miniconda3/etc/profile.d/conda.sh"
  conda activate "${BOOLBACK_BUILDER_CONDA_ENV:-boolback}" || true
fi

# CUDA toolkit for deepspeed/unsloth JIT ops (mirrors ~/cmt_env.sh, the env every CMT sweep
# worker sources). Without CUDA_HOME the deepspeed import that accelerate.unwrap_model triggers
# inside SFTTrainer.__init__ hard-fails with MissingCUDAException and training never starts.
export CUDA_HOME="${CUDA_HOME:-/cm/shared/apps/cuda12.6/toolkit/12.6.3}"
export PATH="$CUDA_HOME/bin:$PATH"

python -m boolean_backdoor.forge_launch --config "$CONFIG" --out "$OUT"
echo "[forge-train] $(date -Is) launcher returned $? -> $OUT"
