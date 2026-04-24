# LiDAR Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hybrid LLM agent + deterministic pipeline system for LiDAR OD+FS+SceneFlow training & evaluation, with a web UI for experiment management, branch merging, and data updates.

**Architecture:** Three-layer system: React frontend, Node.js agent service (Claude Agent SDK with MCP-based custom tools), Python pipeline executor (YAML DAG runner). Agent reasons and proposes; user approves; pipeline executes deterministically.

**Tech Stack:** Node.js 24, TypeScript, Express, express-ws, better-sqlite3, @anthropic-ai/claude-agent-sdk, React 18, Vite, Python 3.12, PyYAML

---

## Phase 1: Foundation

### Task 1: Initialize Node.js Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Initialize package.json**

```bash
cd /home/mi/codes/workspace/lidar-agent
npm init -y
```

Then edit `package.json`:

```json
{
  "name": "lidar-agent",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install express express-ws better-sqlite3 @anthropic-ai/claude-agent-sdk zod dotenv pino pino-pretty
npm install -D typescript tsx @types/node @types/express @types/better-sqlite3 @types/express-ws
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
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

- [ ] **Step 4: Create .env.example and .gitignore**

`.env.example`:
```
ANTHROPIC_API_KEY=sk-...
DB_PATH=./data/lidar-agent.db
SSH_HOST=root@localhost
SSH_PORT=3333
MMDET3D_PATH=../mmdet3d
PORT=3000
```

`.gitignore`:
```
node_modules/
dist/
data/*.db
.env
web/node_modules/
web/dist/
pipeline/__pycache__/
```

- [ ] **Step 5: Create src/index.ts skeleton**

```ts
import "dotenv/config";
import express from "express";
import expressWs from "express-ws";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env.PORT || "3000");
const { app } = expressWs(express());

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  logger.info(`Agent service listening on :${PORT}`);
});
```

- [ ] **Step 6: Create src/utils/logger.ts**

```ts
import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});
```

- [ ] **Step 7: Verify it starts**

```bash
npm run dev
```
Expected: Server starts on :3000, `GET /health` returns `{"status":"ok"}`.

- [ ] **Step 8: Commit**

```bash
git init
git add -A
git commit -m "feat: initialize lidar-agent Node.js project"
```

---

### Task 2: SQLite Database Schema

**Files:**
- Create: `src/experiment/db.ts`
- Create: `src/experiment/types.ts`

- [ ] **Step 1: Create src/experiment/types.ts**

```ts
export interface Experiment {
  id: number;
  name: string;
  parent_id: number | null;
  config_path: string;
  dataset_version: string | null;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
}

export interface EvalResult {
  id: number;
  experiment_id: number;
  task_type: "OD" | "FS" | "FLOW";
  metric_name: string;
  metric_value: number;
  per_class_json: string;
}

export interface Proposal {
  id: number;
  experiment_id: number | null;
  change_type: "model" | "data";
  description: string;
  config_diff: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export interface PipelineRun {
  id: number;
  experiment_id: number | null;
  dag_template: string;
  params_json: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at: string | null;
  completed_at: string | null;
}

export interface PipelineStage {
  id: number;
  pipeline_run_id: number;
  stage_id: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  inputs_json: string;
  outputs_json: string | null;
  logs: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface BranchMerge {
  id: number;
  source_branch: string;
  target_branch: string;
  files_json: string;
  created_at: string;
}

export interface DataUpdate {
  id: number;
  source_path: string;
  dataset_version: string;
  total_frames: number | null;
  class_distribution_json: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  created_at: string;
}
```

- [ ] **Step 2: Create src/experiment/db.ts**

```ts
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH || "./data/lidar-agent.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES experiments(id),
      config_path TEXT NOT NULL,
      dataset_version TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS eval_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      task_type TEXT NOT NULL CHECK(task_type IN ('OD','FS','FLOW')),
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      per_class_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER REFERENCES experiments(id),
      change_type TEXT NOT NULL CHECK(change_type IN ('model','data')),
      description TEXT NOT NULL,
      config_diff TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER REFERENCES experiments(id),
      dag_template TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
      stage_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      inputs_json TEXT NOT NULL DEFAULT '{}',
      outputs_json TEXT,
      logs TEXT,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS branch_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_branch TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS data_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      dataset_version TEXT NOT NULL,
      total_frames INTEGER,
      class_distribution_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
```

- [ ] **Step 3: Verify DB initializes**

Add to `src/index.ts` before listen:
```ts
import { getDb } from "./experiment/db.js";
getDb();
logger.info("Database initialized");
```

```bash
npm run dev
```
Expected: "Database initialized" in logs, `data/lidar-agent.db` file created.

- [ ] **Step 4: Commit**

```bash
git add src/experiment/types.ts src/experiment/db.ts src/index.ts
git commit -m "feat: add SQLite schema with all 7 tables"
```

---

### Task 3: Experiment Manager (CRUD)

**Files:**
- Create: `src/experiment/manager.ts`

- [ ] **Step 1: Create src/experiment/manager.ts**

```ts
import { getDb } from "./db.js";
import type { Experiment, EvalResult, Proposal } from "./types.js";

export function listExperiments(opts?: {
  status?: string;
  tag?: string;
}): Experiment[] {
  const db = getDb();
  let sql = "SELECT * FROM experiments";
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (opts?.status) {
    conditions.push("status = :status");
    params.status = opts.status;
  }
  if (opts?.tag) {
    conditions.push("name LIKE :tag");
    params.tag = `%${opts.tag}%`;
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY created_at DESC";

  return db.prepare(sql).all(params) as Experiment[];
}

export function getExperiment(id: number): Experiment | undefined {
  return getDb().prepare("SELECT * FROM experiments WHERE id = ?").get(id) as
    | Experiment
    | undefined;
}

export function createExperiment(data: {
  name: string;
  config_path: string;
  parent_id?: number;
  dataset_version?: string;
}): Experiment {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO experiments (name, config_path, parent_id, dataset_version)
       VALUES (:name, :config_path, :parent_id, :dataset_version)`
    )
    .run({
      name: data.name,
      config_path: data.config_path,
      parent_id: data.parent_id ?? null,
      dataset_version: data.dataset_version ?? null,
    });
  return getExperiment(result.lastInsertRowid as number)!;
}

export function getEvalResults(
  experimentId: number,
  taskType?: "OD" | "FS" | "FLOW"
): EvalResult[] {
  const db = getDb();
  if (taskType) {
    return db
      .prepare(
        "SELECT * FROM eval_results WHERE experiment_id = ? AND task_type = ?"
      )
      .all(experimentId, taskType) as EvalResult[];
  }
  return db
    .prepare("SELECT * FROM eval_results WHERE experiment_id = ?")
    .all(experimentId) as EvalResult[];
}

export function insertEvalResult(data: {
  experiment_id: number;
  task_type: "OD" | "FS" | "FLOW";
  metric_name: string;
  metric_value: number;
  per_class_json: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO eval_results (experiment_id, task_type, metric_name, metric_value, per_class_json)
       VALUES (:experiment_id, :task_type, :metric_name, :metric_value, :per_class_json)`
    )
    .run(data);
}

export function compareExperiments(
  idA: number,
  idB: number
): {
  experiment_a: Experiment | undefined;
  experiment_b: Experiment | undefined;
  results_a: EvalResult[];
  results_b: EvalResult[];
} {
  return {
    experiment_a: getExperiment(idA),
    experiment_b: getExperiment(idB),
    results_a: getEvalResults(idA),
    results_b: getEvalResults(idB),
  };
}

export function createProposal(data: {
  experiment_id?: number;
  change_type: "model" | "data";
  description: string;
  config_diff: string;
}): Proposal {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO proposals (experiment_id, change_type, description, config_diff)
       VALUES (:experiment_id, :change_type, :description, :config_diff)`
    )
    .run({
      experiment_id: data.experiment_id ?? null,
      change_type: data.change_type,
      description: data.description,
      config_diff: data.config_diff,
    });
  return db
    .prepare("SELECT * FROM proposals WHERE id = ?")
    .get(result.lastInsertRowid) as Proposal;
}

export function updateProposalStatus(
  id: number,
  status: "approved" | "rejected"
): void {
  getDb().prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
}

export function listProposals(status?: string): Proposal[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC")
      .all(status) as Proposal[];
  }
  return db
    .prepare("SELECT * FROM proposals ORDER BY created_at DESC")
    .all() as Proposal[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/experiment/manager.ts
git commit -m "feat: add experiment manager with CRUD + compare + proposals"
```

---

## Phase 2: Python Pipeline Executor

### Task 4: DAG Executor Core

**Files:**
- Create: `pipeline/requirements.txt`
- Create: `pipeline/executor.py`
- Create: `pipeline/schemas/dag_schema.py`

- [ ] **Step 1: Create pipeline/requirements.txt**

```
pyyaml>=6.0
jsonschema>=4.0
```

- [ ] **Step 2: Create pipeline/schemas/dag_schema.py**

```python
import json
import sys

DAG_SCHEMA = {
    "type": "object",
    "required": ["name", "stages"],
    "properties": {
        "name": {"type": "string"},
        "stages": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "type"],
                "properties": {
                    "id": {"type": "string"},
                    "type": {"type": "string"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "inputs": {"type": "object"},
                    "fail_fast": {"type": "boolean"},
                },
            },
        },
    },
}


def validate_dag(dag: dict) -> list[str]:
    from jsonschema import validate, ValidationError

    errors = []
    try:
        validate(instance=dag, schema=DAG_SCHEMA)
    except ValidationError as e:
        errors.append(str(e.message))

    stage_ids = {s["id"] for s in dag.get("stages", [])}
    for stage in dag.get("stages", []):
        for dep in stage.get("depends_on", []):
            if dep not in stage_ids:
                errors.append(f"Stage '{stage['id']}' depends on unknown stage '{dep}'")

    return errors
```

- [ ] **Step 3: Create pipeline/executor.py**

```python
"""YAML DAG executor. Reads a DAG definition, resolves variables, runs stages in dependency order."""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import yaml

from schemas.dag_schema import validate_dag

STAGE_REGISTRY: dict[str, type] = {}


def register_stage(name: str):
    def decorator(cls):
        STAGE_REGISTRY[name] = cls
        return cls
    return decorator


class StageResult:
    def __init__(self, success: bool, output: dict | None = None, error: str | None = None):
        self.success = success
        self.output = output or {}
        self.error = error


class BaseStage:
    def __init__(self, stage_def: dict, context: dict):
        self.stage_def = stage_def
        self.context = context
        self.stage_id = stage_def["id"]

    def run(self) -> StageResult:
        raise NotImplementedError


def resolve_variables(value, context: dict):
    if isinstance(value, str):
        def replacer(match):
            var_path = match.group(1)
            parts = var_path.split(".")
            obj = context
            for part in parts:
                if isinstance(obj, dict):
                    obj = obj.get(part)
                else:
                    return match.group(0)
            return str(obj) if obj is not None else match.group(0)
        return re.sub(r"\$\{([^}]+)\}", replacer, value)
    if isinstance(value, dict):
        return {k: resolve_variables(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_variables(v, context) for v in value]
    return value


def topo_sort(stages: list[dict]) -> list[list[dict]]:
    """Return stages grouped into dependency layers for parallel execution."""
    id_to_stage = {s["id"]: s for s in stages}
    in_degree = {s["id"]: 0 for s in stages}
    dependents: dict[str, list[str]] = {s["id"]: [] for s in stages}

    for s in stages:
        for dep in s.get("depends_on", []):
            in_degree[s["id"]] += 1
            dependents[dep].append(s["id"])

    layers = []
    ready = [sid for sid, deg in in_degree.items() if deg == 0]

    while ready:
        layer = [id_to_stage[sid] for sid in ready]
        layers.append(layer)
        next_ready = []
        for sid in ready:
            for dep_id in dependents[sid]:
                in_degree[dep_id] -= 1
                if in_degree[dep_id] == 0:
                    next_ready.append(dep_id)
        ready = next_ready

    executed = sum(len(layer) for layer in layers)
    if executed != len(stages):
        raise ValueError("Cycle detected in DAG")

    return layers


def run_dag(dag_path: str, params: dict) -> dict:
    with open(dag_path) as f:
        dag = yaml.safe_load(f)

    errors = validate_dag(dag)
    if errors:
        return {"success": False, "error": f"DAG validation failed: {errors}"}

    dag = resolve_variables(dag, params)

    context = {**params}
    stage_results = {}
    layers = topo_sort(dag["stages"])

    for layer in layers:
        for stage_def in layer:
            sid = stage_def["id"]
            stype = stage_def["type"]

            resolved_def = resolve_variables(stage_def, context)

            stage_cls = STAGE_REGISTRY.get(stype)
            if not stage_cls:
                msg = f"Unknown stage type: {stype}"
                emit_event("stage_error", {"stage_id": sid, "error": msg})
                if stage_def.get("fail_fast", False):
                    return {"success": False, "error": msg, "results": stage_results}
                stage_results[sid] = {"success": False, "error": msg}
                continue

            emit_event("stage_start", {"stage_id": sid, "type": stype})
            stage = stage_cls(resolved_def, context)

            try:
                result = stage.run()
            except Exception as e:
                result = StageResult(success=False, error=str(e))

            stage_results[sid] = {"success": result.success, "output": result.output, "error": result.error}
            context[sid] = {"output": result.output}

            if result.success:
                emit_event("stage_complete", {"stage_id": sid})
            else:
                emit_event("stage_error", {"stage_id": sid, "error": result.error})
                if stage_def.get("fail_fast", False):
                    return {"success": False, "error": result.error, "results": stage_results}

    all_ok = all(r["success"] for r in stage_results.values())
    return {"success": all_ok, "results": stage_results}


def emit_event(event_type: str, data: dict):
    msg = json.dumps({"event": event_type, **data})
    print(msg, flush=True)


@register_stage("noop")
class NoopStage(BaseStage):
    def run(self) -> StageResult:
        return StageResult(success=True, output={"message": "noop"})


def main():
    parser = argparse.ArgumentParser(description="YAML DAG Executor")
    parser.add_argument("--dag", required=True, help="Path to DAG YAML file")
    parser.add_argument("--params", default="{}", help="JSON params string or path to JSON file")
    args = parser.parse_args()

    if Path(args.params).is_file():
        with open(args.params) as f:
            params = json.load(f)
    else:
        params = json.loads(args.params)

    result = run_dag(args.dag, params)
    emit_event("dag_complete", result)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Verify executor loads**

```bash
cd pipeline && python -c "from executor import run_dag; print('OK')"
```

- [ ] **Step 5: Commit**

```bash
git add pipeline/
git commit -m "feat: add Python DAG executor with topo sort and variable resolution"
```

---

### Task 5: Pipeline Stage Implementations

**Files:**
- Create: `pipeline/stages/__init__.py`
- Create: `pipeline/stages/config_gen.py`
- Create: `pipeline/stages/job_submit.py`
- Create: `pipeline/stages/job_monitor.py`
- Create: `pipeline/stages/result_fetch.py`
- Create: `pipeline/stages/branch_merge.py`
- Create: `pipeline/stages/data_process.py`

- [ ] **Step 1: Create pipeline/stages/__init__.py**

```python
from .config_gen import ConfigValidateStage
from .job_submit import VolcSubmitStage
from .job_monitor import VolcMonitorStage
from .result_fetch import ResultCollectStage, SshFetchStage
from .branch_merge import BranchDiffStage
from .data_process import RunScriptsStage, DataValidateStage, CheckDataSourceStage

__all__ = [
    "ConfigValidateStage",
    "VolcSubmitStage",
    "VolcMonitorStage",
    "ResultCollectStage",
    "SshFetchStage",
    "BranchDiffStage",
    "RunScriptsStage",
    "DataValidateStage",
    "CheckDataSourceStage",
]
```

- [ ] **Step 2: Create pipeline/stages/config_gen.py**

```python
import os
from executor import register_stage, BaseStage, StageResult


@register_stage("config_validate")
class ConfigValidateStage(BaseStage):
    def run(self) -> StageResult:
        config_path = self.stage_def.get("inputs", {}).get("config_path", "")
        if not config_path or not os.path.isfile(config_path):
            return StageResult(success=False, error=f"Config not found: {config_path}")
        return StageResult(success=True, output={"config_path": config_path})
```

- [ ] **Step 3: Create pipeline/stages/job_submit.py**

```python
import json
import subprocess
from executor import register_stage, BaseStage, StageResult


@register_stage("volc_submit")
class VolcSubmitStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        yaml_path = inputs.get("yaml_path", "")
        if not yaml_path:
            return StageResult(success=False, error="yaml_path is required")

        cmd = ["volc", "ml_task", "submit", "--conf", yaml_path]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                return StageResult(success=False, error=result.stderr.strip())
            task_id = self._parse_task_id(result.stdout)
            return StageResult(success=True, output={"task_id": task_id, "stdout": result.stdout})
        except subprocess.TimeoutExpired:
            return StageResult(success=False, error="volc submit timed out")
        except FileNotFoundError:
            return StageResult(success=False, error="volc CLI not found")

    def _parse_task_id(self, stdout: str) -> str:
        for line in stdout.splitlines():
            if "task" in line.lower() and "id" in line.lower():
                parts = line.split()
                for part in parts:
                    if part.startswith("task-"):
                        return part
        return "unknown"
```

- [ ] **Step 4: Create pipeline/stages/job_monitor.py**

```python
import json
import subprocess
import time
from executor import register_stage, BaseStage, StageResult, emit_event


@register_stage("volc_monitor")
class VolcMonitorStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        task_id = inputs.get("task_id", "")
        poll_interval = int(inputs.get("poll_interval", 300))

        if not task_id or task_id == "unknown":
            return StageResult(success=False, error="No valid task_id to monitor")

        while True:
            status = self._get_status(task_id)
            emit_event("monitor_poll", {"task_id": task_id, "status": status})

            if status in ("Success", "Stopped"):
                return StageResult(
                    success=(status == "Success"),
                    output={"task_id": task_id, "final_status": status},
                    error=None if status == "Success" else f"Task {status}",
                )
            if status in ("Failed", "Exception"):
                return StageResult(success=False, error=f"Task {task_id} {status}")

            time.sleep(poll_interval)

    def _get_status(self, task_id: str) -> str:
        try:
            result = subprocess.run(
                ["volc", "ml_task", "get", "--id", task_id, "--output", "json"],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                data = json.loads(result.stdout)
                return data.get("Status", "Unknown")
        except Exception:
            pass
        return "Unknown"
```

- [ ] **Step 5: Create pipeline/stages/result_fetch.py**

```python
import json
import subprocess
from executor import register_stage, BaseStage, StageResult


@register_stage("ssh_fetch")
class SshFetchStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        remote_path = inputs.get("remote_path", "")
        ssh_host = self.context.get("ssh_host", "root@localhost")
        ssh_port = self.context.get("ssh_port", "3333")

        if not remote_path:
            return StageResult(success=False, error="remote_path is required")

        cmd = ["ssh", "-p", ssh_port, ssh_host, f"ls -la {remote_path}"]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                return StageResult(success=False, error=f"File not found: {remote_path}")
            return StageResult(success=True, output={"remote_path": remote_path, "exists": True})
        except Exception as e:
            return StageResult(success=False, error=str(e))


@register_stage("result_collect")
class ResultCollectStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        ssh_host = self.context.get("ssh_host", "root@localhost")
        ssh_port = self.context.get("ssh_port", "3333")

        results = {}
        for key, remote_path in inputs.items():
            if not remote_path:
                continue
            cmd = ["ssh", "-p", ssh_port, ssh_host, f"cat {remote_path}"]
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                if result.returncode == 0:
                    try:
                        results[key] = json.loads(result.stdout)
                    except json.JSONDecodeError:
                        results[key] = result.stdout.strip()
                else:
                    results[key] = {"error": result.stderr.strip()}
            except Exception as e:
                results[key] = {"error": str(e)}

        return StageResult(success=True, output=results)
```

- [ ] **Step 6: Create pipeline/stages/branch_merge.py**

```python
import subprocess
from executor import register_stage, BaseStage, StageResult


@register_stage("branch_diff")
class BranchDiffStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        source = inputs.get("source_branch", "")
        target = inputs.get("target_branch", "HEAD")
        repo_path = inputs.get("repo_path", ".")

        if not source:
            return StageResult(success=False, error="source_branch is required")

        cmd = ["git", "-C", repo_path, "diff", "--name-status", f"{target}...{source}"]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                return StageResult(success=False, error=result.stderr.strip())

            files = []
            for line in result.stdout.strip().splitlines():
                parts = line.split("\t", 1)
                if len(parts) == 2:
                    files.append({"status": parts[0], "path": parts[1]})

            return StageResult(success=True, output={"files": files, "count": len(files)})
        except Exception as e:
            return StageResult(success=False, error=str(e))
```

- [ ] **Step 7: Create pipeline/stages/data_process.py**

```python
import os
import subprocess
from executor import register_stage, BaseStage, StageResult, emit_event


@register_stage("check_data_source")
class CheckDataSourceStage(BaseStage):
    def run(self) -> StageResult:
        source_path = self.stage_def.get("inputs", {}).get("source_path", "")
        if not source_path:
            return StageResult(success=False, error="source_path is required")
        if not os.path.isdir(source_path):
            return StageResult(success=False, error=f"Data source not found: {source_path}")
        return StageResult(success=True, output={"source_path": source_path})


@register_stage("run_scripts")
class RunScriptsStage(BaseStage):
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        scripts = inputs.get("scripts", [])
        config = inputs.get("config", "")

        for script in scripts:
            if not os.path.isfile(script):
                return StageResult(success=False, error=f"Script not found: {script}")

            cmd = ["python", script]
            if config:
                cmd.extend(["--config", config])

            emit_event("script_start", {"script": script})
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                if result.returncode != 0:
                    return StageResult(success=False, error=f"{script} failed: {result.stderr[:500]}")
                emit_event("script_complete", {"script": script})
            except subprocess.TimeoutExpired:
                return StageResult(success=False, error=f"{script} timed out (1h)")

        return StageResult(success=True, output={"scripts_run": len(scripts)})


@register_stage("data_validate")
class DataValidateStage(BaseStage):
    def run(self) -> StageResult:
        output_path = self.stage_def.get("inputs", {}).get("output_path", "")
        if not output_path or not os.path.isdir(output_path):
            return StageResult(success=False, error=f"Output path not found: {output_path}")
        file_count = sum(1 for _ in os.scandir(output_path) if _.is_file())
        return StageResult(success=True, output={"output_path": output_path, "file_count": file_count})


@register_stage("notify")
class NotifyStage(BaseStage):
    def run(self) -> StageResult:
        message = self.stage_def.get("inputs", {}).get("message", "")
        emit_event("notification", {"message": message})
        return StageResult(success=True, output={"message": message})


@register_stage("db_store")
class DbStoreStage(BaseStage):
    """Emits results as JSON for the Node bridge to persist."""
    def run(self) -> StageResult:
        inputs = self.stage_def.get("inputs", {})
        emit_event("store_results", inputs)
        return StageResult(success=True, output=inputs)
```

- [ ] **Step 8: Import stages in executor.py**

Add at the top of `executor.py` after existing imports:
```python
import stages  # registers all stage types
```

- [ ] **Step 9: Commit**

```bash
git add pipeline/stages/
git commit -m "feat: add pipeline stages — volc submit/monitor, SSH fetch, branch diff, data process"
```

---

### Task 6: YAML DAG Templates

**Files:**
- Create: `pipeline/templates/train_eval.yaml`
- Create: `pipeline/templates/eval_only.yaml`
- Create: `pipeline/templates/data_update.yaml`

- [ ] **Step 1: Create pipeline/templates/train_eval.yaml**

```yaml
name: "train_eval_${experiment_id}"
stages:
  - id: validate_config
    type: config_validate
    inputs:
      config_path: "${config_path}"
    fail_fast: true

  - id: submit_train
    type: volc_submit
    depends_on: [validate_config]
    inputs:
      yaml_path: "${job_yaml}"
      queue: "${queue_id}"
      priority: 6

  - id: monitor_train
    type: volc_monitor
    depends_on: [submit_train]
    inputs:
      task_id: "${submit_train.output.task_id}"
      poll_interval: 300

  - id: fetch_checkpoint
    type: ssh_fetch
    depends_on: [monitor_train]
    inputs:
      remote_path: "${work_dir}/latest.pth"

  - id: submit_eval_od
    type: volc_submit
    depends_on: [fetch_checkpoint]
    inputs:
      yaml_path: "${eval_od_yaml}"

  - id: submit_eval_fs
    type: volc_submit
    depends_on: [fetch_checkpoint]
    inputs:
      yaml_path: "${eval_fs_yaml}"

  - id: fetch_results
    type: result_collect
    depends_on: [submit_eval_od, submit_eval_fs]
    inputs:
      od_result_path: "${eval_od_work_dir}/results.json"
      fs_result_path: "${eval_fs_work_dir}/results.json"

  - id: store_results
    type: db_store
    depends_on: [fetch_results]
    inputs:
      experiment_id: "${experiment_id}"
```

- [ ] **Step 2: Create pipeline/templates/eval_only.yaml**

```yaml
name: "eval_only_${experiment_id}"
stages:
  - id: validate_config
    type: config_validate
    inputs:
      config_path: "${config_path}"
    fail_fast: true

  - id: submit_eval_od
    type: volc_submit
    depends_on: [validate_config]
    inputs:
      yaml_path: "${eval_od_yaml}"

  - id: submit_eval_fs
    type: volc_submit
    depends_on: [validate_config]
    inputs:
      yaml_path: "${eval_fs_yaml}"

  - id: monitor_eval_od
    type: volc_monitor
    depends_on: [submit_eval_od]
    inputs:
      task_id: "${submit_eval_od.output.task_id}"
      poll_interval: 300

  - id: monitor_eval_fs
    type: volc_monitor
    depends_on: [submit_eval_fs]
    inputs:
      task_id: "${submit_eval_fs.output.task_id}"
      poll_interval: 300

  - id: fetch_results
    type: result_collect
    depends_on: [monitor_eval_od, monitor_eval_fs]
    inputs:
      od_result_path: "${eval_od_work_dir}/results.json"
      fs_result_path: "${eval_fs_work_dir}/results.json"

  - id: store_results
    type: db_store
    depends_on: [fetch_results]
    inputs:
      experiment_id: "${experiment_id}"
```

- [ ] **Step 3: Create pipeline/templates/data_update.yaml**

```yaml
name: "data_update_${date}"
stages:
  - id: detect_new_data
    type: check_data_source
    inputs:
      source_path: "${raw_data_path}"

  - id: run_processing
    type: run_scripts
    depends_on: [detect_new_data]
    inputs:
      scripts: ${data_scripts}
      config: "${data_config_yaml}"

  - id: validate_output
    type: data_validate
    depends_on: [run_processing]
    inputs:
      output_path: "${processed_data_dir}"

  - id: notify_ready
    type: notify
    depends_on: [validate_output]
    inputs:
      message: "Dataset ${date} ready."
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/templates/
git commit -m "feat: add YAML DAG templates — train_eval, eval_only, data_update"
```

---

## Phase 3: Agent Service (Claude SDK + MCP Tools)

### Task 7: MCP Tool Definitions

**Files:**
- Create: `src/agent/tools.ts`

- [ ] **Step 1: Create src/agent/tools.ts**

```ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as manager from "../experiment/manager.js";
import { getDb } from "../experiment/db.js";

export const listExperimentsTool = tool(
  "list_experiments",
  "List recorded experiments with optional filters by status or name tag.",
  { status: z.string().optional(), tag: z.string().optional() },
  async (args) => ({
    content: [{ type: "text" as const, text: JSON.stringify(manager.listExperiments(args)) }],
  }),
  { annotations: { readOnlyHint: true } }
);

export const getEvalResultsTool = tool(
  "get_eval_results",
  "Get evaluation results for an experiment, optionally filtered by task type (OD, FS, FLOW).",
  {
    experiment_id: z.number(),
    task_type: z.enum(["OD", "FS", "FLOW"]).optional(),
  },
  async (args) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(manager.getEvalResults(args.experiment_id, args.task_type)),
      },
    ],
  }),
  { annotations: { readOnlyHint: true } }
);

export const compareExperimentsTool = tool(
  "compare_experiments",
  "Compare two experiments side-by-side: returns both configs and all eval metrics for each.",
  { exp_id_a: z.number(), exp_id_b: z.number() },
  async (args) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(manager.compareExperiments(args.exp_id_a, args.exp_id_b)),
      },
    ],
  }),
  { annotations: { readOnlyHint: true } }
);

export const readConfigTool = tool(
  "read_config",
  "Read and return the contents of an mmdet3d config file.",
  { config_path: z.string() },
  async (args) => {
    const fs = await import("fs");
    try {
      const content = fs.readFileSync(args.config_path, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    } catch {
      return { content: [{ type: "text" as const, text: `Error: file not found at ${args.config_path}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const proposeChangeTool = tool(
  "propose_change",
  "Propose a model or data change for user approval. Does NOT execute — creates a pending proposal.",
  {
    experiment_id: z.number().optional(),
    change_type: z.enum(["model", "data"]),
    description: z.string(),
    config_diff: z.string(),
  },
  async (args) => {
    const proposal = manager.createProposal(args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(proposal) }],
    };
  }
);

export const listBranchesTool = tool(
  "list_branches",
  "List git branches in the mmdet3d repo.",
  { remote: z.boolean().optional() },
  async (args) => {
    const { execSync } = await import("child_process");
    const mmdet3dPath = process.env.MMDET3D_PATH || "../mmdet3d";
    const flag = args.remote ? "-r" : "";
    try {
      const output = execSync(`git -C ${mmdet3dPath} branch ${flag} --sort=-committerdate`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return { content: [{ type: "text" as const, text: output.trim() }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getBranchDiffTool = tool(
  "get_branch_diff",
  "Get per-file diff between two branches in mmdet3d repo.",
  { source_branch: z.string(), target_branch: z.string().optional() },
  async (args) => {
    const { execSync } = await import("child_process");
    const mmdet3dPath = process.env.MMDET3D_PATH || "../mmdet3d";
    const target = args.target_branch || "HEAD";
    try {
      const output = execSync(
        `git -C ${mmdet3dPath} diff --name-status ${target}...${args.source_branch}`,
        { encoding: "utf-8", timeout: 10000 }
      );
      return { content: [{ type: "text" as const, text: output.trim() }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  },
  { annotations: { readOnlyHint: true } }
);

export const getDataStatusTool = tool(
  "get_data_status",
  "Get the latest dataset info and last update time.",
  {},
  async () => {
    const db = getDb();
    const latest = db
      .prepare("SELECT * FROM data_updates ORDER BY created_at DESC LIMIT 1")
      .get();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(latest || { message: "No data updates recorded" }) }],
    };
  },
  { annotations: { readOnlyHint: true } }
);

export const getPipelineStatusTool = tool(
  "get_pipeline_status",
  "Get status of a running or completed pipeline run.",
  { pipeline_id: z.number() },
  async (args) => {
    const db = getDb();
    const run = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(args.pipeline_id);
    const stages = db
      .prepare("SELECT * FROM pipeline_stages WHERE pipeline_run_id = ? ORDER BY id")
      .all(args.pipeline_id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ run, stages }) }],
    };
  },
  { annotations: { readOnlyHint: true } }
);

export const readOnlyTools = [
  listExperimentsTool,
  getEvalResultsTool,
  compareExperimentsTool,
  readConfigTool,
  listBranchesTool,
  getBranchDiffTool,
  getDataStatusTool,
  getPipelineStatusTool,
];

export const mutatingTools = [proposeChangeTool];

export const allTools = [...readOnlyTools, ...mutatingTools];
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/tools.ts
git commit -m "feat: add MCP tool definitions — 9 tools for experiment, branch, data, pipeline"
```

---

### Task 8: Agent Session & System Prompt

**Files:**
- Create: `src/agent/session.ts`
- Create: `src/agent/prompts.ts`

- [ ] **Step 1: Create src/agent/prompts.ts**

```ts
export const SYSTEM_PROMPT = `You are a LiDAR perception model training & evaluation agent. You help manage experiments for multi-task models that perform Object Detection (OD), Free Space segmentation (FS), and Scene Flow estimation.

## Your Role
- Diagnose performance issues by analyzing eval results and configs
- Propose concrete fixes (data sampling, augmentation, loss weights, config changes)
- Compare experiments and identify regressions per-class
- Help manage branch merges and data updates

## How You Work
1. When the user asks to compare experiments, use compare_experiments to get full metrics, then analyze per-class regressions
2. Diagnose root causes yourself (data vs model vs training). Present your diagnosis with proposed fixes.
3. Every proposed change goes through propose_change — you NEVER execute directly
4. Focus on data/config/training parameter tuning by default. Only suggest model architecture changes when the user explicitly asks.

## Classes
car, bus, truck, cyclist, pedestrian, barrier

## Key Metrics
- OD: mAP, NDS, per-class AP
- FS: IoU per class, mean IoU
- Scene Flow: EPE (End Point Error)

## Constraints
- NEVER read annotation files (pkl, raw data)
- NEVER execute changes without creating a proposal first
- Keep analysis concise — show the key numbers and your conclusion`;
```

- [ ] **Step 2: Create src/agent/session.ts**

```ts
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { readOnlyTools, mutatingTools, allTools } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { logger } from "../utils/logger.js";

const MCP_SERVER_NAME = "lidar";

function createMcpServer() {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: allTools,
  });
}

const readOnlyToolNames = readOnlyTools.map(
  (t) => `mcp__${MCP_SERVER_NAME}__${t.name}`
);

interface SessionMessage {
  type: string;
  content?: Array<{ type: string; text?: string }>;
  session_id?: string;
  [key: string]: unknown;
}

export interface AgentResponse {
  text: string;
  sessionId?: string;
}

export async function* runAgentStream(
  userMessage: string,
  sessionId?: string
): AsyncGenerator<SessionMessage> {
  const server = createMcpServer();

  const options: Record<string, unknown> = {
    model: "claude-sonnet-4-5",
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { [MCP_SERVER_NAME]: server },
    allowedTools: readOnlyToolNames,
    canUseTool: async (toolName: string, _input: unknown) => {
      if (readOnlyToolNames.includes(toolName)) return true;
      logger.info({ toolName }, "Mutating tool requested — needs approval");
      return true;
    },
    maxTurns: 15,
    includePartialMessages: true,
  };

  if (sessionId) {
    (options as any).resume = sessionId;
  }

  const stream = query({
    prompt: userMessage,
    options: options as any,
  });

  for await (const message of stream) {
    yield message as SessionMessage;
  }
}

export async function runAgent(
  userMessage: string,
  sessionId?: string
): Promise<AgentResponse> {
  let text = "";
  let capturedSessionId = sessionId;

  for await (const msg of runAgentStream(userMessage, sessionId)) {
    if (msg.session_id && !capturedSessionId) {
      capturedSessionId = msg.session_id;
    }
    if (msg.type === "assistant" && msg.content) {
      for (const block of msg.content as any[]) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }
    }
    if (msg.type === "result") {
      const result = msg as any;
      if (result.result) text = result.result;
    }
  }

  return { text, sessionId: capturedSessionId };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/
git commit -m "feat: add agent session with MCP server, system prompt, streaming support"
```

---

### Task 9: Node↔Python Bridge

**Files:**
- Create: `src/pipeline/bridge.ts`
- Create: `src/pipeline/status.ts`

- [ ] **Step 1: Create src/pipeline/bridge.ts**

```ts
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { logger } from "../utils/logger.js";

export interface PipelineEvent {
  event: string;
  [key: string]: unknown;
}

export type EventCallback = (event: PipelineEvent) => void;

const PIPELINE_DIR = path.resolve("pipeline");

export function runPipeline(
  dagTemplate: string,
  params: Record<string, unknown>,
  onEvent: EventCallback
): { process: ChildProcess; promise: Promise<PipelineEvent> } {
  const dagPath = path.join(PIPELINE_DIR, "templates", dagTemplate);
  const paramsJson = JSON.stringify(params);

  const child = spawn(
    "python",
    [path.join(PIPELINE_DIR, "executor.py"), "--dag", dagPath, "--params", paramsJson],
    { cwd: PIPELINE_DIR, stdio: ["ignore", "pipe", "pipe"] }
  );

  const promise = new Promise<PipelineEvent>((resolve, reject) => {
    let lastEvent: PipelineEvent = { event: "unknown" };
    let buffer = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: PipelineEvent = JSON.parse(line);
          lastEvent = event;
          onEvent(event);
        } catch {
          logger.warn({ line }, "Non-JSON output from pipeline");
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      logger.error({ stderr: chunk.toString() }, "Pipeline stderr");
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(lastEvent);
      } else {
        reject(new Error(`Pipeline exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });

  return { process: child, promise };
}
```

- [ ] **Step 2: Create src/pipeline/status.ts**

```ts
import type { PipelineEvent } from "./bridge.js";
import { getDb } from "../experiment/db.js";

const activePipelines = new Map<number, { events: PipelineEvent[] }>();

export function trackPipeline(runId: number): void {
  activePipelines.set(runId, { events: [] });
}

export function addEvent(runId: number, event: PipelineEvent): void {
  const pipeline = activePipelines.get(runId);
  if (pipeline) pipeline.events.push(event);

  const db = getDb();
  if (event.event === "stage_start") {
    db.prepare(
      `INSERT OR REPLACE INTO pipeline_stages (pipeline_run_id, stage_id, status, started_at)
       VALUES (?, ?, 'running', datetime('now'))`
    ).run(runId, event.stage_id);
  } else if (event.event === "stage_complete") {
    db.prepare(
      `UPDATE pipeline_stages SET status = 'completed', completed_at = datetime('now')
       WHERE pipeline_run_id = ? AND stage_id = ?`
    ).run(runId, event.stage_id);
  } else if (event.event === "stage_error") {
    db.prepare(
      `UPDATE pipeline_stages SET status = 'failed', logs = ?, completed_at = datetime('now')
       WHERE pipeline_run_id = ? AND stage_id = ?`
    ).run(runId, String(event.error), event.stage_id);
  } else if (event.event === "dag_complete") {
    const status = (event as any).success ? "completed" : "failed";
    db.prepare(
      `UPDATE pipeline_runs SET status = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(status, runId);
    activePipelines.delete(runId);
  }
}

export function getActiveEvents(runId: number): PipelineEvent[] {
  return activePipelines.get(runId)?.events || [];
}
```

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/
git commit -m "feat: add Node-Python bridge and pipeline status tracking"
```

---

### Task 10: REST & WebSocket Routes

**Files:**
- Create: `src/routes/chat.ts`
- Create: `src/routes/experiments.ts`
- Create: `src/routes/pipeline.ts`
- Create: `src/routes/branches.ts`
- Create: `src/routes/data-update.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create src/routes/chat.ts**

```ts
import { Router } from "express";
import expressWs from "express-ws";
import { runAgentStream } from "../agent/session.js";
import { logger } from "../utils/logger.js";

export function chatRoutes(wsApp: expressWs.Instance): Router {
  const router = Router();

  const sessions = new Map<string, string>();

  wsApp.app.ws("/ws/chat", (ws, req) => {
    const chatId = req.query.chatId as string || "default";
    logger.info({ chatId }, "Chat WebSocket connected");

    ws.on("message", async (raw: string) => {
      let msg: { text: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
        return;
      }

      const sessionId = sessions.get(chatId);

      try {
        for await (const event of runAgentStream(msg.text, sessionId)) {
          if (event.session_id && !sessions.has(chatId)) {
            sessions.set(chatId, event.session_id as string);
          }
          ws.send(JSON.stringify(event));
        }
      } catch (e: any) {
        logger.error({ error: e.message }, "Agent error");
        ws.send(JSON.stringify({ type: "error", text: e.message }));
      }
    });

    ws.on("close", () => {
      logger.info({ chatId }, "Chat WebSocket disconnected");
    });
  });

  return router;
}
```

- [ ] **Step 2: Create src/routes/experiments.ts**

```ts
import { Router } from "express";
import * as manager from "../experiment/manager.js";

export function experimentRoutes(): Router {
  const router = Router();

  router.get("/experiments", (req, res) => {
    const { status, tag } = req.query;
    res.json(manager.listExperiments({
      status: status as string,
      tag: tag as string,
    }));
  });

  router.get("/experiments/:id", (req, res) => {
    const exp = manager.getExperiment(parseInt(req.params.id));
    if (!exp) return res.status(404).json({ error: "Not found" });
    res.json(exp);
  });

  router.post("/experiments", (req, res) => {
    const exp = manager.createExperiment(req.body);
    res.status(201).json(exp);
  });

  router.get("/experiments/:id/results", (req, res) => {
    const taskType = req.query.task_type as "OD" | "FS" | "FLOW" | undefined;
    res.json(manager.getEvalResults(parseInt(req.params.id), taskType));
  });

  router.get("/experiments/compare/:idA/:idB", (req, res) => {
    res.json(manager.compareExperiments(
      parseInt(req.params.idA),
      parseInt(req.params.idB),
    ));
  });

  router.get("/proposals", (req, res) => {
    res.json(manager.listProposals(req.query.status as string));
  });

  router.post("/proposals/:id/approve", (req, res) => {
    manager.updateProposalStatus(parseInt(req.params.id), "approved");
    res.json({ status: "approved" });
  });

  router.post("/proposals/:id/reject", (req, res) => {
    manager.updateProposalStatus(parseInt(req.params.id), "rejected");
    res.json({ status: "rejected" });
  });

  return router;
}
```

- [ ] **Step 3: Create src/routes/pipeline.ts**

```ts
import { Router } from "express";
import { getDb } from "../experiment/db.js";
import { runPipeline } from "../pipeline/bridge.js";
import { trackPipeline, addEvent, getActiveEvents } from "../pipeline/status.js";

export function pipelineRoutes(): Router {
  const router = Router();

  router.post("/pipeline/run", (req, res) => {
    const { dag_template, params } = req.body;
    if (!dag_template) return res.status(400).json({ error: "dag_template required" });

    const db = getDb();
    const result = db.prepare(
      `INSERT INTO pipeline_runs (dag_template, params_json, status, started_at)
       VALUES (?, ?, 'running', datetime('now'))`
    ).run(dag_template, JSON.stringify(params || {}));

    const runId = result.lastInsertRowid as number;
    trackPipeline(runId);

    runPipeline(dag_template, params || {}, (event) => addEvent(runId, event));

    res.status(201).json({ pipeline_run_id: runId });
  });

  router.get("/pipeline/:id", (req, res) => {
    const db = getDb();
    const run = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(parseInt(req.params.id));
    const stages = db.prepare("SELECT * FROM pipeline_stages WHERE pipeline_run_id = ?").all(parseInt(req.params.id));
    res.json({ run, stages, live_events: getActiveEvents(parseInt(req.params.id)) });
  });

  router.get("/pipeline", (_req, res) => {
    const runs = getDb().prepare("SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 20").all();
    res.json(runs);
  });

  return router;
}
```

- [ ] **Step 4: Create src/routes/branches.ts**

```ts
import { Router } from "express";
import { execSync } from "child_process";
import { getDb } from "../experiment/db.js";

export function branchRoutes(): Router {
  const router = Router();
  const mmdet3d = process.env.MMDET3D_PATH || "../mmdet3d";

  router.get("/branches", (req, res) => {
    const remote = req.query.remote === "true";
    const flag = remote ? "-r" : "";
    try {
      const output = execSync(`git -C ${mmdet3d} branch ${flag} --sort=-committerdate`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      const branches = output.trim().split("\n").map((b) => b.trim().replace(/^\* /, ""));
      res.json(branches);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/branches/diff/:source", (req, res) => {
    const target = (req.query.target as string) || "HEAD";
    try {
      const output = execSync(
        `git -C ${mmdet3d} diff --name-status ${target}...${req.params.source}`,
        { encoding: "utf-8", timeout: 10000 }
      );
      const files = output.trim().split("\n").filter(Boolean).map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { status, path: pathParts.join("\t") };
      });
      res.json(files);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/branches/diff/:source/file", (req, res) => {
    const target = (req.query.target as string) || "HEAD";
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query param required" });
    try {
      const output = execSync(
        `git -C ${mmdet3d} diff ${target}...${req.params.source} -- ${filePath}`,
        { encoding: "utf-8", timeout: 10000 }
      );
      res.json({ diff: output });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/branches/merge-file", (req, res) => {
    const { source_branch, file_path } = req.body;
    if (!source_branch || !file_path) {
      return res.status(400).json({ error: "source_branch and file_path required" });
    }
    try {
      execSync(
        `git -C ${mmdet3d} checkout ${source_branch} -- ${file_path}`,
        { encoding: "utf-8", timeout: 10000 }
      );
      res.json({ merged: file_path });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
```

- [ ] **Step 5: Create src/routes/data-update.ts**

```ts
import { Router } from "express";
import { getDb } from "../experiment/db.js";
import { runPipeline } from "../pipeline/bridge.js";
import { trackPipeline, addEvent } from "../pipeline/status.js";

export function dataUpdateRoutes(): Router {
  const router = Router();

  router.get("/data-updates", (_req, res) => {
    const updates = getDb()
      .prepare("SELECT * FROM data_updates ORDER BY created_at DESC LIMIT 20")
      .all();
    res.json(updates);
  });

  router.post("/data-updates/trigger", (req, res) => {
    const { raw_data_path, data_scripts, data_config_yaml, processed_data_dir } = req.body;

    const db = getDb();
    const version = new Date().toISOString().slice(0, 10);

    const updateResult = db.prepare(
      `INSERT INTO data_updates (source_path, dataset_version, status)
       VALUES (?, ?, 'processing')`
    ).run(raw_data_path, version);
    const updateId = updateResult.lastInsertRowid as number;

    const pipelineResult = db.prepare(
      `INSERT INTO pipeline_runs (dag_template, params_json, status, started_at)
       VALUES ('data_update.yaml', ?, 'running', datetime('now'))`
    ).run(JSON.stringify(req.body));
    const runId = pipelineResult.lastInsertRowid as number;
    trackPipeline(runId);

    runPipeline("data_update.yaml", {
      raw_data_path,
      data_scripts,
      data_config_yaml,
      processed_data_dir,
      date: version,
    }, (event) => {
      addEvent(runId, event);
      if (event.event === "dag_complete") {
        const status = (event as any).success ? "ready" : "failed";
        db.prepare("UPDATE data_updates SET status = ? WHERE id = ?").run(status, updateId);
      }
    });

    res.status(201).json({ data_update_id: updateId, pipeline_run_id: runId });
  });

  return router;
}
```

- [ ] **Step 6: Wire all routes in src/index.ts**

```ts
import "dotenv/config";
import express from "express";
import expressWs from "express-ws";
import { getDb } from "./experiment/db.js";
import { chatRoutes } from "./routes/chat.js";
import { experimentRoutes } from "./routes/experiments.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { branchRoutes } from "./routes/branches.js";
import { dataUpdateRoutes } from "./routes/data-update.js";
import { logger } from "./utils/logger.js";

const PORT = parseInt(process.env.PORT || "3000");
const wsInstance = expressWs(express());
const app = wsInstance.app;

app.use(express.json());

getDb();
logger.info("Database initialized");

app.get("/health", (_req, res) => res.json({ status: "ok" }));

chatRoutes(wsInstance);
app.use("/api", experimentRoutes());
app.use("/api", pipelineRoutes());
app.use("/api", branchRoutes());
app.use("/api", dataUpdateRoutes());

app.listen(PORT, () => {
  logger.info(`Agent service listening on :${PORT}`);
});
```

- [ ] **Step 7: Verify server starts with all routes**

```bash
npm run dev
```
Expected: Server starts, no import errors. `GET /health` returns ok.

- [ ] **Step 8: Commit**

```bash
git add src/routes/ src/index.ts
git commit -m "feat: add REST + WebSocket routes — chat, experiments, pipeline, branches, data-update"
```

---

## Phase 4: React Frontend

### Task 11: Initialize React App

**Files:**
- Create: `web/` (Vite scaffold)

- [ ] **Step 1: Scaffold Vite React project**

```bash
cd /home/mi/codes/workspace/lidar-agent
npm create vite@latest web -- --template react-ts
cd web
npm install
npm install react-router-dom recharts @tanstack/react-query
```

- [ ] **Step 2: Set up proxy and entry in web/vite.config.ts**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
```

- [ ] **Step 3: Create web/src/App.tsx with routing**

```tsx
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Chat from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import BranchMerge from "./pages/BranchMerge";
import DataUpdate from "./pages/DataUpdate";
import Pipeline from "./pages/Pipeline";

const queryClient = new QueryClient();

function Nav() {
  const links = [
    { to: "/", label: "Dashboard" },
    { to: "/chat", label: "Chat" },
    { to: "/branches", label: "Branch Merge" },
    { to: "/data", label: "Data Update" },
    { to: "/pipeline", label: "Pipeline" },
  ];
  return (
    <nav style={{ display: "flex", gap: 16, padding: 16, borderBottom: "1px solid #ddd" }}>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} style={({ isActive }) => ({ fontWeight: isActive ? "bold" : "normal" })}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Nav />
        <main style={{ padding: 16 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/branches" element={<BranchMerge />} />
            <Route path="/data" element={<DataUpdate />} />
            <Route path="/pipeline" element={<Pipeline />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/mi/codes/workspace/lidar-agent
git add web/
git commit -m "feat: scaffold React frontend with routing and API proxy"
```

---

### Task 12: Frontend Pages — Chat

**Files:**
- Create: `web/src/pages/Chat.tsx`

- [ ] **Step 1: Create web/src/pages/Chat.tsx**

```tsx
import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  text: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws/chat?chatId=main`);
    wsRef.current = ws;

    let assistantBuffer = "";

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "assistant" && data.content) {
        for (const block of data.content) {
          if (block.type === "text" && block.text) {
            assistantBuffer += block.text;
            setMessages((prev) => {
              const copy = [...prev];
              if (copy.length > 0 && copy[copy.length - 1].role === "assistant") {
                copy[copy.length - 1] = { role: "assistant", text: assistantBuffer };
              } else {
                copy.push({ role: "assistant", text: assistantBuffer });
              }
              return copy;
            });
          }
        }
      }

      if (data.type === "result") {
        if (data.result) {
          assistantBuffer = data.result;
          setMessages((prev) => {
            const copy = [...prev];
            if (copy.length > 0 && copy[copy.length - 1].role === "assistant") {
              copy[copy.length - 1] = { role: "assistant", text: assistantBuffer };
            } else {
              copy.push({ role: "assistant", text: assistantBuffer });
            }
            return copy;
          });
        }
        assistantBuffer = "";
        setStreaming(false);
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    if (!input.trim() || !wsRef.current) return;
    setMessages((prev) => [...prev, { role: "user", text: input }]);
    wsRef.current.send(JSON.stringify({ text: input }));
    setInput("");
    setStreaming(true);
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <h2>Agent Chat</h2>
      <div style={{ minHeight: 400, border: "1px solid #ddd", padding: 16, marginBottom: 16, overflowY: "auto", maxHeight: 600 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <strong>{m.role === "user" ? "You" : "Agent"}:</strong>
            <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{m.text}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask the agent..."
          disabled={streaming}
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={send} disabled={streaming || !input.trim()}>
          {streaming ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/Chat.tsx
git commit -m "feat: add Chat page with WebSocket streaming"
```

---

### Task 13: Frontend Pages — Dashboard, BranchMerge, DataUpdate, Pipeline

**Files:**
- Create: `web/src/pages/Dashboard.tsx`
- Create: `web/src/pages/BranchMerge.tsx`
- Create: `web/src/pages/DataUpdate.tsx`
- Create: `web/src/pages/Pipeline.tsx`

- [ ] **Step 1: Create web/src/pages/Dashboard.tsx**

```tsx
import { useQuery } from "@tanstack/react-query";

export default function Dashboard() {
  const { data: experiments } = useQuery({
    queryKey: ["experiments"],
    queryFn: () => fetch("/api/experiments").then((r) => r.json()),
  });
  const { data: proposals } = useQuery({
    queryKey: ["proposals"],
    queryFn: () => fetch("/api/proposals").then((r) => r.json()),
  });

  return (
    <div>
      <h2>Experiment Dashboard</h2>

      <h3>Experiments ({experiments?.length || 0})</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Status</th><th>Config</th><th>Created</th>
          </tr>
        </thead>
        <tbody>
          {experiments?.map((e: any) => (
            <tr key={e.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{e.id}</td>
              <td>{e.name}</td>
              <td>{e.status}</td>
              <td style={{ fontSize: 12 }}>{e.config_path}</td>
              <td>{e.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Pending Proposals ({proposals?.filter((p: any) => p.status === "pending").length || 0})</h3>
      {proposals?.filter((p: any) => p.status === "pending").map((p: any) => (
        <div key={p.id} style={{ border: "1px solid #ffa", padding: 12, marginBottom: 8, background: "#fffbe6" }}>
          <strong>{p.change_type}</strong>: {p.description}
          <pre style={{ fontSize: 12 }}>{p.config_diff}</pre>
          <button onClick={() => fetch(`/api/proposals/${p.id}/approve`, { method: "POST" }).then(() => window.location.reload())}>
            Approve
          </button>
          <button onClick={() => fetch(`/api/proposals/${p.id}/reject`, { method: "POST" }).then(() => window.location.reload())} style={{ marginLeft: 8 }}>
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create web/src/pages/BranchMerge.tsx**

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

export default function BranchMerge() {
  const [source, setSource] = useState("");
  const { data: branches } = useQuery({
    queryKey: ["branches"],
    queryFn: () => fetch("/api/branches?remote=true").then((r) => r.json()),
  });
  const { data: files, refetch } = useQuery({
    queryKey: ["branchDiff", source],
    queryFn: () => fetch(`/api/branches/diff/${encodeURIComponent(source)}`).then((r) => r.json()),
    enabled: !!source,
  });

  async function mergeFile(filePath: string) {
    await fetch("/api/branches/merge-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_branch: source, file_path: filePath }),
    });
    refetch();
  }

  return (
    <div>
      <h2>Branch Merger</h2>
      <select value={source} onChange={(e) => setSource(e.target.value)} style={{ padding: 8, marginBottom: 16 }}>
        <option value="">Select source branch...</option>
        {branches?.map((b: string) => <option key={b} value={b}>{b}</option>)}
      </select>

      {files && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th>Status</th><th>File</th><th>Action</th></tr></thead>
          <tbody>
            {files.map((f: any, i: number) => (
              <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                <td>{f.status}</td>
                <td>{f.path}</td>
                <td>
                  <button onClick={() => mergeFile(f.path)}>Merge</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create web/src/pages/DataUpdate.tsx**

```tsx
import { useQuery } from "@tanstack/react-query";

export default function DataUpdate() {
  const { data: updates } = useQuery({
    queryKey: ["dataUpdates"],
    queryFn: () => fetch("/api/data-updates").then((r) => r.json()),
  });

  return (
    <div>
      <h2>Data Updates</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th>ID</th><th>Version</th><th>Source</th><th>Frames</th><th>Status</th><th>Created</th></tr>
        </thead>
        <tbody>
          {updates?.map((u: any) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{u.id}</td>
              <td>{u.dataset_version}</td>
              <td style={{ fontSize: 12 }}>{u.source_path}</td>
              <td>{u.total_frames ?? "—"}</td>
              <td>{u.status}</td>
              <td>{u.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create web/src/pages/Pipeline.tsx**

```tsx
import { useQuery } from "@tanstack/react-query";

export default function Pipeline() {
  const { data: runs } = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => fetch("/api/pipeline").then((r) => r.json()),
    refetchInterval: 5000,
  });

  return (
    <div>
      <h2>Pipeline Runs</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr><th>ID</th><th>Template</th><th>Status</th><th>Started</th><th>Completed</th></tr>
        </thead>
        <tbody>
          {runs?.map((r: any) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>{r.id}</td>
              <td>{r.dag_template}</td>
              <td>{r.status}</td>
              <td>{r.started_at}</td>
              <td>{r.completed_at ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/
git commit -m "feat: add Dashboard, BranchMerge, DataUpdate, Pipeline pages"
```

---

## Phase 5: Integration & Smoke Test

### Task 14: End-to-End Smoke Test

- [ ] **Step 1: Create .env from example**

```bash
cp .env.example .env
# Edit .env with real values
```

- [ ] **Step 2: Start all services**

Terminal 1: `npm run dev` (agent service on :3000)
Terminal 2: `cd web && npm run dev` (frontend on :5173)

- [ ] **Step 3: Verify endpoints**

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/experiments
curl http://localhost:3000/api/proposals
curl http://localhost:3000/api/pipeline
curl http://localhost:3000/api/branches
curl http://localhost:3000/api/data-updates
```

All should return JSON (empty arrays for most).

- [ ] **Step 4: Test chat via browser**

Open `http://localhost:5173/chat`, type "list all experiments", verify agent responds.

- [ ] **Step 5: Create a test experiment via API**

```bash
curl -X POST http://localhost:3000/api/experiments \
  -H "Content-Type: application/json" \
  -d '{"name":"test-baseline","config_path":"configs/test.py"}'
```

Verify it shows on Dashboard page.

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: lidar-agent v0.1 — agent service, pipeline executor, web UI"
```
