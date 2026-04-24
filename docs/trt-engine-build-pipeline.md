# TRT Engine Build Pipeline

## Overview

Builds TensorRT engine (`.plf`) files from PyTorch checkpoints (`.pth`). Two parallel pipelines by target GPU:

| Target | Pipeline | Execution | MCP Tool |
|--------|----------|-----------|----------|
| RTX 3090 / local dev | Local docker container | Synchronous (tool blocks until done) | `trt_build` |
| L4 / car-side / edge | Volc ML Platform task | Async submission (tool blocks until task_id returned) | `trt_build_l4` |

Both pipelines: ONNX export → trtexec → copy artifact. Upload to CloudML is always a separate user-confirmed step.

## Architecture

```
User chat message
     │
     ▼
src/index.ts (WebSocket /chat)
     │
     ▼
AgentSession.chat() → Codex SDK → MCP tools
     │
     ├─ trt_build ──────────→ trt_build_start.sh (sync, blocks)
     │                             └─ trt_build_local.sh (7 steps in docker)
     │                                  └─ trt_status_cli.py (atomic status JSON writes)
     │
     ├─ trt_build_l4 ───────→ trt_build_l4_submit.py (awaited)
     │                             └─ volc ml_task submit → remote container runs trt_build_l4_task.sh
     │
     ├─ trt_build_status ───→ reads DB + status JSON
     │
     ├─ cloudml_upload_preview → read-only info (model name, engine path, confirm template)
     ├─ cloudml_upload_execute → prepare_cloudml_upload.py → submit_cloudml_upload.py
     └─ trt_decline_upload ──→ marks upload_status='declined'
     │
     ▼
startTrtBuildMonitor() [setInterval 2s]  ← src/trt/monitor.ts
     │
     ├─ 3090: reads trt-build-{id}.status.json, fires notify() per step change + heartbeat
     ├─ L4:   polls volc CLI + SSH logs every 20s, fires notify() per step + heartbeat
     │
     ▼
notify(title, body, level) → eventBus → WebSocket broadcast to all clients
```

## Model Presets

| Preset | Git Branch | ONNX Script (3090) | ONNX Script (L4) |
|--------|------------|-------------------|-------------------|
| `lite` | `dev_lit` | `deploy/convert_onnx_det/convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf.py` | `convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf_L4.py` |
| `large` | `feat_merge` | `deploy/convert_onnx_det/convert_onnx_online_vrf.py` | `convert_onnx_online_vrf_L4.py` |

---

## MCP Tools (6 total)

All registered in `src/agent/tools.ts`. The agent picks tools based on natural language — no regex fast-paths.

### `trt_build` — Local 3090 Docker Build

**Input:** `model: "lite"|"large"`, `checkpoint: string`, `name?: string`

**Behavior:** Calls `bash scripts/trt_build_start.sh --model <m> --checkpoint <ckpt>` synchronously via `runShellAsync` (30-min timeout). The tool stays "running" in the UI until the entire build finishes. The start script runs `trt_build_local.sh` inline (no `--detach`).

**Checkpoint resolution:** Docker mount `/data_pkl` ↔ host `/home/mi/data/data_pkl`. If the agent passes a docker path, it's resolved to the host path before validation.

**Output path:** `/home/mi/data/det_and_seg/3090/flatformer_at720_v3/{name}/{artifact_stem}/{artifact_stem}.plf`

### `trt_build_l4` — Volc ML L4 Submission

**Input:** `model: "lite"|"large"`, `checkpoint: string`, `name?: string`

**Behavior:** Inserts a `trt_builds` row (platform=`L4`, status=`running`), then awaits `submitL4Build()` which runs `python3 scripts/trt_build_l4_submit.py`. The tool stays "running" until Volc accepts the task and returns a `task_id` (~30-60s). After that, `src/trt/monitor.ts` polls the remote task.

**Checkpoint:** Must be on shared vepfs. Relative paths are prefixed with `/high_perf_store3/l3_data/wuwenda/centerpoint/pth_dir`.

### `trt_build_status` — Query Build State

**Input:** `build_id?: number` (omit for latest)

**3090:** Returns DB fields + status JSON (steps, missing_keys, unexpected_keys, terminal state).
**L4:** Returns DB fields + task_id, instance_id, remote_out_dir, volc_log_path.

### `cloudml_upload_preview` — Read-Only Upload Info

**Input:** `build_id: number`, `app_label?: string`

Returns model name, engine path, platform, and a confirm template (`{build_id, version, app_label}`). Use for any informational question about the upload. Annotated `readOnlyHint: true`.

### `cloudml_upload_execute` — Perform Upload

**Input:** `build_id: number`, `version?: string`, `app_label?: string`

Runs `prepare_cloudml_upload.py` then `submit_cloudml_upload.py --yes`. Only call after explicit user confirmation. Updates `upload_status='approved'` in DB.

### `trt_decline_upload` — Decline Upload

**Input:** `build_id: number`, `reason?: string`

Sets `upload_status='declined'` in DB. Use when user says no/skip/cancel.

---

## Pipeline 1: Local 3090 Docker

### Scripts

| Script | Role |
|--------|------|
| `scripts/trt_build_start.sh` | Chat entry point. Creates DB row, runs `trt_build_local.sh`, updates DB on completion. |
| `scripts/trt_build_local.sh` | Core 7-step build runner inside docker. |
| `scripts/trt_status_cli.py` | Atomic status JSON writer (called by trt_build_local.sh). |
| `scripts/docker_trt10_flatformer.sh` | Starts the docker container if not running. |

### Docker Environment

- **Container name:** `flatformer_trt10_docker`
- **Image:** `test-lab-instance-cn-beijing.cr.volces.com/lidar-wwd/flatformer_wwd:latest`
- **GPU:** device=0 (RTX 3090)
- **TensorRT:** `/TensorRT-10.8.0.43/bin/trtexec`
- **Plugin:** `/data_pkl/plugins/10.8.0.43-flat/libl3det_plugins_v3_3090.so`
- **Mount:** host `/home/mi/data/data_pkl` → container `/data_pkl`

### Build Steps (trt_build_local.sh)

| Step ID | Name | What It Does |
|---------|------|-------------|
| `step1_convert_pth_to_onnx` | Convert pth to onnx | Runs ONNX conversion script in docker. Feeds `\n` to stdin (non-interactive). |
| `step2_build_trt_engine` | Build TRT engine | Extracts trtexec command from step 1 stdout, runs it. Renames `.plf`/`.onnx` to artifact stem. |
| `step3_checkpoint_report` | Checkpoint compatibility report | Reads `param_check_report.json`, extracts missing_keys/unexpected_keys. |
| `step4_parse_engine_output` | Parse engine output | Runs `parse_engine_output_json.py` on `output.json` → produces `trt_result.txt`. |
| `step5_copy_engine_artifact` | Copy engine artifact | Copies `.plf` to output directory. |
| `step6_prepare_cloudml` | Prepare CloudML package | Runs `prepare_cloudml_upload.py`. **Skipped** when called from chat (always `--skip-upload`). |
| `step7_upload_cloudml` | Upload CloudML package | Runs `submit_cloudml_upload.py`. **Skipped** when called from chat. |

Steps 6-7 are always skipped when triggered via the MCP tool. Upload is handled separately through `cloudml_upload_preview` → `cloudml_upload_execute`.

### Artifact Naming

`derive_artifact_stem_from_checkpoint()` in `trt_build_local.sh` builds the stem:
- Input: `/home/mi/data/data_pkl/s1_nn_nohem_0310ann_0318/epoch_24.pth`
- Stem: `s1_nn_nohem_0310ann_0318_ep24`
- Output path: `.../3090/flatformer_at720_v3/lite/s1_nn_nohem_0310ann_0318_ep24/s1_nn_nohem_0310ann_0318_ep24.plf`

### Branch Checkout

Before building, the script resets local changes in the docker repo:
```bash
cd /mmdet3d && git fetch origin && git checkout -- . && git clean -fd && git checkout $BRANCH && git pull origin $BRANCH
```

### Critical: Two-Step GPU Separation

**Never run ONNX export and trtexec in a single Python process.** The ONNX export holds ~4GB GPU memory that isn't released, causing trtexec to hang. The script runs ONNX export first, then trtexec separately after Python exits.

---

## Pipeline 2: Remote Volc L4

### Scripts

| Script | Role |
|--------|------|
| `scripts/trt_build_l4_submit.py` | Renders YAML from template, calls `volc ml_task submit`. |
| `scripts/trt_build_l4_task.sh` | Runs inside the Volc ML container (L4 GPU). |
| `scripts/trt_build_l4_start.sh` | Manual CLI entry point (not used by MCP tool). |
| `scripts/trt_build_l4_poll.sh` | Manual polling script (not used by monitor). |

### Submission Flow (trt_build_l4_submit.py)

1. Maps `lite`/`large` to preset (branch, convert script, plugin path, trtexec binary, load-inputs dir, export-output path, path replacements).
2. Renders `scripts/volc_trt_l4_template.yaml` with entrypoint = single-line `export KEY=VALUE; ... bash trt_build_l4_task.sh`.
3. Calls `volc ml_task submit --conf <yaml>`, parses `task_id`.
4. Archives YAML to `../submitted_jobs_yamls/{ts}_trt_l4_{name}.yaml`.
5. Outputs: `task_id=`, `out_dir=`, `engine_path=`.

### Remote Task Steps (trt_build_l4_task.sh)

| Step | What It Does |
|------|-------------|
| `sync_code` | Copies vepfs mmdet3d repo to `/mmdet3d`, resets + checks out branch. |
| `pip_install` | `pip install -v --no-deps -e .` |
| `stub_ad_cloud` | Creates stub `ad_cloud` package (auth server unreachable from Volc). |
| `patch_paths` | Patches convert script with correct plugin/trtexec/export paths. |
| `onnx_export` | Runs convert script with `--build --checkpoint`. |
| `trtexec` | Greps convert log for trtexec command, runs it. |
| `inference_check` | Validates engine with `trtexec --loadEngine` + sample inputs. |
| `copy_artifact` | Copies `.plf`, `.onnx`, `output.json` to `$OUT_DIR` on vepfs. |

### L4 Environment Variables

All configuration is passed via env vars in the entrypoint:
- `BUILD_NAME`, `CKPT`, `STEM`, `BRANCH`, `CONVERT_SCRIPT`
- `PLUGIN_PATH`, `TRTEXEC_BIN`, `LOAD_INPUTS_DIR`, `EXPORT_OUTPUT`
- `PATH_REPLACE_OLD` / `PATH_REPLACE_NEW` — prefix substitution for path differences
- `OUT_ROOT` — default `/high_perf_store3/l3_data/wuwenda/lidar_agent_builds/L4`
- `VEPFS_MMDET3D` — source repo on shared vepfs

### Engine Retrieval

On completion, the monitor (`src/trt/monitor.ts`) SCPs the `.plf` from the remote vepfs to:
`/home/mi/data/det_and_seg/L4/flatformer_v3/{name}_L4/`

---

## Monitor System (`src/trt/monitor.ts`)

Started on server boot via `startTrtBuildMonitor(db)`. Runs a `setInterval` every 2 seconds.

### 3090 Monitoring

- Watches `trt-build-{id}.status.json` (mtime-gated to avoid redundant reads).
- Emits `notify("TRT Build Step", ...)` for each step status change.
- After `step3_checkpoint_report` completes: emits `notify("TRT Build Keys", ...)` with missing/unexpected key counts.
- **Heartbeat:** Every 15s while a step is running, emits `notify("TRT Build Heartbeat", ...)`.
- **Terminal detection:** Reads `statusFile.terminal` field, or falls back to checking all step statuses. If all success/skipped → completed. Any failed → failed.
- **Dead process detection:** If `process.kill(pid, 0)` fails and no terminal state, marks build as failed.

### L4 Monitoring

- Polls every 20 seconds.
- Calls `volc ml_task get --id <task_id> --output json` for Volc task status.
- Calls `volc ml_task logs` for stdout, parses step markers (`>>> step_name`).
- Emits notifications for each new step and Volc status change.
- **Heartbeat:** Every 30s while Volc status is `Running`.
- **On completion:** SCPs `.plf` and `output.json` to local machine, runs `parse_engine_output_json.py`.
- **On failure:** Includes SSH hint in notification: `ssh -p 3333 root@localhost cat <remote_out_dir>/build.log`.

### Notifications

All notifications go through `src/events.ts`:
```typescript
notify(title: string, body: string, level: "info" | "success" | "error")
```

Notification titles used:
- `"TRT Build Step"` — step status change
- `"TRT Build Keys"` — checkpoint key mismatch report
- `"TRT Build Heartbeat"` — periodic progress
- `"TRT Build Complete"` — build finished successfully
- `"TRT Build Failed"` — build failed
- `"TRT Upload Confirm"` — engine ready, awaiting user confirmation for CloudML upload
- `"CloudML Upload Complete"` / `"CloudML Upload Failed"` / `"CloudML Upload Declined"` — upload lifecycle

All notifications are broadcast to every connected WebSocket client.

---

## CloudML Upload Flow

Upload is always user-gated. The agent uses two separate tools:

```
Build completes
     │
     ▼
Monitor emits "TRT Upload Confirm" notification
     │
     ▼
src/index.ts injects [context] hint with pending build_id into user's next message
     │
     ▼
Agent follows system prompt rules:
  ├─ User asks question → agent calls cloudml_upload_preview → answers from result
  ├─ User confirms      → agent calls cloudml_upload_execute → upload runs
  └─ User declines      → agent calls trt_decline_upload → marks declined
```

### Upload Scripts

**`prepare_cloudml_upload.py`:** Creates `cloudml_upload/` subdirectory with:
- `model.plf` — copied engine file
- `metadata.json` — name, version, md5, platform (`ipc3090`), format (`plf`), precision (`fp32`), runtime (`trt108`)

**`submit_cloudml_upload.py`:** Validates MD5, strips proxy env vars, runs:
```bash
cloudml model-repo upload <name> <version> <upload_dir> -al <app_label>
```
Post-upload runs `cloudml model-repo describe` as verification.

### Platform / App Label

Both 3090 and L4 builds use `app_label = "ipc3090"`. The model name defaults to the `.plf` filename stem (e.g., `s1_nn_nohem_0310ann_0318_ep24`).

---

## Database: `trt_builds` Table

```sql
CREATE TABLE trt_builds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  model           TEXT NOT NULL,        -- "lite" | "large"
  checkpoint      TEXT NOT NULL,        -- absolute path to .pth
  name            TEXT,                 -- build name / output subdir
  version         TEXT,                 -- set on CloudML upload approval
  status          TEXT NOT NULL DEFAULT 'running',  -- "running" | "completed" | "failed"
  engine_path     TEXT,                 -- absolute path to .plf when done
  stdout          TEXT DEFAULT '',      -- legacy (logs go to .log files now)
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  pid             INTEGER,             -- OS PID (3090 only)
  upload_status   TEXT,                -- "pending_confirm" | "approved" | "declined"
  platform        TEXT DEFAULT '3090', -- "3090" | "L4"
  task_id         TEXT,                -- Volc ML task ID (L4 only)
  instance_id     TEXT,                -- Volc instance ID (L4 only)
  remote_out_dir  TEXT                 -- vepfs output path (L4 only)
);
```

## Status File Format (`trt-build-{id}.status.json`)

Written atomically by `trt_status_cli.py`. Located at `data/runtime-logs/`.

```json
{
  "model": "lite",
  "name": "lite",
  "checkpoint": "/home/mi/data/data_pkl/.../epoch_24.pth",
  "engine_dir": "/home/mi/data/det_and_seg/3090/flatformer_at720_v3/lite/...",
  "steps": [
    { "id": "step1_convert_pth_to_onnx", "name": "Convert pth to onnx", "status": "success" },
    { "id": "step2_build_trt_engine", "name": "Build TRT engine", "status": "running" },
    ...
  ],
  "user_confirm_upload": false,
  "missing_keys": ["key1", "key2"],
  "unexpected_keys": [],
  "terminal": null,
  "reason": null,
  "started_at": "2026-04-24T16:08:51Z",
  "updated_at": "2026-04-24T16:10:22Z"
}
```

Step statuses: `"pending"` → `"running"` → `"success"` | `"failed"` | `"skipped"`

Terminal: `null` (in progress), `"completed"`, or `"failed"` (with optional `reason`).

Step manifest defined in `pipeline/trt_steps.json`.

Companion file `trt-build-{id}.notified.json` tracks which step transitions the monitor has already broadcast.

---

## System Prompt Rules (for the agent)

These rules are in `src/agent/prompts.ts` and guide the agent's behavior:

1. **Tool routing:** 3090/local/dev → `trt_build`. L4/car-side/edge → `trt_build_l4`.
2. **No log reading:** Never read or display runtime logs unless user explicitly asks.
3. **No tight polling:** Don't call `trt_build_status` in a loop. Rely on monitor notifications.
4. **Upload is two-step:** `cloudml_upload_preview` for questions, `cloudml_upload_execute` only on explicit user confirmation.
5. **L4 failure:** Tell user the remote `build.log` path + SSH command. Don't SSH yourself unless asked.
6. **Report step status:** For 3090, report per-step status including missing/unexpected keys at the ONNX step.

---

## Pending Upload Context Injection

When a "TRT Upload Confirm" notification fires, `src/index.ts` stores the `build_id` in a per-WebSocket map. On the user's next message, a `[context]` hint is prepended:

```
[context] A CloudML upload is pending confirmation: build #5 (lite), default version v1.0.0.
Follow the CloudML Upload rules in the system prompt: questions → cloudml_upload_preview;
explicit confirmation → cloudml_upload_execute; decline → trt_decline_upload.

User message: <actual message>
```

The agent decides from natural language which tool to call. No regex matching or fast-paths.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error: Your local changes would be overwritten by checkout` | Docker repo has dirty files | Script now runs `git checkout -- . && git clean -fd` before branch switch |
| `IdentifyException: sdk need to be initialized` | Docker env vars not loaded | Check `source ~/.bashrc` works, verify `/root/.env` exists |
| `init_channels` unexpected keyword | mmdet3d on wrong branch | Correct branch is selected automatically by model preset |
| trtexec stuck at 100% CPU / 0% GPU | GPU memory held by Python | Two-step separation ensures Python exits before trtexec runs |
| `Checkpoint not found in docker` | Path not under `/data_pkl` mount | Ensure checkpoint is under `/home/mi/data/data_pkl/` on host |
| L4 build `stub_ad_cloud` step | Auth server unreachable from Volc | Expected — stub is created automatically |
| `exit 1 before any step started` | Git checkout or docker startup failed | Check `trt-build-{id}.log` for the actual error |
| Tool shows "cancelled by MCP layer" | Codex approval policy mismatch | All write tools have `readOnlyHint: true` annotation |

---

## File Reference

| File | Purpose |
|------|---------|
| `src/agent/tools.ts` | MCP tool implementations (6 TRT-related tools) |
| `src/agent/prompts.ts` | System prompt with TRT rules |
| `src/trt/monitor.ts` | Background monitor (3090 status file + L4 volc polling) |
| `src/events.ts` | `notify()` function + `eventBus` EventEmitter |
| `src/index.ts` | WebSocket handler, pending upload context injection |
| `src/db.ts` | SQLite schema (trt_builds table definition) |
| `scripts/trt_build_start.sh` | 3090 chat entry point |
| `scripts/trt_build_local.sh` | 3090 7-step build runner |
| `scripts/trt_status_cli.py` | Atomic status JSON writer |
| `scripts/docker_trt10_flatformer.sh` | Docker container startup |
| `scripts/trt_build_l4_submit.py` | Volc ML task submission |
| `scripts/trt_build_l4_task.sh` | L4 remote task script (runs in Volc container) |
| `scripts/trt_build_l4_start.sh` | L4 manual CLI entry point |
| `scripts/trt_build_l4_poll.sh` | L4 manual polling script |
| `scripts/volc_trt_l4_template.yaml` | Volc task YAML template |
| `scripts/prepare_cloudml_upload.py` | CloudML package preparation |
| `scripts/submit_cloudml_upload.py` | CloudML upload execution |
| `pipeline/trt_steps.json` | Step manifest (7 steps) |
