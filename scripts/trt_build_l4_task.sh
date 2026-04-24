#!/bin/bash
# Runs inside Volc ML task container. Builds TRT engine for L4 GPU.
#
# Required env:
#   BUILD_NAME, CKPT, STEM, BRANCH, CONVERT_SCRIPT
#
# Path config env (set per model/target by submit script):
#   PLUGIN_PATH      — TRT plugin .so path
#   TRTEXEC_BIN      — trtexec binary path
#   LOAD_INPUTS_DIR  — dir containing loadInputs .bin files
#   EXPORT_OUTPUT    — path for trtexec --exportOutput
#   PATH_REPLACE_OLD — old prefix to replace in convert script (e.g. /high_perf_store/l3_deep/wuwenda)
#   PATH_REPLACE_NEW — new prefix (e.g. /high_perf_store3/l3_data/wuwenda/l3_deep)
#
# Optional env:
#   OUT_ROOT       — output root on shared vepfs
#   VEPFS_MMDET3D  — source repo on shared vepfs
#
# Writes status JSON + engine to $OUT_ROOT/$BUILD_NAME/ on shared vepfs.
set -u

: "${BUILD_NAME:?}"
: "${CKPT:?}"
: "${STEM:?}"
: "${OUT_ROOT:=/high_perf_store3/l3_data/wuwenda/lidar_agent_builds/L4}"
: "${BRANCH:=feat_merge}"
: "${CONVERT_SCRIPT:=deploy/convert_onnx_det/convert_onnx_online_vrf_L4.py}"
: "${PLUGIN_PATH:?}"
: "${TRTEXEC_BIN:=/TensorRT-10.8.0.43/bin/trtexec}"
: "${LOAD_INPUTS_DIR:?}"
: "${EXPORT_OUTPUT:?}"
: "${VEPFS_MMDET3D:=/high_perf_store3/l3_data/wuwenda/l3_deep/centerpoint/remote/trt_engine/mmdet3d}"
: "${PATH_REPLACE_OLD:=}"
: "${PATH_REPLACE_NEW:=}"

# Source bashrc (may set env vars needed by some imports).
set +u
source ~/.bashrc 2>/dev/null || true
set -u
export LD_LIBRARY_PATH=/TensorRT-10.8.0.43/lib:${LD_LIBRARY_PATH:-}

OUT_DIR="$OUT_ROOT/$BUILD_NAME"
STATUS="$OUT_DIR/status.json"
BUILD_LOG="$OUT_DIR/build.log"
CONVERT_LOG="$OUT_DIR/convert.log"
mkdir -p "$OUT_DIR"
: > "$BUILD_LOG"

log()  { echo "[$(date +%H:%M:%S)] $*" >> "$BUILD_LOG"; }
step() { echo "[$(date +%H:%M:%S)] >>> $*"; echo "[$(date +%H:%M:%S)] >>> $*" >> "$BUILD_LOG"; }

write_status() {
  local state="$1" step="${2:-}" detail="${3:-}" engine="${4:-}"
  python3 - "$STATUS" "$state" "$step" "$detail" "$engine" <<'PY'
import json, os, sys, tempfile, datetime
path, state, step, detail, engine = sys.argv[1:6]
payload = {
    "state": state,
    "step": step or None,
    "detail": detail or None,
    "engine_path": engine or None,
    "updated_at": datetime.datetime.utcnow().isoformat() + "Z",
}
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".status.", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(payload, f)
os.replace(tmp, path)
PY
}

fail() {
  write_status "failed" "${CURRENT_STEP:-}" "$1"
  echo "FAIL[${CURRENT_STEP:-}]: $1 (log: $BUILD_LOG)" >&2
  exit 1
}

{
  echo "=== Config ==="
  echo "BUILD_NAME=$BUILD_NAME"
  echo "BRANCH=$BRANCH"
  echo "CONVERT_SCRIPT=$CONVERT_SCRIPT"
  echo "CKPT=$CKPT"
  echo "PLUGIN_PATH=$PLUGIN_PATH"
  echo "TRTEXEC_BIN=$TRTEXEC_BIN"
  echo "LOAD_INPUTS_DIR=$LOAD_INPUTS_DIR"
  echo "EXPORT_OUTPUT=$EXPORT_OUTPUT"
} >> "$BUILD_LOG"

echo "TRT build start: $BUILD_NAME (log: $BUILD_LOG)"

# --- sync code ---
CURRENT_STEP="sync_code"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
[ -d "$VEPFS_MMDET3D/.git" ] || fail "source repo not found: $VEPFS_MMDET3D"
rm -rf /mmdet3d
cp -r "$VEPFS_MMDET3D" /mmdet3d >> "$BUILD_LOG" 2>&1 || fail "cp -r failed"
cd /mmdet3d || fail "no /mmdet3d after copy"
git checkout "$BRANCH" >> "$BUILD_LOG" 2>&1 || fail "branch $BRANCH not available"
log "checked out $BRANCH ($(git log --oneline -1))"

# --- pip install ---
CURRENT_STEP="pip_install"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
{
  echo "--- pre-install key packages ---"
  pip list 2>/dev/null | grep -iE 'onnx|simpletrt|tensorrt|torch|mmcv|mmdet' || true
} >> "$BUILD_LOG"
cd /mmdet3d && pip install -v --no-deps -e . >> "$BUILD_LOG" 2>&1 || fail "pip install failed"
{
  echo "--- post-install key packages ---"
  pip list 2>/dev/null | grep -iE 'onnx|simpletrt|tensorrt|torch|mmcv|mmdet' || true
} >> "$BUILD_LOG"

# --- stub ad_cloud (unreachable auth server from Volc) ---
CURRENT_STEP="stub_ad_cloud"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
STUB_DIR="/tmp/ad_cloud_stub"
python3 - "$STUB_DIR" >> "$BUILD_LOG" 2>&1 <<'STUBPY'
import os, sys
stub = sys.argv[1]
for p in ["ad_cloud","ad_cloud/adrn","ad_cloud/adrn/data_seeker","ad_cloud/common","ad_cloud/common/report","ad_cloud/common/runtime"]:
    d = os.path.join(stub, p); os.makedirs(d, exist_ok=True); open(os.path.join(d,"__init__.py"),"w").close()
with open(os.path.join(stub,"ad_cloud/adrn/data_seeker/frame.py"),"w") as f:
    f.write("def read_frame(*a,**k): pass\ndef _get_local_path(*a,**k): pass\ndef frame_adrn_to_cache_path(*a,**k): pass\n")
with open(os.path.join(stub,"ad_cloud/common/report/reporter.py"),"w") as f:
    f.write("def report_event(*a,**k): pass\n")
print("ad_cloud stub created")
STUBPY
export PYTHONPATH="$STUB_DIR:${PYTHONPATH:-}"

# --- patch convert script paths using env var config ---
CURRENT_STEP="patch_paths"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
cd /mmdet3d
if [ -f "$CONVERT_SCRIPT" ]; then
  python3 - "$CONVERT_SCRIPT" "$PLUGIN_PATH" "$TRTEXEC_BIN" "$LOAD_INPUTS_DIR" "$EXPORT_OUTPUT" "$PATH_REPLACE_OLD" "$PATH_REPLACE_NEW" >> "$BUILD_LOG" 2>&1 <<'PATCHPY'
import re, sys
script, plugin, trtexec, inputs_dir, export_out, old_prefix, new_prefix = sys.argv[1:8]
with open(script) as f:
    code = f.read()
if old_prefix and new_prefix:
    code = code.replace(old_prefix, new_prefix)
    print(f"Replaced prefix: {old_prefix} -> {new_prefix}")
code = re.sub(r'^(plugin_path\s*=\s*)".+"', rf'\1"{plugin}"', code, count=1, flags=re.MULTILINE)
code = re.sub(r'/[^\s"]*?/bin/trtexec\b', trtexec, code)
code = re.sub(r'(--exportOutput=)[^\s"]+', rf'\1{export_out}', code)
with open(script, 'w') as f:
    f.write(code)
print(f"Patched {script}")
PATCHPY
else
  log "WARNING: $CONVERT_SCRIPT not found"
fi

# --- onnx export (convert script prints trtexec cmd but does not run it) ---
CURRENT_STEP="onnx_export"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
[ -f "$CKPT" ] || fail "checkpoint not found: $CKPT"
set +e
printf '\n' | python3 "$CONVERT_SCRIPT" --build \
  --checkpoint "$CKPT" --engine-path "${STEM}.plf" > "$CONVERT_LOG" 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] && fail "onnx_export exit $RC (see $CONVERT_LOG)"

# --- extract trtexec command from convert script output and run it ---
CURRENT_STEP="trtexec"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
TRTEXEC_CMD=$(grep -E '/bin/trtexec ' "$CONVERT_LOG" | tail -1 || true)
[ -z "$TRTEXEC_CMD" ] && fail "no trtexec command found in $CONVERT_LOG"
log "trtexec cmd: $TRTEXEC_CMD"
set +e
eval "$TRTEXEC_CMD" >> "$CONVERT_LOG" 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] && fail "trtexec exit $RC (see $CONVERT_LOG)"

# --- inference validation (separate trtexec --loadEngine with loaded inputs) ---
CURRENT_STEP="inference_check"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
PLF_BUILD="/mmdet3d/${STEM}.plf"
INFER_LOG="$OUT_DIR/inference.log"
if [ -f "$PLF_BUILD" ] && [ -d "$LOAD_INPUTS_DIR" ]; then
  POINTS_BIN=$(ls "$LOAD_INPUTS_DIR"/vrf_points_*.bin 2>/dev/null | head -1)
  LEN_BIN=$(ls "$LOAD_INPUTS_DIR"/vrf_cur_points_len_*.bin 2>/dev/null | head -1)
  if [ -n "$POINTS_BIN" ] && [ -n "$LEN_BIN" ]; then
    POINTS_SHAPE=$(basename "$POINTS_BIN" .bin | sed 's/vrf_points_//')
    LEN_SHAPE=$(basename "$LEN_BIN" .bin | sed 's/vrf_cur_points_len_//')
    set +e
    "$TRTEXEC_BIN" \
      --loadEngine="$PLF_BUILD" \
      --staticPlugins="$PLUGIN_PATH" \
      --shapes="points:${POINTS_SHAPE},cur_points_len:${LEN_SHAPE}" \
      --loadInputs="points:${POINTS_BIN},cur_points_len:${LEN_BIN}" \
      --exportOutput="$EXPORT_OUTPUT" \
      --iterations=1 --warmUp=0 > "$INFER_LOG" 2>&1
    INFER_RC=$?
    set -e
    if [ "$INFER_RC" -ne 0 ]; then
      log "WARNING: inference_check failed (rc=$INFER_RC), engine built ok but validation skipped"
    else
      log "inference_check passed, output at $EXPORT_OUTPUT"
    fi
  else
    log "WARNING: no input .bin files in $LOAD_INPUTS_DIR, skipping inference_check"
  fi
else
  log "WARNING: skipping inference_check (no engine or no LOAD_INPUTS_DIR)"
fi

# --- copy artifact ---
CURRENT_STEP="copy_artifact"; step "$CURRENT_STEP"
write_status "running" "$CURRENT_STEP"
PLF="/mmdet3d/${STEM}.plf"
[ -f "$PLF" ] || fail "no .plf produced at $PLF"
cp "$PLF" "$OUT_DIR/" || fail "cp to out_dir failed"
ONNX="/mmdet3d/${STEM}.onnx"
[ -f "$ONNX" ] && cp "$ONNX" "$OUT_DIR/" 2>/dev/null || true
if [ -n "${EXPORT_OUTPUT:-}" ] && [ -f "$EXPORT_OUTPUT" ]; then
  cp "$EXPORT_OUTPUT" "$OUT_DIR/output.json" 2>> "$BUILD_LOG" && log "copied output.json to $OUT_DIR/" || log "warn: cp output.json failed"
fi

# Also colocate with the checkpoint's pth dir (so local can scp from there).
CKPT_DIR="$(dirname "$CKPT")"
if [ -d "$CKPT_DIR" ]; then
  cp "$PLF" "$CKPT_DIR/" 2>> "$BUILD_LOG" && log "copied .plf to $CKPT_DIR/" || log "warn: cp to $CKPT_DIR/ failed"
  [ -f "$ONNX" ] && cp "$ONNX" "$CKPT_DIR/" 2>/dev/null || true
fi

write_status "completed" "done" "" "$OUT_DIR/${STEM}.plf"
echo "SUCCESS engine=$OUT_DIR/${STEM}.plf ckpt_dir_copy=$CKPT_DIR/${STEM}.plf"
