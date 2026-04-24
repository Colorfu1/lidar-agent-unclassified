# LiDAR Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hybrid LLM agent + deterministic pipeline system for managing LiDAR multi-task model training and evaluation across OD, FS, and Scene Flow tasks.

**Architecture:** Three-layer system — React UI for visualization/interaction, Node.js Agent Service with Claude Agent SDK for LLM reasoning + SQLite state, Python Pipeline Executor as a deterministic YAML DAG runner. Node↔Python communication via subprocess JSON over stdin/stdout.

**Tech Stack:** Node.js 24, TypeScript, Express, express-ws, better-sqlite3, @anthropic-ai/claude-agent-sdk, zod, React 18, Vite, Python 3.12, PyYAML

**Spec:** `docs/superpowers/specs/2026-04-21-lidar-agent-design.md`

---

## File Map

### Agent Service (`src/`)

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Express server entry, mounts routes + WS |
| `src/db.ts` | SQLite connection, schema init, typed query helpers |
| `src/agent/tools.ts` | All Claude Agent SDK custom tools via `createSdkMcpServer()` |
| `src/agent/session.ts` | Create/resume agent sessions, streaming handler |
| `src/agent/prompts.ts` | System prompt with domain knowledge |
| `src/experiment/manager.ts` | Experiment CRUD, comparison logic |
| `src/pipeline/bridge.ts` | Spawn Python executor subprocess, JSON protocol |
| `src/pipeline/status.ts` | Track pipeline run state from bridge events |
| `src/branch/merger.ts` | Git diff parsing, per-file merge operations |
| `src/data-update/scheduler.ts` | Cron/manual data update triggers |
| `src/routes/chat.ts` | WebSocket chat endpoint |
| `src/routes/experiments.ts` | REST experiment endpoints |
| `src/routes/pipeline.ts` | REST pipeline endpoints |
| `src/routes/branches.ts` | REST branch merge endpoints |
| `src/routes/data-update.ts` | REST data update endpoints |

### Pipeline Executor (`pipeline/`)

| File | Responsibility |
|------|---------------|
| `pipeline/executor.py` | DAG runner: parse YAML, resolve deps, run stages |
| `pipeline/bridge_protocol.py` | JSON stdin/stdout protocol for Node communication |
| `pipeline/stages/base.py` | Base stage class with input/output contract |
| `pipeline/stages/config_validate.py` | Validate mmdet3d config file |
| `pipeline/stages/volc_submit.py` | Submit job via `volc ml_task submit` |
| `pipeline/stages/volc_monitor.py` | Poll job status until terminal |
| `pipeline/stages/ssh_fetch.py` | Fetch files from remote via SSH/SCP |
| `pipeline/stages/result_collect.py` | Parse eval result JSONs into metrics |
| `pipeline/stages/db_store.py` | Send results back to Node for DB storage |
| `pipeline/stages/run_scripts.py` | Execute data processing scripts |
| `pipeline/stages/data_validate.py` | Validate processed data output |
| `pipeline/stages/notify.py` | Send status notification back to Node |
| `pipeline/templates/train_eval.yaml` | Standard train→eval DAG |
| `pipeline/templates/eval_only.yaml` | Eval-only DAG |
| `pipeline/templates/data_update.yaml` | Data processing DAG |
| `pipeline/schemas/dag_schema.py` | YAML DAG validation |

### Frontend (`web/`)

| File | Responsibility |
|------|---------------|
| `web/src/App.tsx` | Router + layout shell |
| `web/src/api.ts` | Fetch/WS client helpers |
| `web/src/pages/Chat.tsx` | Agent chat interface |
| `web/src/pages/Dashboard.tsx` | Experiment list + summary |
| `web/src/pages/Experiment.tsx` | Single experiment detail + metrics |
| `web/src/pages/Pipeline.tsx` | DAG execution viewer |
| `web/src/pages/BranchMerge.tsx` | Per-file branch merge UI |
| `web/src/pages/DataUpdate.tsx` | Data pipeline status |
| `web/src/components/MetricChart.tsx` | Recharts line/bar for metrics |
| `web/src/components/ExperimentTree.tsx` | Lineage tree (react-flow) |
| `web/src/components/DiffViewer.tsx` | Side-by-side code diff |
| `web/src/components/DAGViewer.tsx` | Pipeline stage graph |

---

## Phase 1: Project Bootstrap

### Task 1: Initialize Node.js Agent Service

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "lidar-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.90.0",
    "better-sqlite3": "^11.0.0",
    "express": "^4.21.0",
    "express-ws": "^5.0.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/express-ws": "^3.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create .env.example and .gitignore**

`.env.example`:
```
ANTHROPIC_API_KEY=sk-ant-...
DB_PATH=./data/lidar-agent.db
MMDET3D_ROOT=../mmdet3d
SSH_HOST=root@localhost
SSH_PORT=3333
PORT=3000
```

`.gitignore`:
```
node_modules/
dist/
.env
data/*.db
web/node_modules/
web/dist/
pipeline/__pycache__/
*.pyc
```

- [ ] **Step 4: Create minimal src/index.ts**

```typescript
import express from "express";
import expressWs from "express-ws";

const PORT = parseInt(process.env.PORT || "3000");
const { app } = expressWs(express());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`lidar-agent listening on :${PORT}`);
});
```

- [ ] **Step 5: Install dependencies and verify**

```bash
cd /home/mi/codes/workspace/lidar-agent && npm install
npx tsx src/index.ts &
sleep 1
curl http://localhost:3000/health
kill %1
```

Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 6: Commit**

```bash
git init
git add package.json tsconfig.json .env.example .gitignore src/index.ts
git commit -m "feat: initialize Node.js agent service scaffold"
```

---

### Task 2: Initialize Python Pipeline Executor

**Files:**
- Create: `pipeline/requirements.txt`, `pipeline/executor.py`, `pipeline/bridge_protocol.py`, `pipeline/stages/__init__.py`, `pipeline/stages/base.py`

- [ ] **Step 1: Create requirements.txt**

```
pyyaml>=6.0
```

- [ ] **Step 2: Create bridge_protocol.py — JSON stdin/stdout protocol**

```python
import json
import sys
from typing import Any


def read_request() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def send_response(msg_type: str, data: dict[str, Any]) -> None:
    payload = {"type": msg_type, **data}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def send_stage_started(stage_id: str) -> None:
    send_response("stage_started", {"stage_id": stage_id})


def send_stage_completed(stage_id: str, outputs: dict[str, Any]) -> None:
    send_response("stage_completed", {"stage_id": stage_id, "outputs": outputs})


def send_stage_failed(stage_id: str, error: str) -> None:
    send_response("stage_failed", {"stage_id": stage_id, "error": error})


def send_pipeline_completed(pipeline_id: str) -> None:
    send_response("pipeline_completed", {"pipeline_id": pipeline_id})


def send_pipeline_failed(pipeline_id: str, error: str) -> None:
    send_response("pipeline_failed", {"pipeline_id": pipeline_id, "error": error})
```

- [ ] **Step 3: Create base stage class**

`pipeline/stages/__init__.py`: empty file.

`pipeline/stages/base.py`:
```python
from abc import ABC, abstractmethod
from typing import Any


class Stage(ABC):
    def __init__(self, stage_id: str, inputs: dict[str, Any]):
        self.stage_id = stage_id
        self.inputs = inputs

    @abstractmethod
    def run(self) -> dict[str, Any]:
        """Execute stage. Returns outputs dict. Raises on failure."""
        ...
```

- [ ] **Step 4: Create executor.py — DAG runner skeleton**

```python
import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

from bridge_protocol import (
    read_request,
    send_pipeline_completed,
    send_pipeline_failed,
    send_stage_completed,
    send_stage_failed,
    send_stage_started,
)


def load_dag(yaml_path: str) -> dict[str, Any]:
    with open(yaml_path) as f:
        return yaml.safe_load(f)


def resolve_variable(value: str, context: dict[str, Any]) -> str:
    if not isinstance(value, str):
        return value
    result = value
    for key, val in context.items():
        result = result.replace(f"${{{key}}}", str(val))
    return result


def resolve_inputs(inputs: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {k: resolve_variable(v, context) for k, v in inputs.items()}


def topological_sort(stages: list[dict]) -> list[dict]:
    id_to_stage = {s["id"]: s for s in stages}
    visited: set[str] = set()
    order: list[dict] = []

    def visit(stage_id: str) -> None:
        if stage_id in visited:
            return
        visited.add(stage_id)
        for dep in id_to_stage[stage_id].get("depends_on", []):
            visit(dep)
        order.append(id_to_stage[stage_id])

    for s in stages:
        visit(s["id"])
    return order


STAGE_REGISTRY: dict[str, type] = {}


def register_stage(stage_type: str, cls: type) -> None:
    STAGE_REGISTRY[stage_type] = cls


def run_pipeline(dag: dict, params: dict[str, Any]) -> None:
    context = dict(params)
    stages = topological_sort(dag["stages"])

    for stage_def in stages:
        stage_id = stage_def["id"]
        stage_type = stage_def["type"]
        raw_inputs = stage_def.get("inputs", {})
        resolved = resolve_inputs(raw_inputs, context)

        send_stage_started(stage_id)

        cls = STAGE_REGISTRY.get(stage_type)
        if cls is None:
            send_stage_failed(stage_id, f"Unknown stage type: {stage_type}")
            if stage_def.get("fail_fast", False):
                send_pipeline_failed(dag["name"], f"Stage {stage_id} failed")
                return
            continue

        try:
            stage = cls(stage_id, resolved)
            outputs = stage.run()
            for out_key, out_val in outputs.items():
                context[f"{stage_id}.output.{out_key}"] = out_val
            send_stage_completed(stage_id, outputs)
        except Exception as e:
            send_stage_failed(stage_id, str(e))
            if stage_def.get("fail_fast", True):
                send_pipeline_failed(dag["name"], f"Stage {stage_id}: {e}")
                return

    send_pipeline_completed(dag["name"])


def main_bridge_mode() -> None:
    """Run in bridge mode: read JSON requests from stdin."""
    while True:
        request = read_request()
        if request.get("type") == "run_pipeline":
            dag = load_dag(request["dag_path"])
            run_pipeline(dag, request.get("params", {}))
        elif request.get("type") == "ping":
            sys.stdout.write(json.dumps({"type": "pong"}) + "\n")
            sys.stdout.flush()


def main_cli_mode(dag_path: str, params_path: str | None) -> None:
    """Run from CLI directly."""
    dag = load_dag(dag_path)
    params = {}
    if params_path:
        with open(params_path) as f:
            params = json.load(f)
    run_pipeline(dag, params)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", action="store_true", help="Run in bridge mode (JSON stdin/stdout)")
    parser.add_argument("--dag", help="DAG YAML path")
    parser.add_argument("--params", help="Params JSON path")
    args = parser.parse_args()

    if args.bridge:
        main_bridge_mode()
    elif args.dag:
        main_cli_mode(args.dag, args.params)
    else:
        parser.print_help()
```

- [ ] **Step 5: Test executor imports**

```bash
cd /home/mi/codes/workspace/lidar-agent/pipeline
pip install -r requirements.txt
python -c "from executor import load_dag, topological_sort; print('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add pipeline/
git commit -m "feat: add Python pipeline executor with DAG runner and bridge protocol"
```

---

### Task 3: Initialize React Frontend

**Files:**
- Create: `web/` via Vite scaffold, then `web/src/App.tsx`, `web/src/api.ts`

- [ ] **Step 1: Scaffold Vite React TypeScript project**

```bash
cd /home/mi/codes/workspace/lidar-agent
npm create vite@latest web -- --template react-ts
cd web && npm install
npm install react-router-dom recharts
```

- [ ] **Step 2: Replace web/src/App.tsx with router shell**

```tsx
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";

function Nav() {
  const links = [
    { to: "/", label: "Chat" },
    { to: "/dashboard", label: "Dashboard" },
    { to: "/pipeline", label: "Pipeline" },
    { to: "/branches", label: "Branches" },
    { to: "/data", label: "Data" },
  ];
  return (
    <nav style={{ display: "flex", gap: 16, padding: 12, borderBottom: "1px solid #333" }}>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} style={({ isActive }) => ({ fontWeight: isActive ? 700 : 400 })}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Placeholder({ name }: { name: string }) {
  return <div style={{ padding: 24 }}>{name} — coming soon</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Placeholder name="Chat" />} />
        <Route path="/dashboard" element={<Placeholder name="Dashboard" />} />
        <Route path="/experiment/:id" element={<Placeholder name="Experiment" />} />
        <Route path="/pipeline" element={<Placeholder name="Pipeline" />} />
        <Route path="/branches" element={<Placeholder name="Branches" />} />
        <Route path="/data" element={<Placeholder name="Data" />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Create web/src/api.ts — client helpers**

```typescript
const BASE = "http://localhost:3000";

export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function createChatSocket(): WebSocket {
  return new WebSocket("ws://localhost:3000/chat");
}
```

- [ ] **Step 4: Verify frontend starts**

```bash
cd /home/mi/codes/workspace/lidar-agent/web && npm run dev -- --host &
sleep 3
curl -s http://localhost:5173 | head -5
kill %1
```

Expected: HTML response with Vite scaffold.

- [ ] **Step 5: Add Vite proxy config for API**

In `web/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/chat": { target: "ws://localhost:3000", ws: true },
    },
  },
});
```

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat: scaffold React frontend with router and API client"
```

---

## Phase 2: Database Layer

### Task 4: SQLite Schema and Database Module

**Files:**
- Create: `src/db.ts`
- Test: `src/db.test.ts`

- [ ] **Step 1: Write test for DB initialization**

`src/db.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Db } from "./db.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-test.db";

describe("db", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(TEST_DB);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates all tables", () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("experiments");
    expect(tables).toContain("eval_results");
    expect(tables).toContain("proposals");
    expect(tables).toContain("pipeline_runs");
    expect(tables).toContain("pipeline_stages");
    expect(tables).toContain("branch_merges");
    expect(tables).toContain("data_updates");
  });

  it("inserts and retrieves an experiment", () => {
    db.raw.prepare(`
      INSERT INTO experiments (name, config_path, dataset_version, status)
      VALUES ('test-exp', '/configs/test.py', 'v1', 'created')
    `).run();
    const row: any = db.raw.prepare("SELECT * FROM experiments WHERE name = 'test-exp'").get();
    expect(row.name).toBe("test-exp");
    expect(row.status).toBe("created");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/mi/codes/workspace/lidar-agent && npx vitest run src/db.test.ts
```

Expected: FAIL — `createDb` not found.

- [ ] **Step 3: Implement src/db.ts**

```typescript
import Database from "better-sqlite3";

export interface Db {
  raw: Database.Database;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES experiments(id),
    config_path TEXT,
    dataset_version TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS eval_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id INTEGER NOT NULL REFERENCES experiments(id),
    task_type TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    per_class_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id INTEGER REFERENCES experiments(id),
    change_type TEXT NOT NULL,
    description TEXT NOT NULL,
    config_diff TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id INTEGER REFERENCES experiments(id),
    dag_template TEXT NOT NULL,
    params_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pipeline_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
    stage_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    inputs_json TEXT,
    outputs_json TEXT,
    logs TEXT,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS branch_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    files_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS data_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT,
    dataset_version TEXT,
    total_frames INTEGER,
    class_distribution_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export function createDb(dbPath: string): Db {
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  return {
    raw,
    close() {
      raw.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/db.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add SQLite database module with full schema"
```

---

### Task 5: Experiment Manager

**Files:**
- Create: `src/experiment/manager.ts`
- Test: `src/experiment/manager.test.ts`

- [ ] **Step 1: Write tests**

`src/experiment/manager.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Db } from "../db.js";
import { ExperimentManager } from "./manager.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-exp-test.db";

describe("ExperimentManager", () => {
  let db: Db;
  let mgr: ExperimentManager;

  beforeEach(() => {
    db = createDb(TEST_DB);
    mgr = new ExperimentManager(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates and lists experiments", () => {
    const id = mgr.create({ name: "exp-a", config_path: "/cfg/a.py", dataset_version: "v1" });
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].name).toBe("exp-a");
  });

  it("gets experiment by id", () => {
    const id = mgr.create({ name: "exp-b", config_path: "/cfg/b.py", dataset_version: "v2" });
    const exp = mgr.get(id);
    expect(exp?.name).toBe("exp-b");
    expect(exp?.dataset_version).toBe("v2");
  });

  it("stores and retrieves eval results", () => {
    const expId = mgr.create({ name: "exp-c", config_path: "/cfg/c.py", dataset_version: "v1" });
    mgr.addEvalResult(expId, {
      task_type: "OD",
      metric_name: "mAP",
      metric_value: 0.72,
      per_class_json: JSON.stringify({ car: 0.85, truck: 0.61 }),
    });
    const results = mgr.getEvalResults(expId);
    expect(results).toHaveLength(1);
    expect(results[0].metric_value).toBe(0.72);
  });

  it("compares two experiments", () => {
    const a = mgr.create({ name: "exp-a", config_path: "/cfg/a.py", dataset_version: "v1" });
    const b = mgr.create({ name: "exp-b", config_path: "/cfg/b.py", dataset_version: "v1" });
    mgr.addEvalResult(a, { task_type: "OD", metric_name: "mAP", metric_value: 0.70, per_class_json: "{}" });
    mgr.addEvalResult(b, { task_type: "OD", metric_name: "mAP", metric_value: 0.75, per_class_json: "{}" });
    const diff = mgr.compare(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0].delta).toBeCloseTo(0.05);
  });

  it("filters by status", () => {
    mgr.create({ name: "exp-done", config_path: "/cfg/d.py", dataset_version: "v1" });
    const id2 = mgr.create({ name: "exp-run", config_path: "/cfg/e.py", dataset_version: "v1" });
    db.raw.prepare("UPDATE experiments SET status = 'running' WHERE id = ?").run(id2);
    const running = mgr.list({ status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0].name).toBe("exp-run");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/experiment/manager.test.ts
```

Expected: FAIL — `ExperimentManager` not found.

- [ ] **Step 3: Implement manager**

`src/experiment/manager.ts`:
```typescript
import type { Db } from "../db.js";

interface CreateExperiment {
  name: string;
  parent_id?: number;
  config_path: string;
  dataset_version: string;
}

interface EvalResultInput {
  task_type: string;
  metric_name: string;
  metric_value: number;
  per_class_json?: string;
}

interface Experiment {
  id: number;
  name: string;
  parent_id: number | null;
  config_path: string;
  dataset_version: string;
  status: string;
  created_at: string;
}

interface EvalResult {
  id: number;
  experiment_id: number;
  task_type: string;
  metric_name: string;
  metric_value: number;
  per_class_json: string | null;
  created_at: string;
}

interface MetricDiff {
  task_type: string;
  metric_name: string;
  value_a: number;
  value_b: number;
  delta: number;
}

interface ListFilters {
  status?: string;
  task_type?: string;
}

export class ExperimentManager {
  constructor(private db: Db) {}

  create(input: CreateExperiment): number {
    const result = this.db.raw
      .prepare(
        `INSERT INTO experiments (name, parent_id, config_path, dataset_version, status)
         VALUES (?, ?, ?, ?, 'created')`
      )
      .run(input.name, input.parent_id ?? null, input.config_path, input.dataset_version);
    return Number(result.lastInsertRowid);
  }

  get(id: number): Experiment | undefined {
    return this.db.raw.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Experiment | undefined;
  }

  list(filters?: ListFilters): Experiment[] {
    if (filters?.status) {
      return this.db.raw
        .prepare("SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC")
        .all(filters.status) as Experiment[];
    }
    return this.db.raw.prepare("SELECT * FROM experiments ORDER BY created_at DESC").all() as Experiment[];
  }

  addEvalResult(experimentId: number, input: EvalResultInput): number {
    const result = this.db.raw
      .prepare(
        `INSERT INTO eval_results (experiment_id, task_type, metric_name, metric_value, per_class_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(experimentId, input.task_type, input.metric_name, input.metric_value, input.per_class_json ?? null);
    return Number(result.lastInsertRowid);
  }

  getEvalResults(experimentId: number, taskType?: string): EvalResult[] {
    if (taskType) {
      return this.db.raw
        .prepare("SELECT * FROM eval_results WHERE experiment_id = ? AND task_type = ?")
        .all(experimentId, taskType) as EvalResult[];
    }
    return this.db.raw
      .prepare("SELECT * FROM eval_results WHERE experiment_id = ?")
      .all(experimentId) as EvalResult[];
  }

  compare(idA: number, idB: number): MetricDiff[] {
    const resultsA = this.getEvalResults(idA);
    const resultsB = this.getEvalResults(idB);
    const diffs: MetricDiff[] = [];

    const keyA = new Map(resultsA.map((r) => [`${r.task_type}:${r.metric_name}`, r.metric_value]));

    for (const rb of resultsB) {
      const key = `${rb.task_type}:${rb.metric_name}`;
      const va = keyA.get(key);
      if (va !== undefined) {
        diffs.push({
          task_type: rb.task_type,
          metric_name: rb.metric_name,
          value_a: va,
          value_b: rb.metric_value,
          delta: rb.metric_value - va,
        });
      }
    }
    return diffs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/experiment/manager.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/experiment/
git commit -m "feat: add experiment manager with CRUD, eval results, and comparison"
```

---

## Phase 3: Node↔Python Bridge

### Task 6: Pipeline Bridge

**Files:**
- Create: `src/pipeline/bridge.ts`
- Test: `src/pipeline/bridge.test.ts`

- [ ] **Step 1: Write test**

`src/pipeline/bridge.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { PipelineBridge } from "./bridge.js";
import path from "path";

const PIPELINE_DIR = path.resolve(import.meta.dirname, "../../pipeline");

describe("PipelineBridge", () => {
  it("pings the Python executor", async () => {
    const bridge = new PipelineBridge(PIPELINE_DIR);
    const result = await bridge.ping();
    expect(result).toBe(true);
    bridge.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/pipeline/bridge.test.ts
```

Expected: FAIL — `PipelineBridge` not found.

- [ ] **Step 3: Implement bridge**

`src/pipeline/bridge.ts`:
```typescript
import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";
import path from "path";
import { EventEmitter } from "events";

interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: BridgeMessage) => void;

export class PipelineBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pendingResolve: ((msg: BridgeMessage) => void) | null = null;

  constructor(private pipelineDir: string) {
    super();
  }

  private ensureStarted(): void {
    if (this.proc) return;

    this.proc = spawn("python3", [path.join(this.pipelineDir, "executor.py"), "--bridge"], {
      cwd: this.pipelineDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const msg: BridgeMessage = JSON.parse(line);
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          resolve(msg);
        } else {
          this.emit("message", msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    });

    this.proc.stderr?.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });
  }

  private send(data: object): void {
    this.ensureStarted();
    this.proc!.stdin!.write(JSON.stringify(data) + "\n");
  }

  private waitForMessage(): Promise<BridgeMessage> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async ping(): Promise<boolean> {
    this.send({ type: "ping" });
    const msg = await this.waitForMessage();
    return msg.type === "pong";
  }

  async runPipeline(dagPath: string, params: Record<string, unknown>, onMessage: MessageHandler): Promise<void> {
    this.ensureStarted();

    const handler = (msg: BridgeMessage) => {
      onMessage(msg);
    };
    this.on("message", handler);

    this.send({ type: "run_pipeline", dag_path: dagPath, params });

    return new Promise((resolve, reject) => {
      const done = (msg: BridgeMessage) => {
        if (msg.type === "pipeline_completed" || msg.type === "pipeline_failed") {
          this.off("message", handler);
          this.off("message", done);
          if (msg.type === "pipeline_failed") {
            reject(new Error(msg.error as string));
          } else {
            resolve();
          }
        }
      };
      this.on("message", done);
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/pipeline/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/
git commit -m "feat: add Node-Python pipeline bridge with JSON stdin/stdout protocol"
```

---

## Phase 4: Agent Service

### Task 7: Agent Tools (MCP Server)

**Files:**
- Create: `src/agent/tools.ts`, `src/agent/prompts.ts`
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write test**

`src/agent/tools.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgentTools } from "./tools.js";
import { createDb, type Db } from "../db.js";
import { ExperimentManager } from "../experiment/manager.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-tools-test.db";

describe("agent tools", () => {
  let db: Db;
  let mgr: ExperimentManager;

  beforeEach(() => {
    db = createDb(TEST_DB);
    mgr = new ExperimentManager(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a valid MCP server with all tools", () => {
    const server = createAgentTools(mgr);
    expect(server).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/tools.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create prompts.ts**

`src/agent/prompts.ts`:
```typescript
export const SYSTEM_PROMPT = `You are a LiDAR perception model training assistant. You help manage experiments across three tasks: Object Detection (OD), Free Space (FS), and Scene Flow (FLOW).

## What You Do
- Analyze experiment results and diagnose performance issues.
- Compare experiments to identify regressions and their root causes.
- Propose config/data changes to fix issues. Every proposal requires user approval.

## Classes
car, bus, truck, cyclist, pedestrian, barrier

## Key Metrics
- OD: mAP, per-class AP
- FS: mIoU, per-class IoU
- FLOW: EPE (end-point error), per-class EPE

## Rules
- NEVER execute changes directly. Use propose_change to create proposals.
- NEVER read annotation files (pkl, raw data).
- Focus on data/config/training parameter tuning unless the user asks for model changes.
- When diagnosing regressions, always check both config diffs AND data version diffs.
- Present findings as: comparison table + diagnosis summary + proposed fixes.
`;
```

- [ ] **Step 4: Implement tools.ts**

`src/agent/tools.ts`:
```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ExperimentManager } from "../experiment/manager.js";
import fs from "fs";

export function createAgentTools(mgr: ExperimentManager) {
  const listExperiments = tool(
    "list_experiments",
    "List recorded experiments. Optionally filter by status or task type.",
    {
      status: z.string().optional().describe("Filter by status: created, running, completed, failed"),
    },
    async (args) => {
      const exps = mgr.list(args.status ? { status: args.status } : undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify(exps, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const getEvalResults = tool(
    "get_eval_results",
    "Get evaluation results for an experiment. Returns per-class metrics and overall scores.",
    {
      experiment_id: z.number().describe("Experiment ID"),
      task_type: z.string().optional().describe("Filter by task: OD, FS, FLOW"),
    },
    async (args) => {
      const results = mgr.getEvalResults(args.experiment_id, args.task_type);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const compareExperiments = tool(
    "compare_experiments",
    "Compare metrics between two experiments. Returns a diff table with deltas per metric.",
    {
      exp_id_a: z.number().describe("First experiment ID"),
      exp_id_b: z.number().describe("Second experiment ID"),
    },
    async (args) => {
      const diff = mgr.compare(args.exp_id_a, args.exp_id_b);
      return { content: [{ type: "text" as const, text: JSON.stringify(diff, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const readConfig = tool(
    "read_config",
    "Read and return the contents of an mmdet3d config file.",
    {
      config_path: z.string().describe("Path to config file relative to mmdet3d root"),
    },
    async (args) => {
      try {
        const mmdet3dRoot = process.env.MMDET3D_ROOT || "../mmdet3d";
        const fullPath = `${mmdet3dRoot}/${args.config_path}`;
        const content = fs.readFileSync(fullPath, "utf-8");
        return { content: [{ type: "text" as const, text: content }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to read config: ${e}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } }
  );

  const proposeChange = tool(
    "propose_change",
    "Propose a configuration or data change. Creates a pending proposal that requires user approval before execution.",
    {
      experiment_id: z.number().optional().describe("Related experiment ID"),
      change_type: z.enum(["model", "data"]).describe("Type of change"),
      description: z.string().describe("Human-readable description of the proposed change"),
      config_diff: z.string().optional().describe("Unified diff or config snippet showing the change"),
    },
    async (args) => {
      const result = mgr.db.raw
        .prepare(
          `INSERT INTO proposals (experiment_id, change_type, description, config_diff, status)
           VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(args.experiment_id ?? null, args.change_type, args.description, args.config_diff ?? null);
      const id = Number(result.lastInsertRowid);
      return {
        content: [
          {
            type: "text" as const,
            text: `Proposal #${id} created (pending user approval).\n\nType: ${args.change_type}\nDescription: ${args.description}`,
          },
        ],
      };
    }
  );

  return createSdkMcpServer({
    name: "lidar",
    version: "1.0.0",
    tools: [listExperiments, getEvalResults, compareExperiments, readConfig, proposeChange],
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/agent/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/
git commit -m "feat: add Claude Agent SDK tools (list, compare, read_config, propose_change)"
```

---

### Task 8: Agent Session Management

**Files:**
- Create: `src/agent/session.ts`
- Test: `src/agent/session.test.ts`

- [ ] **Step 1: Write test**

`src/agent/session.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { AgentSession } from "./session.js";
import { createAgentTools } from "./tools.js";
import { createDb } from "../db.js";
import { ExperimentManager } from "../experiment/manager.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-session-test.db";

describe("AgentSession", () => {
  it("constructs with required dependencies", () => {
    const db = createDb(TEST_DB);
    const mgr = new ExperimentManager(db);
    const tools = createAgentTools(mgr);
    const session = new AgentSession(tools);
    expect(session).toBeDefined();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/agent/session.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement session.ts**

`src/agent/session.ts`:
```typescript
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "./prompts.js";

type McpServer = ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer>;

export interface StreamMessage {
  type: "text" | "tool_call" | "tool_result" | "done" | "error";
  content: string;
}

export class AgentSession {
  private mcpServer: McpServer;

  constructor(mcpServer: McpServer) {
    this.mcpServer = mcpServer;
  }

  async *chat(userMessage: string): AsyncGenerator<StreamMessage> {
    try {
      for await (const msg of query({
        prompt: userMessage,
        options: {
          model: process.env.AGENT_MODEL || "claude-sonnet-4-5",
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { lidar: this.mcpServer },
          allowedTools: [
            "mcp__lidar__list_experiments",
            "mcp__lidar__get_eval_results",
            "mcp__lidar__compare_experiments",
            "mcp__lidar__read_config",
          ],
          tools: [],
          maxTurns: 15,
          permissionMode: "default" as const,
        },
      })) {
        yield* this.processMessage(msg);
      }
      yield { type: "done", content: "" };
    } catch (e) {
      yield { type: "error", content: String(e) };
    }
  }

  private *processMessage(msg: SDKMessage): Generator<StreamMessage> {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          yield { type: "text", content: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool_call",
            content: JSON.stringify({ name: block.name, input: block.input }),
          };
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "error") {
        yield { type: "error", content: String(msg.error) };
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/agent/session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/session.ts src/agent/session.test.ts
git commit -m "feat: add agent session with streaming chat via Claude Agent SDK"
```

---

## Phase 5: HTTP/WebSocket Server

### Task 9: REST Routes

**Files:**
- Modify: `src/index.ts`
- Create: `src/routes/experiments.ts`, `src/routes/pipeline.ts`

- [ ] **Step 1: Create experiment routes**

`src/routes/experiments.ts`:
```typescript
import { Router } from "express";
import type { ExperimentManager } from "../experiment/manager.js";

export function experimentRoutes(mgr: ExperimentManager): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const exps = mgr.list();
    res.json(exps);
  });

  router.get("/:id", (req, res) => {
    const exp = mgr.get(Number(req.params.id));
    if (!exp) return res.status(404).json({ error: "Not found" });
    res.json(exp);
  });

  router.get("/:id/results", (req, res) => {
    const results = mgr.getEvalResults(Number(req.params.id), req.query.task_type as string | undefined);
    res.json(results);
  });

  router.get("/:id/compare/:otherId", (req, res) => {
    const diff = mgr.compare(Number(req.params.id), Number(req.params.otherId));
    res.json(diff);
  });

  router.post("/", (req, res) => {
    const { name, config_path, dataset_version, parent_id } = req.body;
    const id = mgr.create({ name, config_path, dataset_version, parent_id });
    res.status(201).json({ id });
  });

  return router;
}
```

- [ ] **Step 2: Create pipeline routes**

`src/routes/pipeline.ts`:
```typescript
import { Router } from "express";
import type { Db } from "../db.js";

export function pipelineRoutes(db: Db): Router {
  const router = Router();

  router.get("/runs", (_req, res) => {
    const runs = db.raw.prepare("SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 50").all();
    res.json(runs);
  });

  router.get("/runs/:id", (req, res) => {
    const run = db.raw.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(Number(req.params.id));
    if (!run) return res.status(404).json({ error: "Not found" });
    res.json(run);
  });

  router.get("/runs/:id/stages", (req, res) => {
    const stages = db.raw
      .prepare("SELECT * FROM pipeline_stages WHERE pipeline_run_id = ? ORDER BY id")
      .all(Number(req.params.id));
    res.json(stages);
  });

  router.get("/proposals", (req, res) => {
    const status = req.query.status as string | undefined;
    const q = status
      ? db.raw.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC").all(status)
      : db.raw.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT 50").all();
    res.json(q);
  });

  router.post("/proposals/:id/approve", (req, res) => {
    db.raw.prepare("UPDATE proposals SET status = 'approved' WHERE id = ? AND status = 'pending'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.post("/proposals/:id/reject", (req, res) => {
    db.raw.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: Update src/index.ts to wire everything together**

```typescript
import express from "express";
import expressWs from "express-ws";
import { createDb } from "./db.js";
import { ExperimentManager } from "./experiment/manager.js";
import { createAgentTools } from "./agent/tools.js";
import { AgentSession } from "./agent/session.js";
import { experimentRoutes } from "./routes/experiments.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import path from "path";

const PORT = parseInt(process.env.PORT || "3000");
const DB_PATH = process.env.DB_PATH || "./data/lidar-agent.db";

const db = createDb(DB_PATH);
const mgr = new ExperimentManager(db);
const mcpServer = createAgentTools(mgr);

const { app } = expressWs(express());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/experiments", experimentRoutes(mgr));
app.use("/api/pipeline", pipelineRoutes(db));

app.ws("/chat", (ws, _req) => {
  const session = new AgentSession(mcpServer);

  ws.on("message", async (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "user_message") {
      for await (const event of session.chat(msg.content)) {
        ws.send(JSON.stringify(event));
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`lidar-agent listening on :${PORT}`);
});
```

- [ ] **Step 4: Create data directory for DB**

```bash
mkdir -p /home/mi/codes/workspace/lidar-agent/data
touch /home/mi/codes/workspace/lidar-agent/data/.gitkeep
```

- [ ] **Step 5: Verify server starts**

```bash
cd /home/mi/codes/workspace/lidar-agent
npx tsx src/index.ts &
sleep 2
curl http://localhost:3000/health
curl http://localhost:3000/api/experiments
kill %1
```

Expected: health OK, experiments returns `[]`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/ src/index.ts data/.gitkeep
git commit -m "feat: add REST routes (experiments, pipeline, proposals) and WebSocket chat"
```

---

## Phase 6: Pipeline Stages

### Task 10: Implement Core Pipeline Stages

**Files:**
- Create: `pipeline/stages/config_validate.py`, `pipeline/stages/volc_submit.py`, `pipeline/stages/volc_monitor.py`, `pipeline/stages/ssh_fetch.py`, `pipeline/stages/result_collect.py`, `pipeline/stages/db_store.py`
- Modify: `pipeline/executor.py` (register stages)

- [ ] **Step 1: config_validate stage**

`pipeline/stages/config_validate.py`:
```python
import os
from typing import Any

from stages.base import Stage


class ConfigValidateStage(Stage):
    def run(self) -> dict[str, Any]:
        config_path = self.inputs["config_path"]
        if not os.path.isfile(config_path):
            raise FileNotFoundError(f"Config not found: {config_path}")
        with open(config_path) as f:
            content = f.read()
        if "model" not in content:
            raise ValueError(f"Config {config_path} does not define a model")
        return {"config_path": config_path, "valid": True}
```

- [ ] **Step 2: volc_submit stage**

`pipeline/stages/volc_submit.py`:
```python
import json
import subprocess
from typing import Any

from stages.base import Stage


class VolcSubmitStage(Stage):
    def run(self) -> dict[str, Any]:
        yaml_path = self.inputs["yaml_path"]
        cmd = ["volc", "ml_task", "submit", "--conf", yaml_path, "--output-format", "json"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"volc submit failed: {result.stderr}")
        output = json.loads(result.stdout)
        task_id = output.get("Id") or output.get("TaskId") or output.get("id")
        if not task_id:
            raise RuntimeError(f"No task_id in submit output: {result.stdout}")
        return {"task_id": str(task_id)}
```

- [ ] **Step 3: volc_monitor stage**

`pipeline/stages/volc_monitor.py`:
```python
import json
import subprocess
import time
from typing import Any

from stages.base import Stage

TERMINAL_STATES = {"Success", "Failed", "Cancelled", "Exception", "Stopped"}


class VolcMonitorStage(Stage):
    def run(self) -> dict[str, Any]:
        task_id = self.inputs["task_id"]
        poll_interval = int(self.inputs.get("poll_interval", 300))

        while True:
            cmd = ["volc", "ml_task", "get", "--id", task_id, "--output-format", "json"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError(f"volc get failed: {result.stderr}")
            output = json.loads(result.stdout)
            state = output.get("State") or output.get("Status", "Unknown")

            if state in TERMINAL_STATES:
                if state != "Success":
                    raise RuntimeError(f"Job {task_id} ended with state: {state}")
                return {"task_id": task_id, "final_state": state}

            time.sleep(poll_interval)
```

- [ ] **Step 4: ssh_fetch stage**

`pipeline/stages/ssh_fetch.py`:
```python
import os
import subprocess
from typing import Any

from stages.base import Stage


class SSHFetchStage(Stage):
    def run(self) -> dict[str, Any]:
        remote_path = self.inputs["remote_path"]
        local_dir = self.inputs.get("local_dir", "/tmp/lidar-agent-fetch")
        os.makedirs(local_dir, exist_ok=True)

        ssh_host = os.environ.get("SSH_HOST", "root@localhost")
        ssh_port = os.environ.get("SSH_PORT", "3333")
        filename = os.path.basename(remote_path)
        local_path = os.path.join(local_dir, filename)

        cmd = ["scp", "-P", ssh_port, f"{ssh_host}:{remote_path}", local_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"SCP failed: {result.stderr}")
        return {"local_path": local_path}
```

- [ ] **Step 5: result_collect and db_store stages**

`pipeline/stages/result_collect.py`:
```python
import json
import os
from typing import Any

from stages.base import Stage


class ResultCollectStage(Stage):
    def run(self) -> dict[str, Any]:
        results = {}
        for key, path in self.inputs.items():
            if not key.endswith("_path"):
                continue
            task_name = key.replace("_result_path", "").replace("_path", "")
            if not os.path.isfile(path):
                results[task_name] = {"error": f"File not found: {path}"}
                continue
            with open(path) as f:
                results[task_name] = json.load(f)
        return {"results": results}
```

`pipeline/stages/db_store.py`:
```python
from typing import Any

from bridge_protocol import send_response
from stages.base import Stage


class DbStoreStage(Stage):
    def run(self) -> dict[str, Any]:
        experiment_id = self.inputs.get("experiment_id")
        send_response("store_results", {
            "experiment_id": experiment_id,
            "results": self.inputs.get("results", {}),
        })
        return {"stored": True}
```

- [ ] **Step 6: Register all stages in executor.py**

Add after the `STAGE_REGISTRY` definition in `pipeline/executor.py`:

```python
from stages.config_validate import ConfigValidateStage
from stages.volc_submit import VolcSubmitStage
from stages.volc_monitor import VolcMonitorStage
from stages.ssh_fetch import SSHFetchStage
from stages.result_collect import ResultCollectStage
from stages.db_store import DbStoreStage

register_stage("config_validate", ConfigValidateStage)
register_stage("volc_submit", VolcSubmitStage)
register_stage("volc_monitor", VolcMonitorStage)
register_stage("ssh_fetch", SSHFetchStage)
register_stage("result_collect", ResultCollectStage)
register_stage("db_store", DbStoreStage)
```

- [ ] **Step 7: Create DAG templates**

`pipeline/templates/train_eval.yaml` — copy from spec §7 (the full YAML shown in the spec).

`pipeline/templates/eval_only.yaml`:
```yaml
name: "eval_only_${experiment_id}"
stages:
  - id: validate_config
    type: config_validate
    inputs:
      config_path: "${config_path}"
    fail_fast: true

  - id: submit_eval
    type: volc_submit
    depends_on: [validate_config]
    inputs:
      yaml_path: "${eval_yaml}"

  - id: monitor_eval
    type: volc_monitor
    depends_on: [submit_eval]
    inputs:
      task_id: "${submit_eval.output.task_id}"
      poll_interval: 120

  - id: fetch_results
    type: result_collect
    depends_on: [monitor_eval]
    inputs:
      result_path: "${eval_work_dir}/results.json"

  - id: store_results
    type: db_store
    depends_on: [fetch_results]
    inputs:
      experiment_id: "${experiment_id}"
```

`pipeline/templates/data_update.yaml` — copy from spec §7 (the data_update YAML).

- [ ] **Step 8: Test imports**

```bash
cd /home/mi/codes/workspace/lidar-agent/pipeline
python -c "from executor import STAGE_REGISTRY; print(list(STAGE_REGISTRY.keys()))"
```

Expected: `['config_validate', 'volc_submit', 'volc_monitor', 'ssh_fetch', 'result_collect', 'db_store']`

- [ ] **Step 9: Commit**

```bash
git add pipeline/
git commit -m "feat: implement pipeline stages (config_validate, volc, ssh, results) and DAG templates"
```

---

## Phase 7: React UI Pages

### Task 11: Chat Page

**Files:**
- Create: `web/src/pages/Chat.tsx`
- Modify: `web/src/App.tsx` (wire in real page)

- [ ] **Step 1: Implement Chat.tsx**

```tsx
import { useState, useRef, useEffect } from "react";
import { createChatSocket } from "../api";

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = createChatSocket();
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "text") {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: last.content + msg.content }];
          }
          return [...prev, { role: "assistant", content: msg.content }];
        });
      } else if (msg.type === "tool_call") {
        setMessages((prev) => [...prev, { role: "tool", content: msg.content }]);
      }
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    if (!input.trim() || !wsRef.current) return;
    setMessages((prev) => [...prev, { role: "user", content: input }]);
    wsRef.current.send(JSON.stringify({ type: "user_message", content: input }));
    setInput("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)" }}>
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12, opacity: m.role === "tool" ? 0.6 : 1 }}>
            <strong>{m.role}:</strong>
            <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{m.content}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", padding: 12, borderTop: "1px solid #333" }}>
        <input
          style={{ flex: 1, padding: 8 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={connected ? "Ask about experiments..." : "Connecting..."}
          disabled={!connected}
        />
        <button onClick={send} disabled={!connected} style={{ marginLeft: 8, padding: "8px 16px" }}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to use real Chat page**

Replace the Chat placeholder route:
```tsx
import Chat from "./pages/Chat";
// in Routes:
<Route path="/" element={<Chat />} />
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Chat.tsx web/src/App.tsx
git commit -m "feat: add Chat page with WebSocket agent interaction"
```

---

### Task 12: Dashboard Page

**Files:**
- Create: `web/src/pages/Dashboard.tsx`, `web/src/components/MetricChart.tsx`

- [ ] **Step 1: Implement MetricChart**

`web/src/components/MetricChart.tsx`:
```tsx
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

interface Point {
  name: string;
  value: number;
}

export default function MetricChart({ data, label }: { data: Point[]; label: string }) {
  return (
    <div style={{ width: "100%", height: 250 }}>
      <h4>{label}</h4>
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="#8884d8" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Implement Dashboard.tsx**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJSON } from "../api";

interface Experiment {
  id: number;
  name: string;
  status: string;
  dataset_version: string;
  created_at: string;
}

export default function Dashboard() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);

  useEffect(() => {
    fetchJSON<Experiment[]>("/api/experiments").then(setExperiments).catch(console.error);
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2>Experiments</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>Dataset</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {experiments.map((e) => (
            <tr key={e.id} style={{ borderBottom: "1px solid #444" }}>
              <td>{e.id}</td>
              <td>
                <Link to={`/experiment/${e.id}`}>{e.name}</Link>
              </td>
              <td>{e.status}</td>
              <td>{e.dataset_version}</td>
              <td>{new Date(e.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
          {experiments.length === 0 && (
            <tr>
              <td colSpan={5} style={{ textAlign: "center", padding: 24, opacity: 0.5 }}>
                No experiments yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

```tsx
import Dashboard from "./pages/Dashboard";
// in Routes:
<Route path="/dashboard" element={<Dashboard />} />
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Dashboard.tsx web/src/components/MetricChart.tsx web/src/App.tsx
git commit -m "feat: add experiment dashboard and metric chart component"
```

---

### Task 13: Experiment Detail Page

**Files:**
- Create: `web/src/pages/Experiment.tsx`

- [ ] **Step 1: Implement Experiment.tsx**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchJSON } from "../api";
import MetricChart from "../components/MetricChart";

interface Experiment {
  id: number;
  name: string;
  status: string;
  config_path: string;
  dataset_version: string;
}

interface EvalResult {
  id: number;
  task_type: string;
  metric_name: string;
  metric_value: number;
  per_class_json: string | null;
}

export default function ExperimentDetail() {
  const { id } = useParams();
  const [exp, setExp] = useState<Experiment | null>(null);
  const [results, setResults] = useState<EvalResult[]>([]);

  useEffect(() => {
    if (!id) return;
    fetchJSON<Experiment>(`/api/experiments/${id}`).then(setExp).catch(console.error);
    fetchJSON<EvalResult[]>(`/api/experiments/${id}/results`).then(setResults).catch(console.error);
  }, [id]);

  if (!exp) return <div style={{ padding: 24 }}>Loading...</div>;

  const grouped = results.reduce(
    (acc, r) => {
      const key = r.task_type;
      if (!acc[key]) acc[key] = [];
      acc[key].push(r);
      return acc;
    },
    {} as Record<string, EvalResult[]>
  );

  return (
    <div style={{ padding: 24 }}>
      <h2>{exp.name}</h2>
      <p>Status: {exp.status} | Config: {exp.config_path} | Dataset: {exp.dataset_version}</p>

      {Object.entries(grouped).map(([task, metrics]) => (
        <div key={task} style={{ marginTop: 24 }}>
          <h3>{task}</h3>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr><th>Metric</th><th>Value</th></tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.id} style={{ borderBottom: "1px solid #444" }}>
                  <td>{m.metric_name}</td>
                  <td>{m.metric_value.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {results.length === 0 && <p style={{ opacity: 0.5 }}>No evaluation results yet.</p>}
    </div>
  );
}
```

- [ ] **Step 2: Wire into App.tsx**

```tsx
import ExperimentDetail from "./pages/Experiment";
// in Routes:
<Route path="/experiment/:id" element={<ExperimentDetail />} />
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Experiment.tsx web/src/App.tsx
git commit -m "feat: add experiment detail page with eval results display"
```

---

### Task 14: Pipeline DAG Viewer Page

**Files:**
- Create: `web/src/pages/Pipeline.tsx`, `web/src/components/DAGViewer.tsx`

- [ ] **Step 1: Implement DAGViewer component**

`web/src/components/DAGViewer.tsx`:
```tsx
interface StageInfo {
  stage_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#666",
  running: "#f0ad4e",
  completed: "#5cb85c",
  failed: "#d9534f",
};

export default function DAGViewer({ stages }: { stages: StageInfo[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      {stages.map((s) => (
        <div
          key={s.stage_id}
          style={{
            padding: "12px 16px",
            borderLeft: `4px solid ${STATUS_COLORS[s.status] || "#666"}`,
            background: "#1a1a1a",
            borderRadius: 4,
          }}
        >
          <strong>{s.stage_id}</strong>
          <span style={{ marginLeft: 12, color: STATUS_COLORS[s.status] }}>{s.status}</span>
          {s.started_at && <span style={{ marginLeft: 12, opacity: 0.5 }}>{s.started_at}</span>}
        </div>
      ))}
      {stages.length === 0 && <p style={{ opacity: 0.5 }}>No pipeline stages to display.</p>}
    </div>
  );
}
```

- [ ] **Step 2: Implement Pipeline.tsx**

```tsx
import { useEffect, useState } from "react";
import { fetchJSON } from "../api";
import DAGViewer from "../components/DAGViewer";

interface PipelineRun {
  id: number;
  dag_template: string;
  status: string;
  started_at: string | null;
}

interface PipelineStage {
  stage_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

export default function Pipeline() {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);

  useEffect(() => {
    fetchJSON<PipelineRun[]>("/api/pipeline/runs").then(setRuns).catch(console.error);
  }, []);

  useEffect(() => {
    if (selectedRun === null) return;
    fetchJSON<PipelineStage[]>(`/api/pipeline/runs/${selectedRun}/stages`).then(setStages).catch(console.error);
  }, [selectedRun]);

  return (
    <div style={{ padding: 24 }}>
      <h2>Pipeline Runs</h2>
      <div style={{ display: "flex", gap: 24 }}>
        <div style={{ width: 300 }}>
          {runs.map((r) => (
            <div
              key={r.id}
              onClick={() => setSelectedRun(r.id)}
              style={{
                padding: 12,
                cursor: "pointer",
                background: selectedRun === r.id ? "#333" : "transparent",
                borderBottom: "1px solid #444",
              }}
            >
              <strong>#{r.id}</strong> {r.dag_template} — {r.status}
            </div>
          ))}
          {runs.length === 0 && <p style={{ opacity: 0.5 }}>No pipeline runs yet.</p>}
        </div>
        <div style={{ flex: 1 }}>
          {selectedRun && <DAGViewer stages={stages} />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx and commit**

```bash
git add web/src/pages/Pipeline.tsx web/src/components/DAGViewer.tsx web/src/App.tsx
git commit -m "feat: add pipeline DAG viewer page"
```

---

## Phase 8: Feature Modules

### Task 15: Branch Merger

**Files:**
- Create: `src/branch/merger.ts`, `src/routes/branches.ts`, `web/src/pages/BranchMerge.tsx`, `web/src/components/DiffViewer.tsx`

- [ ] **Step 1: Implement merger.ts**

`src/branch/merger.ts`:
```typescript
import { execSync } from "child_process";

interface BranchInfo {
  name: string;
  lastCommit: string;
}

interface FileDiff {
  path: string;
  status: string;
  diff: string;
}

export class BranchMerger {
  constructor(private repoPath: string) {}

  listBranches(): BranchInfo[] {
    const output = execSync("git branch -a --format='%(refname:short)|%(objectname:short)'", {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, lastCommit] = line.split("|");
        return { name, lastCommit };
      });
  }

  getFileDiffs(source: string, target: string): FileDiff[] {
    const files = execSync(`git diff --name-status ${target}...${source}`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return files
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split("\t");
        const path = pathParts.join("\t");
        const diff = execSync(`git diff ${target}...${source} -- "${path}"`, {
          cwd: this.repoPath,
          encoding: "utf-8",
        });
        return { path, status, diff };
      });
  }

  applyFile(source: string, filePath: string): void {
    execSync(`git checkout ${source} -- "${filePath}"`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
  }
}
```

- [ ] **Step 2: Implement branch routes**

`src/routes/branches.ts`:
```typescript
import { Router } from "express";
import { BranchMerger } from "../branch/merger.js";

export function branchRoutes(merger: BranchMerger): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    try {
      const branches = merger.listBranches();
      res.json(branches);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/diff", (req, res) => {
    const { source, target } = req.query;
    if (!source || !target) return res.status(400).json({ error: "source and target required" });
    try {
      const diffs = merger.getFileDiffs(String(source), String(target));
      res.json(diffs);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/apply", (req, res) => {
    const { source, file_path } = req.body;
    if (!source || !file_path) return res.status(400).json({ error: "source and file_path required" });
    try {
      merger.applyFile(source, file_path);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
```

- [ ] **Step 3: Implement DiffViewer component**

`web/src/components/DiffViewer.tsx`:
```tsx
export default function DiffViewer({ diff, path }: { diff: string; path: string }) {
  const lines = diff.split("\n");
  return (
    <div style={{ fontFamily: "monospace", fontSize: 12 }}>
      <h4>{path}</h4>
      <pre style={{ background: "#111", padding: 12, overflow: "auto", maxHeight: 400 }}>
        {lines.map((line, i) => {
          let color = "#ccc";
          if (line.startsWith("+") && !line.startsWith("+++")) color = "#5cb85c";
          if (line.startsWith("-") && !line.startsWith("---")) color = "#d9534f";
          if (line.startsWith("@@")) color = "#5bc0de";
          return (
            <div key={i} style={{ color }}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Implement BranchMerge.tsx**

```tsx
import { useEffect, useState } from "react";
import { fetchJSON } from "../api";
import DiffViewer from "../components/DiffViewer";

interface Branch { name: string; lastCommit: string; }
interface FileDiff { path: string; status: string; diff: string; }

export default function BranchMerge() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [diffs, setDiffs] = useState<FileDiff[]>([]);

  useEffect(() => {
    fetchJSON<Branch[]>("/api/branches").then(setBranches).catch(console.error);
  }, []);

  async function loadDiff() {
    if (!source || !target) return;
    const d = await fetchJSON<FileDiff[]>(`/api/branches/diff?source=${source}&target=${target}`);
    setDiffs(d);
  }

  async function applyFile(path: string) {
    await fetchJSON("/api/branches/apply", {
      method: "POST",
      body: JSON.stringify({ source, file_path: path }),
    });
    setDiffs((prev) => prev.filter((d) => d.path !== path));
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Branch Merge</h2>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Source branch...</option>
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Target branch...</option>
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
        <button onClick={loadDiff}>Compare</button>
      </div>
      {diffs.map((d) => (
        <div key={d.path} style={{ marginBottom: 16 }}>
          <DiffViewer diff={d.diff} path={d.path} />
          <button onClick={() => applyFile(d.path)} style={{ marginTop: 4 }}>
            Apply this file
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Wire branch routes in index.ts and pages in App.tsx, commit**

```bash
git add src/branch/ src/routes/branches.ts web/src/pages/BranchMerge.tsx web/src/components/DiffViewer.tsx
git commit -m "feat: add branch merger (backend + per-file diff UI)"
```

---

### Task 16: Data Update Module

**Files:**
- Create: `src/data-update/scheduler.ts`, `src/routes/data-update.ts`, `web/src/pages/DataUpdate.tsx`
- Create: `pipeline/stages/run_scripts.py`, `pipeline/stages/data_validate.py`, `pipeline/stages/notify.py`

- [ ] **Step 1: Implement data processing pipeline stages**

`pipeline/stages/run_scripts.py`:
```python
import subprocess
from typing import Any

from stages.base import Stage


class RunScriptsStage(Stage):
    def run(self) -> dict[str, Any]:
        scripts = self.inputs.get("scripts", [])
        config = self.inputs.get("config", "")
        results = []
        for script in scripts:
            cmd = ["python3", script]
            if config:
                cmd.extend(["--config", config])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if result.returncode != 0:
                raise RuntimeError(f"Script {script} failed: {result.stderr}")
            results.append({"script": script, "stdout": result.stdout[-500:]})
        return {"script_results": results}
```

`pipeline/stages/data_validate.py`:
```python
import os
from typing import Any

from stages.base import Stage


class DataValidateStage(Stage):
    def run(self) -> dict[str, Any]:
        output_path = self.inputs["output_path"]
        if not os.path.isdir(output_path):
            raise FileNotFoundError(f"Output directory not found: {output_path}")
        files = os.listdir(output_path)
        pkl_files = [f for f in files if f.endswith(".pkl")]
        if not pkl_files:
            raise ValueError(f"No .pkl files found in {output_path}")
        return {"total_files": len(files), "pkl_files": len(pkl_files)}
```

`pipeline/stages/notify.py`:
```python
from typing import Any

from bridge_protocol import send_response
from stages.base import Stage


class NotifyStage(Stage):
    def run(self) -> dict[str, Any]:
        message = self.inputs.get("message", "Pipeline stage completed")
        send_response("notification", {"message": message})
        return {"notified": True}
```

- [ ] **Step 2: Register new stages in executor.py**

Add to the registration block:
```python
from stages.run_scripts import RunScriptsStage
from stages.data_validate import DataValidateStage
from stages.notify import NotifyStage

register_stage("run_scripts", RunScriptsStage)
register_stage("data_validate", DataValidateStage)
register_stage("notify", NotifyStage)
register_stage("check_data_source", ConfigValidateStage)  # reuse file-exists check
```

- [ ] **Step 3: Implement scheduler.ts**

`src/data-update/scheduler.ts`:
```typescript
import type { Db } from "../db.js";
import type { PipelineBridge } from "../pipeline/bridge.js";
import path from "path";

export class DataUpdateScheduler {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Db,
    private bridge: PipelineBridge,
    private pipelineDir: string,
  ) {}

  async triggerUpdate(rawDataPath: string, dataConfigYaml: string): Promise<number> {
    const result = this.db.raw
      .prepare("INSERT INTO data_updates (source_path, status) VALUES (?, 'running')")
      .run(rawDataPath);
    const updateId = Number(result.lastInsertRowid);

    const dagPath = path.join(this.pipelineDir, "templates/data_update.yaml");
    this.bridge
      .runPipeline(dagPath, { raw_data_path: rawDataPath, data_config_yaml: dataConfigYaml }, (msg) => {
        if (msg.type === "stage_completed" || msg.type === "stage_failed") {
          console.log(`[data-update #${updateId}] ${msg.type}: ${msg.stage_id}`);
        }
      })
      .then(() => {
        this.db.raw.prepare("UPDATE data_updates SET status = 'completed' WHERE id = ?").run(updateId);
      })
      .catch((err) => {
        this.db.raw.prepare("UPDATE data_updates SET status = 'failed' WHERE id = ?").run(updateId);
        console.error(`[data-update #${updateId}] failed:`, err);
      });

    return updateId;
  }

  getStatus(): object[] {
    return this.db.raw.prepare("SELECT * FROM data_updates ORDER BY id DESC LIMIT 20").all();
  }
}
```

- [ ] **Step 4: Implement data-update routes and page**

`src/routes/data-update.ts`:
```typescript
import { Router } from "express";
import type { DataUpdateScheduler } from "../data-update/scheduler.js";

export function dataUpdateRoutes(scheduler: DataUpdateScheduler): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(scheduler.getStatus());
  });

  router.post("/trigger", async (req, res) => {
    const { raw_data_path, data_config_yaml } = req.body;
    if (!raw_data_path) return res.status(400).json({ error: "raw_data_path required" });
    const id = await scheduler.triggerUpdate(raw_data_path, data_config_yaml);
    res.json({ update_id: id });
  });

  return router;
}
```

`web/src/pages/DataUpdate.tsx`:
```tsx
import { useEffect, useState } from "react";
import { fetchJSON } from "../api";

interface DataUpdate {
  id: number;
  source_path: string;
  status: string;
  dataset_version: string | null;
  total_frames: number | null;
  created_at: string;
}

export default function DataUpdatePage() {
  const [updates, setUpdates] = useState<DataUpdate[]>([]);
  const [rawPath, setRawPath] = useState("");

  useEffect(() => {
    fetchJSON<DataUpdate[]>("/api/data-update/status").then(setUpdates).catch(console.error);
  }, []);

  async function trigger() {
    if (!rawPath) return;
    await fetchJSON("/api/data-update/trigger", {
      method: "POST",
      body: JSON.stringify({ raw_data_path: rawPath }),
    });
    const updated = await fetchJSON<DataUpdate[]>("/api/data-update/status");
    setUpdates(updated);
    setRawPath("");
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Data Updates</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={rawPath}
          onChange={(e) => setRawPath(e.target.value)}
          placeholder="Raw data path..."
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={trigger} style={{ padding: "8px 16px" }}>Trigger Update</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th>ID</th><th>Source</th><th>Status</th><th>Frames</th><th>Created</th></tr>
        </thead>
        <tbody>
          {updates.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #444" }}>
              <td>{u.id}</td>
              <td>{u.source_path}</td>
              <td>{u.status}</td>
              <td>{u.total_frames ?? "—"}</td>
              <td>{new Date(u.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Wire everything and commit**

Wire in `src/index.ts`:
```typescript
import { BranchMerger } from "./branch/merger.js";
import { branchRoutes } from "./routes/branches.js";
import { DataUpdateScheduler } from "./data-update/scheduler.js";
import { dataUpdateRoutes } from "./routes/data-update.js";
import { PipelineBridge } from "./pipeline/bridge.js";

const bridge = new PipelineBridge(path.resolve("pipeline"));
const merger = new BranchMerger(process.env.MMDET3D_ROOT || "../mmdet3d");
const dataScheduler = new DataUpdateScheduler(db, bridge, path.resolve("pipeline"));

app.use("/api/branches", branchRoutes(merger));
app.use("/api/data-update", dataUpdateRoutes(dataScheduler));
```

Wire all real pages in `web/src/App.tsx`.

```bash
git add pipeline/stages/ src/data-update/ src/routes/data-update.ts web/src/pages/DataUpdate.tsx src/index.ts web/src/App.tsx
git commit -m "feat: add data update module (pipeline stages, scheduler, UI)"
```

---

### Task 17: Final Wiring and Integration Test

**Files:**
- Modify: `src/index.ts` (final version), `web/src/App.tsx` (final version)

- [ ] **Step 1: Ensure src/index.ts imports all routes and services**

Verify `src/index.ts` has all 5 route groups mounted:
- `/api/experiments` → experimentRoutes
- `/api/pipeline` → pipelineRoutes
- `/api/branches` → branchRoutes
- `/api/data-update` → dataUpdateRoutes
- `/chat` (WS) → agent session

- [ ] **Step 2: Ensure web/src/App.tsx has all 6 routes**

Verify all routes point to real page components (no placeholders remain):
- `/` → Chat
- `/dashboard` → Dashboard
- `/experiment/:id` → ExperimentDetail
- `/pipeline` → Pipeline
- `/branches` → BranchMerge
- `/data` → DataUpdate

- [ ] **Step 3: Run all tests**

```bash
cd /home/mi/codes/workspace/lidar-agent && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Smoke test end-to-end**

```bash
# Terminal 1: Start agent service
npx tsx src/index.ts

# Terminal 2: Start frontend
cd web && npm run dev

# Terminal 3: Test endpoints
curl http://localhost:3000/health
curl http://localhost:3000/api/experiments
curl http://localhost:3000/api/pipeline/runs
curl http://localhost:3000/api/pipeline/proposals
curl http://localhost:3000/api/branches
curl http://localhost:3000/api/data-update/status
```

Expected: All return valid JSON (empty arrays for fresh DB).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete lidar-agent MVP — agent service, pipeline executor, and React UI"
```

---

## Spec Coverage Verification

| Spec Section | Task(s) |
|-------------|---------|
| §2 Architecture (3 layers) | Tasks 1, 2, 3 |
| §3 Tech stack | Tasks 1–3 |
| §4 Project structure | All tasks follow spec layout |
| §5 Agent tools | Task 7 (5 of 10 tools; remaining 5 are thin wrappers over existing) |
| §6 Reasoning flow | Task 8 (agent session streams tool calls + text) |
| §7 YAML DAG pipeline | Tasks 6, 10 (executor + all stages + 3 templates) |
| §8 Database schema | Task 4 (all 7 tables) |
| §9 Constraints | Enforced in prompts.ts + propose_change gating |
| §10 Onboard benchmark | Placeholder in DB schema, not built (spec says TBD) |
| Module: Chat + Diagnosis | Tasks 7, 8, 11 |
| Module: Experiment Dashboard | Tasks 5, 12, 13 |
| Module: Branch Merger | Task 15 |
| Module: Data Update Pipeline | Task 16 |
| Module: Pipeline DAG View | Task 14 |

**Remaining agent tools** not yet implemented (thin wrappers to add in a follow-up):
- `list_branches` — calls `BranchMerger.listBranches()`
- `get_branch_diff` — calls `BranchMerger.getFileDiffs()`
- `get_data_status` — queries `data_updates` table
- `submit_pipeline` — calls `PipelineBridge.runPipeline()`
- `get_pipeline_status` — queries `pipeline_runs`/`pipeline_stages`

These are 5-line tool definitions each, following the same pattern as Task 7.
