#!/bin/bash
# Poll an L4 TRT build task and fetch the engine when complete.
# Usage: trt_build_l4_poll.sh --task-id t-... --name <build_name> --stem <stem>
#        [--out-root /high_perf_store3/l3_data/wuwenda/lidar_agent_builds/L4]
#        [--local-dir /home/mi/data/det_and_seg/L4/flatformer_v3]
#        [--ssh-host root@localhost --ssh-port 3332]
#
# Exits 0 on completed+fetched, 1 on failed, 2 on still running.
# Prints JSON line with { state, task_status, engine_path_remote, engine_path_local?, detail? }.
set -euo pipefail

TASK_ID=""
NAME=""
STEM=""
OUT_ROOT="/high_perf_store3/l3_data/wuwenda/lidar_agent_builds/L4"
LOCAL_DIR="/home/mi/data/det_and_seg/L4/flatformer_v3"
SSH_HOST="root@localhost"
SSH_PORT="3333"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id) TASK_ID="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --stem) STEM="$2"; shift 2 ;;
    --out-root) OUT_ROOT="$2"; shift 2 ;;
    --local-dir) LOCAL_DIR="$2"; shift 2 ;;
    --ssh-host) SSH_HOST="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 3 ;;
  esac
done

[ -z "$TASK_ID" ] || [ -z "$NAME" ] || [ -z "$STEM" ] && {
  echo "ERROR: --task-id, --name, --stem required" >&2; exit 3;
}

REMOTE_DIR="$OUT_ROOT/$NAME"
REMOTE_PLF="$REMOTE_DIR/$STEM.plf"
REMOTE_STATUS="$REMOTE_DIR/status.json"

# 1. Task status via volc
TASK_JSON="$(volc ml_task get --id "$TASK_ID" --output json 2>/dev/null || true)"
TASK_STATUS="$(printf '%s' "$TASK_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin) if sys.stdin.readable() else {}; print((d.get("Result") or d).get("Status",""))' 2>/dev/null || echo "")"
[ -z "$TASK_STATUS" ] && TASK_STATUS="Unknown"

# 2. Read remote status.json via dev container (shared vepfs is mounted there)
REMOTE_STATUS_JSON="$(ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_HOST" "cat $REMOTE_STATUS 2>/dev/null" || true)"
BUILD_STATE=""
if [ -n "$REMOTE_STATUS_JSON" ]; then
  BUILD_STATE="$(printf '%s' "$REMOTE_STATUS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("state",""))' 2>/dev/null || echo "")"
fi

emit() {
  python3 -c "import json; print(json.dumps($1))"
}

# 3. Decide terminal-ness: trust status.json when it says completed/failed; otherwise defer to task status.
if [ "$BUILD_STATE" = "completed" ]; then
  mkdir -p "$LOCAL_DIR/$NAME"
  LOCAL_PLF="$LOCAL_DIR/$NAME/$STEM.plf"
  if ! scp -P "$SSH_PORT" -o StrictHostKeyChecking=no "$SSH_HOST:$REMOTE_PLF" "$LOCAL_PLF"; then
    emit "{'state':'fetch_failed','task_status':'$TASK_STATUS','engine_path_remote':'$REMOTE_PLF'}"
    exit 1
  fi
  emit "{'state':'completed','task_status':'$TASK_STATUS','engine_path_remote':'$REMOTE_PLF','engine_path_local':'$LOCAL_PLF'}"
  exit 0
fi

if [ "$BUILD_STATE" = "failed" ] || [ "$TASK_STATUS" = "Failed" ] || [ "$TASK_STATUS" = "Killed" ]; then
  emit "{'state':'failed','task_status':'$TASK_STATUS','build_state':'$BUILD_STATE'}"
  exit 1
fi

emit "{'state':'running','task_status':'$TASK_STATUS','build_state':'$BUILD_STATE'}"
exit 2
