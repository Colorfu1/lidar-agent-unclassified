# LiDAR Agent

## What This Is

A hybrid LLM agent + deterministic pipeline system for LiDAR multi-task model training & evaluation (OD + FS + Scene Flow). Interfaces with the mmdet3d codebase at `../mmdet3d/`.

**Core principle:** The LLM reasons and diagnoses. The deterministic YAML DAG pipeline executes. Every change requires user confirmation.

## Design Spec

Full spec: `docs/superpowers/specs/2026-04-21-lidar-agent-design.md`
Implementation plan: `docs/superpowers/plans/` (see active plan)

## Architecture

Three layers, tightly coupled through well-defined interfaces:

1. **Frontend** (`web/`) — React + Vite + TypeScript. Dashboard, chat, experiment tree, DAG viewer, branch merger, data update.
2. **Agent Service** (`src/`) — Node.js + TypeScript + Express/Fastify + WebSocket + SQLite. Uses `@openai/codex-sdk` for LLM reasoning and exposes LiDAR tools through an in-process MCP server.
3. **Pipeline Executor** (`pipeline/`) — Python 3.12, deterministic YAML DAG runner. Interfaces with mmdet3d, Volc ML Platform (CLI), remote machines via SSH, Git.

Node↔Python bridge: Agent Service spawns Python executor as subprocess; communication via JSON over stdin/stdout.

## Key Constraints

- **NEVER read annotation files** (pkl, raw annotations) — too large for context.
- **NEVER execute changes without user confirmation** — agent diagnoses and proposes; user approves; pipeline executes.
- **New model structures only when user explicitly requests** — agent focuses on data/config/training parameter tuning by default.
- **Deterministic pipeline** — DAG runner never skips steps; LLM fills parameters, executor runs fixed structure.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript |
| Agent Service | Node.js 24 + Express + express-ws |
| LLM | `@openai/codex-sdk` + in-process MCP tools |
| Database | SQLite (via `better-sqlite3`) |
| Pipeline Executor | Python 3.12 + PyYAML |
| Job Platform | Volc ML Platform (via `volc` CLI) |
| Remote Access | SSH |
| Version Control | Git (for branch merge operations) |

## Agent SDK Pattern

Custom tools are registered on the local MCP server and Codex SDK connects to `/mcp`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";

const server = new McpServer({ name: "lidar", version: "1.0.0" });
server.registerTool(
  "list_experiments",
  {
    description: "List recorded experiments, optionally filtered.",
    inputSchema: { tag: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await db.list(args)) }],
  })
);

const codex = new Codex({ config: { mcp_servers: { lidar: { url: "http://127.0.0.1:3000/mcp" } } } });
const thread = codex.startThread({ sandboxMode: "read-only", approvalPolicy: "never" });
const { events } = await thread.runStreamed(userInput);
```

Key gotchas:
- Tool names exposed through Codex MCP events are `mcp__<serverName>__<toolName>`.
- Tool schemas use Zod raw shapes (`{ field: z.string() }`), not wrapped `z.object()`.
- Tool failures should `return { isError: true, ... }`, not throw (throwing kills the loop).
- Codex is constrained by prompt, read-only sandbox, and the explicit LiDAR MCP tool surface.

## Project Structure

```
lidar-agent/
├── package.json          # Agent Service deps
├── tsconfig.json
├── .env                  # DB_PATH, Codex/model overrides, SSH config
├── src/                  # Agent Service (TypeScript)
│   ├── index.ts          # Entry (Express + WS)
│   ├── agent/            # Codex SDK session, MCP tools, prompts
│   ├── experiment/       # Manager, DB, comparator
│   ├── branch/           # Git diff, per-file merge
│   ├── data-update/      # Cron/manual trigger
│   ├── pipeline/         # Node↔Python bridge, status tracking
│   └── routes/           # chat.ts, experiments.ts, pipeline.ts
├── pipeline/             # Python Pipeline Executor
│   ├── requirements.txt
│   ├── executor.py       # YAML DAG runner entrypoint
│   ├── stages/           # config_gen, job_submit, job_monitor, result_fetch, ...
│   ├── templates/        # train_eval.yaml, eval_only.yaml, data_update.yaml
│   └── schemas/          # DAG schema validation
├── web/                  # React Frontend
│   └── src/
│       ├── pages/        # Chat, Dashboard, Experiment, BranchMerge, DataUpdate, Pipeline
│       └── components/   # MetricChart, DiffViewer, ExperimentTree, DAGViewer
└── docs/
    └── superpowers/
        ├── specs/        # Design specs
        └── plans/        # Implementation plans
```

## Development

```bash
# Agent Service
npm install
npm run dev            # starts Express + WS on :3000

# Pipeline Executor
cd pipeline && pip install -r requirements.txt
python executor.py --dag templates/train_eval.yaml --params params.json

# Frontend
cd web && npm install && npm run dev   # Vite on :5173
```

## Database Schema (SQLite)

Tables: `experiments`, `eval_results`, `proposals`, `pipeline_runs`, `pipeline_stages`, `branch_merges`, `data_updates`. See spec §8 for full schema.

## Coordinate with mmdet3d

- Configs live in `../mmdet3d/configs/` and `../mmdet3d/projects/`.
- Classes: `['car', 'bus', 'truck', 'cyclist', 'pedestrian', 'barrier']`.
- Work dirs on remote: fetched via SSH (see `.env` for SSH config).

## Volc ML Platform

Job submission uses the `volc` CLI via `job-uploader` / `job-manager` skill patterns. Queue IDs and priorities are listed in the user's global memory (`reference_volc_infrastructure.md`).

## Related Existing Skills

The project leverages workflows already captured as skills (see user's `MEMORY.md`):
- `/job-uploader`, `/job-manager` — Volc job lifecycle
- `/experiment-recorder` — experiment tree / comparison
- `/model-results-grabber` — fetch metrics
- `/feishu-experiment-doc` — doc generation
- `/l3-data-script-runner` — remote data scripts

The pipeline executor stages should mirror these patterns rather than reinvent them.
