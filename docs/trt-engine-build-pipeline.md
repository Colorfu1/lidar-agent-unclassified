# TRT Engine Build Pipeline

## Overview

Build TensorRT engine (.plf) files from model checkpoints. Two paths: local docker or remote Volc L4 GPU.

## Current Chat Integration (2026-04-23)

The backend chat flow is now the default operational path:

1. Chat tool `trt_build` starts `scripts/trt_build_start.sh` in detached mode.
2. Build progress is tracked by `data/runtime-logs/trt-build-<id>.status.json`.
3. `src/trt/monitor.ts` emits websocket notifications for steps, heartbeat, and completion.
4. On completion, chat sends `TRT Upload Confirm` with uncertain defaults:
   - `version: v1.0.0`
   - `confirm: true`
5. User may reply in natural language (`it is ok`, `yes version v1.2.0`, `no skip upload`).
6. `src/index.ts` maps that reply to `cloudml_upload(request_json=...)` for the pending build.
7. Upload uses no-proxy + `DISPLAY=` environment handling in `scripts/submit_cloudml_upload.py`.

For full project takeover and runtime map, also read the root `README.md`.

## Models

| Model | Branch | mmdet3d Branch | ONNX Script | L4 ONNX Script |
|-------|--------|---------------|-------------|----------------|
| Lite (S1) | `dev_lit` | `dev_lit` | `deploy/convert_onnx_det/convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf.py --build` | `convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf_L4.py` |
| Large | `feat_merge` | `feat_merge` | `deploy/convert_onnx_det/convert_onnx_online_vrf.py --build` | `convert_onnx_online_vrf_L4.py` |

## Path 1: Local Docker Build

### Quick Start
```bash
# Lite model (default checkpoint)
bash scripts/trt_build_local.sh --model lite

# Large model
bash scripts/trt_build_local.sh --model large

# Custom checkpoint
bash scripts/trt_build_local.sh --model lite --checkpoint /data_pkl/tmp/my_model.pth
```

### What the Script Does

**Step 1: ONNX Export** (Python, uses GPU for model loading)
1. Checks docker `flatformer_trt10_docker` is running, starts it if not
2. Clones `git@git.n.xiaomi.com:l3-perception/lidar-dl.git` to `/lidar-dl` if not present
3. Checks out the correct branch (`dev_lit` or `feat_merge`) for both `/lidar-dl` and `/mmdet3d`
4. Runs the ONNX conversion script with `--build`
5. Script exports ONNX + patches (pad/final) and saves trtexec command to a `.sh` file
6. Python process exits, releasing GPU memory

**Step 2: TRT Engine Build** (trtexec, needs full GPU)
1. Runs the saved trtexec command shell script
2. trtexec gets full GPU (no Python process competing for VRAM)
3. Produces `.plf` engine file + `output.json` (exported inference result via `--exportOutput`)
4. Copies `.plf` to local machine

**Step 3: Checkpoint Conversion Report**
1. Reads `/mmdet3d/param_check_report.json` (written during ONNX export)
2. Prints `missing_keys` / `unexpected_keys` counts + first 5 of each
3. **Review before CloudML upload** — large missing/unexpected sets may indicate branch or checkpoint mismatch

**Step 4: Parse Engine Output → TXT**
1. Verifies `output.json` freshness (must be < 30 min old)
2. Deletes stale `trt_result.txt` then runs `/home/mi/codes/data/parse_engine_output_json.py`
3. Produces `/home/mi/data/data_pkl/plugins/10.8.0.43-flat/trt_result.txt` (N×6: xyz + intensity + ring + seg_res)
4. Reports final path + mtime so user can `less` / diff the inference output before CloudML upload

### CRITICAL: Two-Step Separation

**Never run ONNX export and trtexec in a single Python process.** The Python ONNX export holds ~4GB GPU memory that isn't released, causing trtexec to hang or fail with "Compiler backend" stuck at 100% CPU / 0% GPU.

The ONNX conversion script has been patched to:
- Auto-continue on parameter warnings (saves report to `param_check_report.json`)
- Save the trtexec command to `*_trtexec_cmd.sh` instead of executing it
- Exit after ONNX export

### Docker Environment

- Image: `test-lab-instance-cn-beijing.cr.volces.com/lidar-wwd/flatformer_wwd:latest`
- Docker name: `flatformer_trt10_docker`
- GPU: device=0 (RTX 3090)
- TensorRT: `/TensorRT-10.8.0.43/bin/trtexec`
- Plugin: `/data_pkl/plugins/10.8.0.43-flat/libl3det_plugins_v3_3090.so`
- Startup script: `scripts/docker_trt10_flatformer.sh`

### Environment Variables (in docker ~/.bashrc)

The docker's `~/.bashrc` must have these exports BEFORE the `[ -z "$PS1" ] && return` guard (we patched this via `/root/.env`):
- `AD_CLOUD_DATASEEKER_KS3_ACCESS_KEY` / `SECRET_KEY` — for ad_cloud SDK
- `XIAOMI_IAM_ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` — for IAM auth
- `AD_CLOUD_DATASEEKER_PROXY_ENV=1`
- `XIAOMI_USERNAME=wuwenda`
- `LD_LIBRARY_PATH=/TensorRT-10.8.0.43/lib:$LD_LIBRARY_PATH`

If `source ~/.bashrc` fails in non-interactive mode, check that `/root/.env` is sourced at line 1 of `.bashrc`.

### Default Checkpoints

| Checkpoint | Path inside docker |
|-----------|-------------------|
| Lite (S1) latest | `/data_pkl/tmp/s1_ftground_freezed_48_addob_all_addg_newohem_rainwarehous_only_epoch_48.pth` |

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `IdentifyException: sdk need to be initialized` | env vars not loaded | Check `source ~/.bashrc` works, verify `/root/.env` exists |
| `init_channels` unexpected keyword | mmdet3d on wrong branch | `cd /mmdet3d && git checkout dev_lit` (must match lidar-dl branch) |
| trtexec stuck at "Compiler backend" 100% CPU | GPU memory held by Python | Kill trtexec, run it separately after Python exits |
| `Failed to parse ONNX model` | ONNX saved to wrong dir | ONNX saves to CWD; script patched to save to `/mmdet3d/` (same as engine_path dir) |
| trtexec PASSED but no `.plf` | Glob not matching | Check `/mmdet3d/*.plf` directly (file exists, glob may fail in some shells) |

## Path 2: Remote Volc L4 Build

### Steps
1. Submit Volc task with L4 GPU queue (`q-20251216205836-jwdrs`), flavor `ml.gni3.3xlarge`
2. Template YAML: `scripts/volc_trt_l4_template.yaml`
3. In the task entrypoint:
   - `git clone git@git.n.xiaomi.com:l3-perception/lidar-dl.git && cd lidar-dl`
   - Checkout branch
   - Run L4-specific ONNX script: `convert_onnx_*_L4.py --build [params]`
   - Run trtexec separately
4. SCP .plf to local machine
5. Upload to CloudML

### Key difference from local
- Local uses `convert_onnx_*_vrf.py` (3090 GPU)
- Remote uses `convert_onnx_*_vrf_L4.py` (L4 GPU)
- Different TRT optimizations per GPU architecture
- Same two-step approach (ONNX then trtexec)

## CloudML Upload

After building the `.plf`:

```bash
# Prepare upload package
python3 scripts/prepare_cloudml_upload.py <plf_path>

# Submit to CloudML
python3 scripts/submit_cloudml_upload.py <plf_path_dir>/cloudml_upload/
```

1. `prepare_cloudml_upload.py` — creates `cloudml_upload/` dir with `model.plf` + `metadata.json` (md5, platform, precision)
2. `submit_cloudml_upload.py` — uploads to CloudML model repo

## Files in lidar-agent-unclassified/scripts/

| File | Purpose |
|------|---------|
| `trt_build_local.sh` | **Main wrapper** — 2-step local docker build (ONNX → trtexec) |
| `docker_trt10_flatformer.sh` | Docker startup script |
| `volc_trt_l4_template.yaml` | Volc task template for remote L4 builds |
| `prepare_cloudml_upload.py` | CloudML upload preparation |
| `submit_cloudml_upload.py` | CloudML upload submission |
