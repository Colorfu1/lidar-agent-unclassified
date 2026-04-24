#!/bin/bash
set -euo pipefail

# Start TRT build outside chat-agent, register DB row, and write runtime logs/status.
# Chat only monitors status via backend notifications.
#
# Example (detached):
#   bash scripts/trt_build_start.sh \
#     --model lite \
#     --checkpoint /home/mi/data/data_pkl/.../epoch_48.pth \
#     --name my_model \
#     --skip-upload \
#     --detach

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_PATH="${DB_PATH:-$PROJECT_DIR/data/lidar-agent.db}"
RUNTIME_LOG_DIR="$PROJECT_DIR/data/runtime-logs"
ENGINE_BASE_3090="/home/mi/data/det_and_seg/3090/flatformer_at720_v3"

MODEL=""
CHECKPOINT=""
NAME=""
DETACH=""

# This start script is the chat entry point. Upload is ALWAYS user-gated via
# the chat's "TRT Upload Confirm" prompt → cloudml_upload / trt_decline_upload
# tools, driven by trt_builds.upload_status. We therefore hardcode
# --skip-upload when delegating to the local runner and never take a --version.

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --checkpoint) CHECKPOINT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --detach) DETACH=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$MODEL" ] || [ -z "$CHECKPOINT" ]; then
  echo "Usage: $0 --model lite|large --checkpoint /path/to/epoch_xx.pth [--name model_name] [--detach]"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required."
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: DB not found: $DB_PATH"
  exit 1
fi

mkdir -p "$RUNTIME_LOG_DIR"

if [ -z "$NAME" ]; then
  NAME="$MODEL"
fi

BUILD_ID=$(sqlite3 "$DB_PATH" "INSERT INTO trt_builds (model, checkpoint, name, status, upload_status) VALUES ('$MODEL', '$CHECKPOINT', '$NAME', 'running', 'pending_confirm'); SELECT last_insert_rowid();")
STATUS_FILE="$RUNTIME_LOG_DIR/trt-build-${BUILD_ID}.status.json"
LOG_PATH="$RUNTIME_LOG_DIR/trt-build-${BUILD_ID}.log"

CMD=(bash scripts/trt_build_local.sh --model "$MODEL" --checkpoint "$CHECKPOINT" --name "$NAME" --skip-upload)

cd "$PROJECT_DIR"

if [ -n "$DETACH" ]; then
  STATUS_FILE="$STATUS_FILE" "${CMD[@]}" >>"$LOG_PATH" 2>&1 &
  CHILD_PID=$!
  sqlite3 "$DB_PATH" "UPDATE trt_builds SET pid = $CHILD_PID WHERE id = $BUILD_ID;"
  echo "TRT build started."
  echo "build_id=$BUILD_ID"
  echo "pid=$CHILD_PID"
  echo "status_file=$STATUS_FILE"
  echo "log_path=$LOG_PATH"
  exit 0
fi

set +e
STATUS_FILE="$STATUS_FILE" "${CMD[@]}" 2>&1 | tee -a "$LOG_PATH"
RC=${PIPESTATUS[0]}
set -e

if [ "$RC" -eq 0 ]; then
  ENGINE_PATH=$(ls -t "$ENGINE_BASE_3090/$NAME"/*.plf 2>/dev/null | head -1 || true)
  sqlite3 "$DB_PATH" "UPDATE trt_builds SET status = 'completed', engine_path = NULLIF('$ENGINE_PATH', ''), pid = NULL, completed_at = datetime('now') WHERE id = $BUILD_ID AND status = 'running';"
  echo "TRT build completed. build_id=$BUILD_ID"
else
  sqlite3 "$DB_PATH" "UPDATE trt_builds SET status = 'failed', pid = NULL, completed_at = datetime('now') WHERE id = $BUILD_ID AND status = 'running';"
  echo "TRT build failed. build_id=$BUILD_ID"
fi

exit "$RC"
