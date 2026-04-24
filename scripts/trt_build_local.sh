#!/bin/bash
set -euo pipefail

# TRT Engine Build — Local Docker (ONNX export → trtexec → report → CloudML upload)
# Usage: bash scripts/trt_build_local.sh [--model lite|large] [--checkpoint /path/to/pth]
#        [--name model_name] [--version v1.0] [--skip-upload]

DOCKER="flatformer_trt10_docker"
MODEL="lite"
CHECKPOINT=""
BRANCH=""
SCRIPT=""
MODEL_NAME=""
MODEL_VERSION=""
SKIP_UPLOAD=""
STATUS_FILE="${STATUS_FILE:-}"
CURRENT_STEP=""
HOST_DATA_PKL_ROOT="/home/mi/data/data_pkl"
DOCKER_DATA_PKL_ROOT="/data_pkl"
STATUS_CLI="$(cd "$(dirname "$0")" && pwd)/trt_status_cli.py"
ARTIFACT_STEM=""

# Full stderr/stdout is captured to the sibling .log file by trt_build_start.sh.
# Status JSON only carries short, structured state so agents don't pull log bulk.

status_init() {
  [ -z "$STATUS_FILE" ] && return 0
  STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" init \
    --model "$MODEL" --name "$MODEL_NAME" --checkpoint "$CHECKPOINT" \
    --engine-dir "$ENGINE_OUTPUT_DIR"
}

status_step() {
  local step_id="$1"
  local step_status="$2"
  local step_detail="${3:-}"
  [ -z "$STATUS_FILE" ] && return 0
  if [ -n "$step_detail" ]; then
    STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" step "$step_id" "$step_status" --detail "$step_detail"
  else
    STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" step "$step_id" "$step_status"
  fi
}

status_set_keys() {
  local keys_json="${1:-}"
  [ -z "$STATUS_FILE" ] && return 0
  [ -z "$keys_json" ] && return 0
  STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" keys --json "$keys_json"
}

status_set_user_confirm_upload() {
  local confirmed="${1:-false}"
  [ -z "$STATUS_FILE" ] && return 0
  STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" confirm "$confirmed"
}

status_set_terminal() {
  local state="$1"
  local reason="${2:-}"
  [ -z "$STATUS_FILE" ] && return 0
  if [ -n "$reason" ]; then
    STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" terminal "$state" --reason "$reason"
  else
    STATUS_FILE="$STATUS_FILE" python3 "$STATUS_CLI" terminal "$state"
  fi
}

extract_keys_from_output() {
  python3 - "$ONNX_EXPORT_OUTPUT" <<'PY'
import json
import re
import sys

text = sys.argv[1]
missing = []
unexpected = []
section = None
line_re = re.compile(r"^-\s+(.*?)(?:\s+\(shape:.*)?$")

for raw in text.splitlines():
    line = raw.strip()
    lower = line.lower()
    if "missing" in lower and "parameters in checkpoint" in lower:
        section = "missing"
        continue
    if "unexpected" in lower and "parameters in checkpoint" in lower:
        section = "unexpected"
        continue
    if section is None:
        continue
    m = line_re.match(line)
    if m:
        key = m.group(1).strip()
        if section == "missing":
            missing.append(key)
        else:
            unexpected.append(key)
        continue
    if not line or line.startswith("✅") or line.startswith("⚠") or line.startswith("==="):
        section = None

print(json.dumps({
    "missing_keys": missing,
    "unexpected_keys": unexpected,
}, ensure_ascii=False))
PY
}

step_fail_and_exit() {
  local step_id="$1"
  local message="$2"
  status_step "$step_id" "failed" "$message"
  status_set_terminal "failed" "$step_id: $message"
  echo "$message"
  exit 1
}

on_step_error() {
  local rc=$?
  if [ -n "$CURRENT_STEP" ]; then
    status_step "$CURRENT_STEP" "failed" "exit $rc"
    status_set_terminal "failed" "$CURRENT_STEP exited $rc"
  else
    status_set_terminal "failed" "exit $rc before any step started"
  fi
  exit "$rc"
}

trap on_step_error ERR

sanitize_token() {
  local value="$1"
  value="$(printf "%s" "$value" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+//; s/_+$//')"
  if [ -z "$value" ]; then
    value="artifact"
  fi
  printf "%s" "$value"
}

derive_artifact_stem_from_checkpoint() {
  local ckpt="$1"
  if [ -z "$ckpt" ]; then
    printf "%s" "$(sanitize_token "$MODEL_NAME")"
    return 0
  fi

  local ckpt_file parent_dir file_base epoch
  ckpt_file="$(basename "$ckpt")"
  parent_dir="$(basename "$(dirname "$ckpt")")"
  parent_dir="$(sanitize_token "$parent_dir")"
  file_base="${ckpt_file%.pth}"
  file_base="$(sanitize_token "$file_base")"
  epoch=""

  if [[ "$ckpt_file" =~ ^epoch_([0-9]+)\.pth$ ]]; then
    epoch="${BASH_REMATCH[1]}"
  elif [[ "$ckpt_file" =~ epoch[_-]?([0-9]+) ]]; then
    epoch="${BASH_REMATCH[1]}"
  fi

  if [ -n "$epoch" ]; then
    printf "%s_ep%s" "$parent_dir" "$epoch"
  else
    printf "%s_%s" "$parent_dir" "$file_base"
  fi
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2 ;;
    --checkpoint) CHECKPOINT="$2"; shift 2 ;;
    --name) MODEL_NAME="$2"; shift 2 ;;
    --version) MODEL_VERSION="$2"; shift 2 ;;
    --skip-upload) SKIP_UPLOAD=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Model → branch / convert script / training config mapping
#   lite:  branch dev_lit,   config s1_c128_4b_s2_64_b1_vfe_train_multibox_gtenlarge_48_deploy.py
#   large: branch feat_merge, config flat_favs42_muon_qkclip_ftn_0125_freezed_ds_is.py
# Engine output dirs (by GPU):
#   3090 (local docker): /home/mi/data/det_and_seg/3090/flatformer_at720_v3/{model_name}/
#   L4   (remote volc):  /home/mi/data/det_and_seg/L4/flatformer_v3/{model_name}/

ENGINE_BASE_3090="/home/mi/data/det_and_seg/3090/flatformer_at720_v3"

if [ "$MODEL" = "lite" ]; then
  BRANCH="dev_lit"
  SCRIPT="deploy/convert_onnx_det/convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf.py"
  CONFIG="projects/flatformer/configs/s1_c128_4b_s2_64_b1_vfe_train_multibox_gtenlarge_48_deploy.py"
elif [ "$MODEL" = "large" ]; then
  BRANCH="feat_merge"
  SCRIPT="deploy/convert_onnx_det/convert_onnx_online_vrf.py"
  CONFIG="projects/flatformer/configs/flat_favs42_muon_qkclip_ftn_0125_freezed_ds_is.py"
else
  echo "Unknown model: $MODEL (use lite or large)"
  exit 1
fi

# Default model_name to model type if not provided
if [ -z "$MODEL_NAME" ]; then
  MODEL_NAME="$MODEL"
fi

ENGINE_OUTPUT_DIR="$ENGINE_BASE_3090/$MODEL_NAME"
ARTIFACT_STEM="$(derive_artifact_stem_from_checkpoint "$CHECKPOINT")"
status_init

# Validate early: --version is required for CloudML upload (no metadata.json in fresh output dir)
if [ -z "$SKIP_UPLOAD" ] && [ -z "$MODEL_VERSION" ]; then
  echo "ERROR: --version is required for CloudML upload (or use --skip-upload)"
  echo "  Example: bash scripts/trt_build_local.sh --model lite --version v1.0"
  exit 1
fi

echo "=== TRT Build: $MODEL model (branch: $BRANCH) ==="
echo "Artifact stem: $ARTIFACT_STEM"

# Check docker is running
if ! docker ps --format '{{.Names}}' | grep -q "$DOCKER"; then
  echo "Starting docker..."
  bash scripts/docker_trt10_flatformer.sh
  sleep 3
fi

# 1. Ensure mmdet3d repo exists
docker exec "$DOCKER" bash -c "
  if [ ! -d /mmdet3d/.git ]; then
    echo 'Cloning lidar-dl → /mmdet3d...'
    chmod 600 ~/.ssh/id_rsa 2>/dev/null
    cd / && git clone git@git.n.xiaomi.com:l3-perception/lidar-dl.git mmdet3d
  else
    echo '/mmdet3d already exists, skipping clone'
  fi
"

# 2. Ensure correct branch
docker exec "$DOCKER" bash -c "
  cd /mmdet3d && git fetch origin && git checkout $BRANCH && git pull origin $BRANCH
"

# 3. Ensure mmdet3d is installed with CUDA ops compiled
docker exec "$DOCKER" bash -c "
  if python3 -c 'from mmdet3d.ops import voxel_layer' 2>/dev/null; then
    echo 'mmdet3d + CUDA ops already installed'
  else
    echo 'Installing mmdet3d (compiling CUDA ops)...'
    cd /mmdet3d && pip install -v -e .
  fi
"

# Resolve checkpoint path for docker.
# Host path /home/mi/data/data_pkl/... is mounted as /data_pkl/... in container.
CHECKPOINT_IN_DOCKER=""
if [ -n "$CHECKPOINT" ]; then
  if [[ "$CHECKPOINT" == "$HOST_DATA_PKL_ROOT/"* ]]; then
    CHECKPOINT_IN_DOCKER="$DOCKER_DATA_PKL_ROOT${CHECKPOINT#$HOST_DATA_PKL_ROOT}"
  else
    CHECKPOINT_IN_DOCKER="$CHECKPOINT"
  fi
fi

echo ""
echo "=== Step 1: ONNX Export ==="
CURRENT_STEP="step1_convert_pth_to_onnx"
status_step "step1_convert_pth_to_onnx" "running"
ONNX_EXPORT_OUTPUT=""
if [ -n "$CHECKPOINT_IN_DOCKER" ]; then
  if ! docker exec "$DOCKER" bash -c "test -f \"$CHECKPOINT_IN_DOCKER\""; then
    step_fail_and_exit "step1_convert_pth_to_onnx" "ERROR: Checkpoint not found in docker: $CHECKPOINT_IN_DOCKER"
  fi

  # Some convert scripts pause for ENTER when checkpoint mismatch is detected.
  # Chat-triggered builds are non-interactive, so feed a newline to avoid EOFError.
  set +e
  ONNX_EXPORT_OUTPUT=$(docker exec "$DOCKER" bash -c "
    source ~/.bashrc
    cd /mmdet3d && printf '\n' | python3 $SCRIPT --build --checkpoint \"$CHECKPOINT_IN_DOCKER\"
  " 2>&1)
  ONNX_EXPORT_RC=$?
  set -e
else
  # Keep non-interactive behavior consistent even without explicit checkpoint.
  set +e
  ONNX_EXPORT_OUTPUT=$(docker exec "$DOCKER" bash -c "
    source ~/.bashrc
    cd /mmdet3d && printf '\n' | python3 $SCRIPT --build
  " 2>&1)
  ONNX_EXPORT_RC=$?
  set -e
fi
printf "%s\n" "$ONNX_EXPORT_OUTPUT"
if [ "$ONNX_EXPORT_RC" -ne 0 ]; then
  step_fail_and_exit "step1_convert_pth_to_onnx" "ERROR: ONNX export failed (exit $ONNX_EXPORT_RC)"
fi
status_step "step1_convert_pth_to_onnx" "success"
CURRENT_STEP=""

echo ""
echo "=== Step 2: TRT Engine Build (trtexec) ==="
CURRENT_STEP="step2_build_trt_engine"
status_step "step2_build_trt_engine" "running"
# Prefer trtexec command emitted by current converter run.
TRTEXEC_CMD_FROM_LOG=$(printf "%s\n" "$ONNX_EXPORT_OUTPUT" | grep -E '/TensorRT-[^ ]*/bin/trtexec ' | tail -1 || true)
# Fall back to newest command script (if converter generated one).
CMD_SCRIPT=$(docker exec "$DOCKER" bash -c "ls -t /mmdet3d/*_trtexec_cmd.sh 2>/dev/null | head -1")

if [ -n "$TRTEXEC_CMD_FROM_LOG" ]; then
  echo "Using trtexec command emitted by converter."
  docker exec "$DOCKER" bash -c "source ~/.bashrc && $TRTEXEC_CMD_FROM_LOG"
elif [ -n "$CMD_SCRIPT" ]; then
  echo "Using generated command script: $CMD_SCRIPT"
  docker exec "$DOCKER" bash -c "source ~/.bashrc && bash $CMD_SCRIPT"
else
  step_fail_and_exit "step2_build_trt_engine" "ERROR: No trtexec command script found and no trtexec command detected in ONNX export logs."
fi

# Check result
PLF=$(docker exec "$DOCKER" bash -c "ls -t /mmdet3d/*.plf 2>/dev/null | head -1")
if [ -z "$PLF" ]; then
  step_fail_and_exit "step2_build_trt_engine" "ERROR: No .plf file produced"
fi

ONNX=$(docker exec "$DOCKER" bash -c "ls -t /mmdet3d/*.onnx 2>/dev/null | head -1")
if [ -z "$ONNX" ]; then
  echo "WARNING: No .onnx file found after conversion in /mmdet3d"
fi

TARGET_PLF="/mmdet3d/${ARTIFACT_STEM}.plf"
TARGET_ONNX="/mmdet3d/${ARTIFACT_STEM}.onnx"

if [ "$PLF" != "$TARGET_PLF" ]; then
  docker exec "$DOCKER" bash -c "mv -f \"$PLF\" \"$TARGET_PLF\""
  PLF="$TARGET_PLF"
fi
if [ -n "$ONNX" ] && [ "$ONNX" != "$TARGET_ONNX" ]; then
  docker exec "$DOCKER" bash -c "mv -f \"$ONNX\" \"$TARGET_ONNX\""
  ONNX="$TARGET_ONNX"
fi

status_step "step2_build_trt_engine" "success"
CURRENT_STEP=""

echo ""
echo "=== SUCCESS ==="
docker exec "$DOCKER" bash -c "ls -lh $PLF"
echo "Engine: $PLF (inside docker)"

# Copy to host
LOCAL_PLF="$(basename "$PLF")"
docker cp "$DOCKER:$PLF" "./$LOCAL_PLF"
echo "Copied to: ./$LOCAL_PLF"

echo ""
echo "=== Step 3: Checkpoint Conversion Report ==="
CURRENT_STEP="step3_checkpoint_report"
status_step "step3_checkpoint_report" "running"
REPORT_JSON="/mmdet3d/param_check_report.json"
REPORT_KEYS_JSON=""
if docker exec "$DOCKER" test -f "$REPORT_JSON"; then
  REPORT_KEYS_JSON=$(docker exec "$DOCKER" python3 -c "
import json
with open('$REPORT_JSON') as f:
    r = json.load(f)
print(json.dumps({
    'missing_keys': r.get('missing_keys', []) or [],
    'unexpected_keys': r.get('unexpected_keys', []) or [],
}, ensure_ascii=False))
")

  docker exec "$DOCKER" python3 -c "
import json
with open('$REPORT_JSON') as f:
    r = json.load(f)
mk = r.get('missing_keys', [])
uk = r.get('unexpected_keys', [])
print(f'missing_keys:    {len(mk)}')
print(f'unexpected_keys: {len(uk)}')
print()
if mk:
    print('First 5 missing_keys:')
    for k in mk[:5]: print(f'  - {k}')
if uk:
    print('First 5 unexpected_keys:')
    for k in uk[:5]: print(f'  - {k}')
print()
print('Full report: $REPORT_JSON (inside docker)')
"
else
  echo "WARNING: No param_check_report.json found at $REPORT_JSON"
fi

if [ -z "$REPORT_KEYS_JSON" ]; then
  REPORT_KEYS_JSON=$(extract_keys_from_output)
fi

status_set_keys "$REPORT_KEYS_JSON"

KEY_COUNTS=$(python3 - "$REPORT_KEYS_JSON" <<'PY'
import json, sys
raw = sys.argv[1].strip()
if not raw:
    print("0 0")
    raise SystemExit
obj = json.loads(raw)
print(f"{len(obj.get('missing_keys', []) or [])} {len(obj.get('unexpected_keys', []) or [])}")
PY
)
MISSING_COUNT=$(echo "$KEY_COUNTS" | awk '{print $1}')
UNEXPECTED_COUNT=$(echo "$KEY_COUNTS" | awk '{print $2}')

if [ "$MISSING_COUNT" -gt 0 ] || [ "$UNEXPECTED_COUNT" -gt 0 ]; then
  status_step "step3_checkpoint_report" "success" "missing_keys=$MISSING_COUNT unexpected_keys=$UNEXPECTED_COUNT"
else
  if docker exec "$DOCKER" test -f "$REPORT_JSON"; then
    status_step "step3_checkpoint_report" "success"
  else
    status_step "step3_checkpoint_report" "failed" "No key-mismatch info found (report missing and parse empty)"
  fi
fi
CURRENT_STEP=""

echo ""
echo "=== Step 4: Parse Engine Output ==="
CURRENT_STEP="step4_parse_engine_output"
status_step "step4_parse_engine_output" "running"
# trtexec writes output.json to /data_pkl/plugins/10.8.0.43-flat/ (mounted to host)
OUTPUT_JSON="/home/mi/data/data_pkl/plugins/10.8.0.43-flat/output.json"
TRT_RESULT_TXT="/home/mi/data/data_pkl/plugins/10.8.0.43-flat/trt_result.txt"
PARSE_SCRIPT="/home/mi/codes/data/parse_engine_output_json.py"

if [ ! -f "$OUTPUT_JSON" ]; then
  step_fail_and_exit "step4_parse_engine_output" "ERROR: $OUTPUT_JSON not found — trtexec did not export inference output"
fi

# Verify output.json is fresh (within last 30 min of now)
OUTPUT_AGE=$(( $(date +%s) - $(stat -c %Y "$OUTPUT_JSON") ))
if [ "$OUTPUT_AGE" -gt 1800 ]; then
  echo "WARNING: $OUTPUT_JSON is $OUTPUT_AGE seconds old — may be stale from a previous build"
fi

# Remove old trt_result.txt to ensure freshness
rm -f "$TRT_RESULT_TXT"

echo "Running $PARSE_SCRIPT..."
python3 "$PARSE_SCRIPT"

if [ ! -f "$TRT_RESULT_TXT" ]; then
  step_fail_and_exit "step4_parse_engine_output" "ERROR: Parse script did not produce $TRT_RESULT_TXT"
fi
status_step "step4_parse_engine_output" "success"
status_set_user_confirm_upload "false"
CURRENT_STEP=""

echo ""
echo "=== Step 5: Copy Engine to Output Directory ==="
CURRENT_STEP="step5_copy_engine_artifact"
status_step "step5_copy_engine_artifact" "running"
mkdir -p "$ENGINE_OUTPUT_DIR"
cp "./$LOCAL_PLF" "$ENGINE_OUTPUT_DIR/"
echo "Copied ./$LOCAL_PLF → $ENGINE_OUTPUT_DIR/$LOCAL_PLF"
rm -f "./$LOCAL_PLF"
echo "Removed staging file ./$LOCAL_PLF from repo root"
status_step "step5_copy_engine_artifact" "success"
CURRENT_STEP=""

echo ""
echo "Engine (output):   $ENGINE_OUTPUT_DIR/$LOCAL_PLF"
echo "Output JSON:       $OUTPUT_JSON ($(date -r "$OUTPUT_JSON" '+%Y-%m-%d %H:%M:%S'))"
echo "Inference result:  $TRT_RESULT_TXT ($(date -r "$TRT_RESULT_TXT" '+%Y-%m-%d %H:%M:%S'))"
echo "Config:            $CONFIG"
echo ""
echo "Inspect the inference output with:"
echo "  less $TRT_RESULT_TXT"

if [ -n "$SKIP_UPLOAD" ]; then
  status_step "step6_prepare_cloudml" "skipped"
  status_step "step7_upload_cloudml" "skipped"
  status_set_terminal "completed"
  echo ""
  echo "=== ALL DONE (upload skipped) ==="
  exit 0
fi

echo ""
echo "=== Step 6: Prepare CloudML Upload Package ==="
status_set_user_confirm_upload "true"
CURRENT_STEP="step6_prepare_cloudml"
status_step "step6_prepare_cloudml" "running"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREPARE_SCRIPT="$SCRIPT_DIR/prepare_cloudml_upload.py"

if [ ! -f "$PREPARE_SCRIPT" ]; then
  step_fail_and_exit "step6_prepare_cloudml" "ERROR: $PREPARE_SCRIPT not found"
fi

PREPARE_ARGS=("$ENGINE_OUTPUT_DIR/$LOCAL_PLF" --force)
if [ -n "$MODEL_NAME" ]; then
  PREPARE_ARGS+=(--name "$MODEL_NAME")
fi
if [ -n "$MODEL_VERSION" ]; then
  PREPARE_ARGS+=(--version "$MODEL_VERSION")
fi

python3 "$PREPARE_SCRIPT" "${PREPARE_ARGS[@]}"

PLF_DIR="$(realpath "$ENGINE_OUTPUT_DIR")"
UPLOAD_DIR="$PLF_DIR/cloudml_upload"
if [ ! -d "$UPLOAD_DIR" ]; then
  step_fail_and_exit "step6_prepare_cloudml" "ERROR: prepare script did not produce $UPLOAD_DIR"
fi
status_step "step6_prepare_cloudml" "success"
CURRENT_STEP=""

echo ""
echo "=== Step 7: Upload to CloudML ==="
CURRENT_STEP="step7_upload_cloudml"
status_step "step7_upload_cloudml" "running"
SUBMIT_SCRIPT="$SCRIPT_DIR/submit_cloudml_upload.py"

if [ ! -f "$SUBMIT_SCRIPT" ]; then
  step_fail_and_exit "step7_upload_cloudml" "ERROR: $SUBMIT_SCRIPT not found"
fi

python3 "$SUBMIT_SCRIPT" "$UPLOAD_DIR"
status_step "step7_upload_cloudml" "success"
CURRENT_STEP=""
status_set_terminal "completed"

echo ""
echo "=== ALL DONE ==="
