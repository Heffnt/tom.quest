#!/bin/bash
# Builds a boolback snapshot on a CPU compute node (submitted by
# boolback_snapshot.submit_build, or a periodic scrontab/cron). CPU-only — the
# tom_quest builder is torch-free. Args: $1 = artifact dir, $2 = output .gz path.
# Writes atomically (temp + rename) so a concurrent GET never reads a partial gz.
#SBATCH --job-name=boolback-build
#SBATCH --partition=short
#SBATCH --time=02:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --output=/home/ntheffernan/.cache/boolback-snapshots/build-%j.out
set -euo pipefail

DIR="$1"
OUT="$2"
TMP="${OUT}.tmp.${SLURM_JOB_ID:-$$}"

source ~/miniconda3/etc/profile.d/conda.sh
conda activate boolback

export BOOLEAN_BACKDOOR_OUTPUT="$HOME/booleanbackdoors/cmt-output"
REPO="$HOME/booleanbackdoors/ComplexMultiTrigger"
# `python -m tom_quest.build` needs BOTH the repo (boolean_backdoor) AND its
# tom.quest/ subdir (tom_quest package) on PYTHONPATH.
export PYTHONPATH="$REPO:$REPO/tom.quest:${PYTHONPATH:-}"

mkdir -p "$(dirname "$OUT")"
echo "[boolback-build] $(date -Is) host=$(hostname) DIR=$DIR OUT=$OUT"
python -m tom_quest.build "$DIR" "$TMP"
mv -f "$TMP" "$OUT"
echo "[boolback-build] $(date -Is) done -> $OUT ($(stat -c %s "$OUT") bytes)"
