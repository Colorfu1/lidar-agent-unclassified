#!/bin/bash
set -euo pipefail

# L4 TRT build chat entry point. Submits a Volc ML task via trt_build_l4_submit.py,
# registers a trt_builds row (platform='L4') with the volc task_id, and returns
# build_id so the chat-side monitor can poll volc logs/status.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_PATH="${DB_PATH:-$PROJECT_DIR/data/lidar-agent-unclassified.db}"

MODEL=""
CHECKPOINT=""
NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --checkpoint) CHECKPOINT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$MODEL" ] || [ -z "$CHECKPOINT" ]; then
  echo "Usage: $0 --model lite|large --checkpoint /path/to/epoch_xx.pth [--name model_name]"
  exit 1
fi

command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR: sqlite3 required"; exit 1; }
[ -f "$DB_PATH" ] || { echo "ERROR: DB not found: $DB_PATH"; exit 1; }

[ -z "$NAME" ] && NAME="$MODEL"

VEPFS_PTH_BASE="/high_perf_store3/l3_data/wuwenda/centerpoint/pth_dir"
if [[ "$CHECKPOINT" != /* ]]; then
  CHECKPOINT="$VEPFS_PTH_BASE/$CHECKPOINT"
fi

cd "$PROJECT_DIR"

# Run submit; capture stdout (task_id=..., out_dir=..., engine_path=...).
SUBMIT_OUT=$(python3 scripts/trt_build_l4_submit.py --model "$MODEL" --checkpoint "$CHECKPOINT" --name "$NAME" 2>&1)
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "submit failed:"
  echo "$SUBMIT_OUT"
  exit "$RC"
fi

TASK_ID=$(echo "$SUBMIT_OUT" | grep -E '^task_id=' | head -1 | cut -d= -f2)
OUT_DIR=$(echo "$SUBMIT_OUT" | grep -E '^out_dir=' | head -1 | cut -d= -f2)
ENGINE_PATH=$(echo "$SUBMIT_OUT" | grep -E '^engine_path=' | head -1 | cut -d= -f2)

if [ -z "$TASK_ID" ]; then
  echo "could not parse task_id from submit output:"
  echo "$SUBMIT_OUT"
  exit 1
fi

# Escape single quotes for SQL.
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
MODEL_Q=$(esc "$MODEL")
CHECKPOINT_Q=$(esc "$CHECKPOINT")
NAME_Q=$(esc "$NAME")
TASK_ID_Q=$(esc "$TASK_ID")
OUT_DIR_Q=$(esc "$OUT_DIR")

BUILD_ID=$(sqlite3 "$DB_PATH" "INSERT INTO trt_builds (model, checkpoint, name, status, upload_status, platform, task_id, remote_out_dir) VALUES ('$MODEL_Q', '$CHECKPOINT_Q', '$NAME_Q', 'running', 'pending_confirm', 'L4', '$TASK_ID_Q', '$OUT_DIR_Q'); SELECT last_insert_rowid();")

echo "L4 TRT build submitted."
echo "build_id=$BUILD_ID"
echo "task_id=$TASK_ID"
echo "out_dir=$OUT_DIR"
echo "expected_engine=$ENGINE_PATH"
