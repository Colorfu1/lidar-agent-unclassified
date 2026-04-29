#!/usr/bin/env bash
set -euo pipefail

# Thor TRT engine build — multi-hop SSH pipeline
# Local → gateway (inte@10.235.234.34) → soc1
#
# Usage: trt_build_thor.sh --onnx <path> --name <name>
#
# Env vars:
#   THOR_GW_HOST    gateway host  (default: 10.235.234.34)
#   THOR_GW_USER    gateway user  (default: inte)
#   THOR_GW_PASS    gateway password (required)
#   THOR_SOC_HOST   soc host from gateway (default: soc1)
#   THOR_SOC_PASS   soc password (required)
#   THOR_SOC_DIR    working dir on soc (default: /tmp/wuwenda/engine)
#   THOR_LOCAL_OUT  local output dir base (default: /home/mi/data/det_and_seg/thor)
#   BUILD_ID        trt_builds row id (for log tagging)

ONNX=""
NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --onnx)   ONNX="$2"; shift 2 ;;
    --name)   NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ONNX" ]]; then echo "Error: --onnx is required" >&2; exit 1; fi
if [[ -z "$NAME" ]]; then NAME="$(basename "$ONNX" .onnx)"; fi

GW_HOST="${THOR_GW_HOST:-10.235.234.34}"
GW_USER="${THOR_GW_USER:-inte}"
GW_PASS="${THOR_GW_PASS:?THOR_GW_PASS is required}"
SOC_HOST="${THOR_SOC_HOST:-soc1}"
SOC_PASS="${THOR_SOC_PASS:?THOR_SOC_PASS is required}"
SOC_DIR="${THOR_SOC_DIR:-/tmp/wuwenda/engine}"
LOCAL_OUT="${THOR_LOCAL_OUT:-/home/mi/data/det_and_seg/thor}"

ONNX_BASENAME="$(basename "$ONNX")"
ONNX_STEM="${ONNX_BASENAME%.onnx}"
PLF_BASENAME="${ONNX_STEM}.plf"

GW_SSH="sshpass -p ${GW_PASS} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${GW_USER}@${GW_HOST}"
GW_SCP="sshpass -p ${GW_PASS} scp -o StrictHostKeyChecking=no -o ConnectTimeout=5"
SOC_SSH_VIA_GW="sshpass -p ${SOC_PASS} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${SOC_HOST}"
SOC_SCP_VIA_GW="sshpass -p ${SOC_PASS} scp -o StrictHostKeyChecking=no -o ConnectTimeout=5"

MAX_RETRIES=30
RETRY_DELAY=2

retry() {
  local desc="$1"; shift
  for i in $(seq 1 $MAX_RETRIES); do
    if "$@" ; then
      return 0
    fi
    echo "  retry $i/$MAX_RETRIES ($desc) — waiting ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
  done
  echo "FAILED after $MAX_RETRIES retries: $desc" >&2
  return 1
}

# trtexec command — runs inside trtexec_package/, ONNX and outputs are in parent dir (SOC_DIR)
BUILD_CMD="cd ${SOC_DIR}/trtexec_package && ./trtexec --onnx=../${ONNX_BASENAME} --saveEngine=../${PLF_BASENAME} --staticPlugins=../libl3det_plugins_v3_thor.so --memPoolSize=workspace:10240M --minShapes=points:1x5,cur_points_len:1 --optShapes=points:2250000x5,cur_points_len:450000 --maxShapes=points:2500000x5,cur_points_len:500000 --shapes=points:1673078x5,cur_points_len:345539 --loadInputs=points:../vrf_points_1673078x5.bin,cur_points_len:../vrf_cur_points_len_345539.bin --stronglyTyped --exportOutput=../output.json"

echo "=== Thor TRT Build ==="
echo "ONNX: $ONNX"
echo "Name: $NAME"
echo "Gateway: ${GW_USER}@${GW_HOST}"
echo "SOC: ${SOC_HOST}:${SOC_DIR}"
echo ""

# Step 1: Ensure remote directories exist
echo "step=prepare"
retry "mkdir on gateway" $GW_SSH "mkdir -p ${SOC_DIR}"
retry "mkdir on soc1" $GW_SSH "${SOC_SSH_VIA_GW} 'mkdir -p ${SOC_DIR}'"
echo "Remote directories ready."

# Step 2: SCP ONNX local → gateway
echo "step=upload_to_gateway"
retry "scp to gateway" $GW_SCP "$ONNX" "${GW_USER}@${GW_HOST}:${SOC_DIR}/${ONNX_BASENAME}"
echo "ONNX uploaded to gateway: ${SOC_DIR}/${ONNX_BASENAME}"

# Step 3: SCP ONNX gateway → soc1
echo "step=upload_to_soc"
retry "scp gw→soc1" $GW_SSH "${SOC_SCP_VIA_GW} ${SOC_DIR}/${ONNX_BASENAME} ${SOC_HOST}:${SOC_DIR}/${ONNX_BASENAME}"
echo "ONNX uploaded to soc1: ${SOC_DIR}/${ONNX_BASENAME}"

# Step 4: Run trtexec on soc1
echo "step=build"
echo "Running trtexec on soc1 (inside trtexec_package/)..."
echo "cmd=${BUILD_CMD}"
retry "build on soc1" $GW_SSH "${SOC_SSH_VIA_GW} '${BUILD_CMD}'"
echo "Build command completed."

# Step 5: SCP results soc1 → gateway
echo "step=download_from_soc"
retry "plf soc1→gw" $GW_SSH "${SOC_SCP_VIA_GW} ${SOC_HOST}:${SOC_DIR}/${PLF_BASENAME} ${SOC_DIR}/${PLF_BASENAME}" || echo "  PLF not found on soc1 after retries"
retry "json soc1→gw" $GW_SSH "${SOC_SCP_VIA_GW} ${SOC_HOST}:${SOC_DIR}/output.json ${SOC_DIR}/output.json" || echo "  output.json not found on soc1 after retries"
echo "Results copied to gateway."

# Step 6: SCP results gateway → local
echo "step=download_to_local"
OUT_DIR="${LOCAL_OUT}/${NAME}"
mkdir -p "$OUT_DIR"

retry "plf gw→local" $GW_SCP "${GW_USER}@${GW_HOST}:${SOC_DIR}/${PLF_BASENAME}" "${OUT_DIR}/${PLF_BASENAME}" || echo "  PLF not available on gateway after retries"
retry "json gw→local" $GW_SCP "${GW_USER}@${GW_HOST}:${SOC_DIR}/output.json" "${OUT_DIR}/output.json" || echo "  output.json not available on gateway after retries"

# Check what we got
PLF_PATH="${OUT_DIR}/${PLF_BASENAME}"
OUTPUT_JSON="${OUT_DIR}/output.json"

if [[ -f "$PLF_PATH" ]]; then
  echo "engine_path=${PLF_PATH}"
  echo "PLF downloaded: ${PLF_PATH} ($(stat -c%s "$PLF_PATH" 2>/dev/null || echo '?') bytes)"
else
  echo "WARNING: PLF not found at ${PLF_PATH}. Build may have failed — check soc1:${SOC_DIR}/ manually."
fi

if [[ -f "$OUTPUT_JSON" ]]; then
  echo "output_json=${OUTPUT_JSON}"
  echo "output.json downloaded: ${OUTPUT_JSON}"
fi

echo "out_dir=${OUT_DIR}"
echo "step=done"
echo "Thor TRT build pipeline completed."
