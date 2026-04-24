# lidar-agent

`lidar-agent` is a local web app + chat agent for LiDAR experiment operations, with a strong focus on TRT engine conversion and CloudML upload flow.

This document is written as an onboarding and takeover guide so a new development session can continue work quickly.

## 1) Project scope

Main responsibilities:

- Experiment tracking and comparison (OD/FS/FLOW).
- Pipeline/proposal management.
- Chat-driven TRT build orchestration on local 3090 docker.
- Step-by-step build monitoring through websocket notifications.
- User-gated CloudML upload with confirmation flow.

Out of scope:

- Direct model training implementation.
- Full runtime log streaming in chat (logs stay in execute environment files).

## 2) Architecture

Backend:

- Node.js + TypeScript + Express + `express-ws`.
- SQLite (`better-sqlite3`) with WAL mode.
- Codex SDK session wrapper for chat, connected to the in-process LiDAR MCP server at `/mcp`.
- Notification bus for async build/upload events.

Frontend:

- React + Vite + TypeScript SPA (`web/`).
- Chat page consumes websocket events from `/chat`.
- Notification bubbles are rendered in chat UI.

Local scripts:

- `scripts/trt_build_start.sh`: async build launcher + DB row registration.
- `scripts/trt_build_local.sh`: docker-side TRT workflow.
- `scripts/trt_status_cli.py`: atomic status JSON writer.
- `scripts/prepare_cloudml_upload.py`: package prep.
- `scripts/submit_cloudml_upload.py`: upload + evidence.

## 3) Core runtime flow (TRT -> upload)

1. User asks chat to build TRT.
2. Tool `trt_build` calls:
   - `bash scripts/trt_build_start.sh --model ... --checkpoint ... --name ... --detach`
3. Runner writes:
   - DB row in `trt_builds`
   - status file in `data/runtime-logs/trt-build-<id>.status.json`
   - runtime log in `data/runtime-logs/trt-build-<id>.log`
4. `src/trt/monitor.ts` polls running builds and emits:
   - `TRT Build Step`
   - `TRT Build Keys`
   - `TRT Build Heartbeat`
   - `TRT Upload Confirm` on completion
5. Upload confirm bubble shows only uncertain defaults:
   - `version: v1.0.0`
   - `confirm: true`
6. User can reply naturally (`it is ok`, `yes version v2.0.0`, `no skip upload`).
7. `src/index.ts` context bridge maps that reply to `cloudml_upload(request_json=...)` for the pending build.
8. `cloudml_upload` runs prepare + submit with no-proxy env and updates DB `upload_status`.

## 4) Confirmation behavior details

Current intended UX:

- Bubble asks: `Is it ok or need change?`
- User does not need to send JSON manually.
- System maps natural language reply to JSON internally.

Mapping examples:

- `it is ok` -> confirm upload with default version.
- `yes, version v1.2.0` -> confirm upload with `v1.2.0`.
- `no, skip upload` -> decline upload.

Relevant files:

- `src/trt/monitor.ts` (bubble payload creation)
- `web/src/pages/Chat.tsx` (bubble rendering)
- `src/index.ts` (pending confirm context bridge)
- `src/agent/tools.ts` (`cloudml_upload`)
- `src/agent/prompts.ts` (agent rules)

## 5) Local setup and run

Prerequisites:

- Node + npm
- Local Codex login in `~/.codex/auth.json`
- `tmux`
- `sqlite3`
- Docker with required TRT image/toolchain
- `cloudml` CLI (for real upload)

Install:

```bash
cd /home/mi/codes/workspace/lidar-agent
npm install
cd web && npm install
```

Start both backend + frontend:

```bash
bash scripts/dev.sh
```

Health checks:

```bash
curl -fsS http://localhost:3000/health
curl -fsSI http://localhost:5173/ | head -n 1
```

Logs:

- Backend: `/tmp/lidar-agent-backend.log`
- Frontend: `/tmp/lidar-agent-frontend.log`

## 6) Database and state

DB file:

- `data/lidar-agent.db`

Important tables:

- `chat_sessions`, `chat_messages`
- `trt_builds`
- `pipeline_runs`, `pipeline_stages`
- `experiments`, `eval_results`, `proposals`

Build state fields to watch:

- `trt_builds.status`: `running|completed|failed`
- `trt_builds.upload_status`: `pending_confirm|approved|declined`
- `trt_builds.engine_path`

Useful query:

```bash
sqlite3 data/lidar-agent.db "SELECT id,model,name,status,upload_status,version,engine_path,started_at,completed_at FROM trt_builds ORDER BY id DESC LIMIT 20;"
```

## 7) Project map (where to start)

Backend entry:

- `src/index.ts`

Agent orchestration:

- `src/agent/session.ts`
- `src/agent/prompts.ts`
- `src/agent/tools.ts`

TRT monitor:

- `src/trt/monitor.ts`

DB schema/migrations:

- `src/db.ts`

Frontend chat:

- `web/src/pages/Chat.tsx`
- `web/src/hooks/useNotifications.ts`

TRT scripts:

- `scripts/trt_build_start.sh`
- `scripts/trt_build_local.sh`
- `scripts/trt_status_cli.py`

CloudML scripts:

- `scripts/prepare_cloudml_upload.py`
- `scripts/submit_cloudml_upload.py`

Reference docs:

- `docs/trt-engine-build-pipeline.md`
- `docs/superpowers/specs/2026-04-21-lidar-agent-design.md`
- `docs/superpowers/plans/2026-04-23-lidar-agent-plan.md`

## 8) Known issues (current)

TypeScript build blockers currently present:

- Backend `npm run build` fails in:
  - `src/data-update/scheduler.ts` (`unknown[]` vs `object[]`)
- Frontend `web npm run build` fails in:
  - `web/src/pages/Dashboard.tsx` (unused vars, nullable `el`)
  - `web/src/pages/Pipeline.tsx` (unused component)

Operational caveats:

- Notifications are websocket events, not persisted as first-class DB notification records.
- `scripts/trt_build_local.sh` copies a staging `.plf` into repo root before copying to target output dir; root `.plf` leftovers can accumulate.
- Synthetic test builds inserted into `trt_builds` can clutter history if not cleaned.

## 9) Takeover checklist (first 30 minutes)

1. Start services with `bash scripts/dev.sh`.
2. Confirm `/health` and frontend reachability.
3. Read latest `trt_builds` rows and runtime logs.
4. Verify one pending upload flow in chat (`it is ok` should trigger upload).
5. Check `src/index.ts` confirm bridge behavior if context is lost.
6. Check `src/trt/monitor.ts` bubble payload + `Chat.tsx` rendering stay aligned.
7. Run build commands to verify no new TS regressions:
   - `npm run build`
   - `npm -C web run build`
8. If stabilizing releases, address known TS blockers first.

## 10) Recommended next improvements

1. Persist notification events in DB and reload them in chat history after refresh.
2. Remove root `.plf` staging side effect (copy directly to output dir or auto-clean).
3. Add explicit upload-confirm session state table instead of heuristic parsing.
4. Add integration test for: `TRT Upload Confirm` -> user says `it is ok` -> upload tool called.
