# LiDAR OD+FS+FLOW Training & Evaluation Agent — Design Spec

**Date**: 2026-04-21
**Status**: Approved
**Location**: `/home/mi/codes/workspace/lidar-agent-unclassified/`

---

## 1. Overview

A hybrid LLM agent + deterministic pipeline system for managing LiDAR multi-task model training and evaluation. The agent handles three perception tasks: Object Detection (3D bbox), Free Space (drivable area segmentation), and Scene Flow (point-level motion estimation).

**Core principle**: The LLM (Claude Agent SDK) reasons and diagnoses. The deterministic YAML DAG pipeline executes. Every change requires user confirmation.

## 2. Architecture

### Three Layers

1. **React UI** — dashboard, chat, experiment tree, metric charts, branch merger, data update status
2. **Agent Service (Node.js/TypeScript)** — Claude Agent SDK for reasoning, experiment state in SQLite, WebSocket for chat
3. **Pipeline Executor (Python)** — deterministic YAML DAG runner, interfaces with mmdet3d, Volc ML Platform, remote machines via SSH

### Five Top-Level Modules

| Module | Purpose | Approval Model |
|--------|---------|----------------|
| **Chat + Diagnosis** | LLM reasons about performance, proposes changes | Every change confirmed by user |
| **Experiment Dashboard** | View experiments, metrics, comparisons, trends | Read-only |
| **Branch Merger** | List diffs from other mmdet3d branches, merge file-by-file | Each file approved individually |
| **Data Update Pipeline** | New dataset arrives → run scripts → produce trainable data → trigger retrain | User confirms trigger |
| **Onboard Benchmark** | Placeholder for future on-device eval | TBD |

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (React UI)                        │
│ ┌────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│ │  Chat  │ │Experiment │ │ Pipeline │ │  Branch  │ │  Data    │ │
│ │        │ │ Dashboard │ │ DAG View │ │  Merger  │ │  Update  │ │
│ └───┬────┘ └─────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
└─────┼────────────┼────────────┼────────────┼────────────┼────────┘
      │ WS         │ REST       │ REST       │ REST       │ REST
┌─────┴────────────┴────────────┴────────────┴────────────┴────────┐
│                    Agent Service (Node.js)                        │
│                                                                  │
│  ┌───────────────┐ ┌──────────────┐ ┌───────────┐ ┌───────────┐ │
│  │ Claude Agent  │ │  Experiment  │ │  Branch   │ │  Data     │ │
│  │ SDK Session   │ │  Manager     │ │  Merge    │ │  Update   │ │
│  │               │ │              │ │  Manager  │ │  Scheduler│ │
│  │ Reasoning +   │ │ SQLite DB    │ │           │ │           │ │
│  │ Diagnosis     │ │              │ │ Git diff  │ │ Cron /    │ │
│  │               │ │              │ │ per-file  │ │ manual    │ │
│  └───────┬───────┘ └──────┬───────┘ └─────┬─────┘ └─────┬─────┘ │
└──────────┼───────────────┼───────────────┼───────────────┼───────┘
           │               │               │               │
           ▼               ▼               ▼               ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Pipeline Executor (Python)                      │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ Training &      │  │ Branch Merge    │  │ Data Processing │  │
│  │ Eval DAG Runner │  │ Executor        │  │ Pipeline        │  │
│  │                 │  │                 │  │                 │  │
│  │ config gen →    │  │ git diff →      │  │ raw data →      │  │
│  │ submit job →    │  │ show per-file → │  │ your scripts →  │  │
│  │ monitor →       │  │ user approve →  │  │ trainable pkl → │  │
│  │ fetch results   │  │ apply patch     │  │ trigger retrain │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                  │
│  Interfaces: mmdet3d | Volc ML | Remote SSH | Git                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Onboard Benchmark (placeholder)                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Node↔Python Bridge

The Agent Service communicates with the Pipeline Executor by spawning Python as a subprocess. Communication is JSON over stdin/stdout. No extra infrastructure needed.

## 3. Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite + TypeScript |
| Agent Service | Node.js + Express/Fastify + WebSocket |
| LLM | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| Database | SQLite (single file, no server) |
| Pipeline Executor | Python 3.x |
| Job Platform | Volc ML Platform (via CLI) |
| Remote Access | SSH |
| Version Control | Git (for branch merge operations) |

## 4. Project Structure

```
/home/mi/codes/workspace/lidar-agent-unclassified/
├── package.json
├── tsconfig.json
├── .env                         # API keys, DB path, remote SSH config
│
├── src/                         # Agent Service (TypeScript)
│   ├── index.ts                 # Entry point (Express/Fastify)
│   ├── agent/
│   │   ├── session.ts           # Claude Agent SDK session management
│   │   ├── tools.ts             # Custom tools the agent can call
│   │   └── prompts.ts           # System prompts with domain knowledge
│   ├── experiment/
│   │   ├── manager.ts           # Experiment CRUD, state tracking
│   │   ├── db.ts                # SQLite schema & queries
│   │   └── comparator.ts        # Cross-experiment metric comparison
│   ├── branch/
│   │   ├── merger.ts            # Git diff, per-file merge logic
│   │   └── routes.ts            # Branch merge API endpoints
│   ├── data-update/
│   │   ├── scheduler.ts         # Cron / manual trigger
│   │   └── routes.ts            # Data update API endpoints
│   ├── pipeline/
│   │   ├── bridge.ts            # Node↔Python pipeline communication
│   │   └── status.ts            # Pipeline execution status tracking
│   └── routes/
│       ├── chat.ts              # WebSocket chat endpoints
│       ├── experiments.ts       # REST experiment endpoints
│       └── pipeline.ts          # REST pipeline endpoints
│
├── pipeline/                    # Pipeline Executor (Python)
│   ├── requirements.txt
│   ├── executor.py              # YAML DAG runner
│   ├── stages/
│   │   ├── config_gen.py        # Generate mmdet3d configs
│   │   ├── job_submit.py        # Submit to Volc ML Platform
│   │   ├── job_monitor.py       # Poll job status
│   │   ├── result_fetch.py      # SSH fetch eval results
│   │   ├── branch_merge.py      # Git operations for merge
│   │   └── data_process.py      # Run data processing scripts
│   ├── templates/               # YAML DAG templates
│   │   ├── train_eval.yaml      # Standard train→eval flow
│   │   ├── eval_only.yaml       # Eval existing checkpoint
│   │   └── data_update.yaml     # Data processing→retrain flow
│   └── schemas/
│       └── dag_schema.py        # YAML validation schemas
│
├── web/                         # React Frontend
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── pages/
│       │   ├── Chat.tsx         # Chat with agent
│       │   ├── Dashboard.tsx    # Experiment overview
│       │   ├── Experiment.tsx   # Single experiment detail
│       │   ├── BranchMerge.tsx  # File-by-file merge UI
│       │   ├── DataUpdate.tsx   # Data pipeline status
│       │   └── Pipeline.tsx     # DAG execution view
│       └── components/
│           ├── MetricChart.tsx   # Line/bar charts for metrics
│           ├── DiffViewer.tsx    # Side-by-side diff for branch merge
│           ├── ExperimentTree.tsx# Experiment lineage tree
│           └── DAGViewer.tsx     # Pipeline stage visualization
│
└── docs/
    └── superpowers/specs/
        └── 2026-04-21-lidar-agent-unclassified-design.md  # This file
```

## 5. Agent Tools

Tools available to the Claude Agent SDK session during chat reasoning:

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `list_experiments` | filters (date, task type, status) | experiment list with metrics | Browse experiment history |
| `get_eval_results` | experiment_id, task (OD/FS/FLOW) | per-class metrics, overall scores | Read evaluation results |
| `compare_experiments` | exp_id_a, exp_id_b | diff table (metric deltas per class) | Side-by-side comparison |
| `read_config` | config file path | parsed config content | Inspect model/data/training config |
| `propose_change` | change_type (model/data), description, config_diff | proposal object (pending approval) | Propose a modification for user review |
| `list_branches` | remote (optional) | branch list with last commit info | Show available mmdet3d branches |
| `get_branch_diff` | source_branch, target_branch | per-file diff list | Preview what a branch merge would change |
| `get_data_status` | — | latest dataset info, last update time | Check current dataset state |
| `submit_pipeline` | dag_yaml, params | pipeline_id | Submit approved plan to executor |
| `get_pipeline_status` | pipeline_id | stage statuses, logs | Monitor running pipeline |

## 6. Reasoning Flow

The agent diagnoses issues autonomously, then presents its conclusion with a proposed fix for user confirmation. No unnecessary back-and-forth.

### Example: Performance Diagnosis

```
User: "compare experiment A and experiment B"

Agent:
  1. calls compare_experiments(A, B) → gets full metric diff table
  2. finds: barrier FS IoU dropped 0.82→0.75, truck mAP dropped 0.61→0.58, rest stable
  3. calls read_config(A) + read_config(B) to identify what changed between them
  4. calls get_data_status() to check dataset version differences
  5. diagnoses root cause for each regression:
     - "barrier FS IoU drop: data issue — dataset B has 30% fewer barrier scenes"
     - "truck mAP drop: augmentation — GT-paste was disabled in config B"
  6. proposes fixes:
     - "increase barrier sampling weight 1.0→3.0"
     - "re-enable truck GT-paste with count=5"

→ UI shows: comparison table + diagnosis summary + proposal cards
→ User confirms or rejects each proposal independently
→ Confirmed proposals → Pipeline executes
```

### Key Constraint

The agent NEVER executes changes directly. `propose_change` creates a pending proposal visible in the UI. Only after explicit user approval does it become a `submit_pipeline` call.

## 7. YAML DAG Pipeline

### Train + Eval Template (`train_eval.yaml`)

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

### Data Update Template (`data_update.yaml`)

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
      scripts:
        - "${data_scripts_dir}/raw_anno_to_pkl.py"
        - "${data_scripts_dir}/raw_anno_split_train_and_val_bin.py"
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
      message: "Dataset ${date} ready. ${stats.total_frames} frames."
```

### DAG Executor Guarantees

- Stages run only after all `depends_on` are complete
- `fail_fast: true` stops the whole pipeline on failure
- Parallel stages (e.g. `submit_eval_od` + `submit_eval_fs`) run concurrently
- Every stage logs inputs/outputs to DB for traceability

## 8. Database Schema (SQLite)

### Tables

**experiments**
- id, name, parent_id (for lineage), config_path, dataset_version, status, created_at

**eval_results**
- id, experiment_id, task_type (OD/FS/FLOW), metric_name, metric_value, per_class_json

**proposals**
- id, experiment_id, change_type (model/data), description, config_diff, status (pending/approved/rejected), created_at

**pipeline_runs**
- id, experiment_id, dag_template, params_json, status, started_at, completed_at

**pipeline_stages**
- id, pipeline_run_id, stage_id, status, inputs_json, outputs_json, logs, started_at, completed_at

**branch_merges**
- id, source_branch, target_branch, files_json (per-file status: approved/skipped), created_at

**data_updates**
- id, source_path, dataset_version, total_frames, class_distribution_json, status, created_at

## 9. Constraints

- **NEVER read annotation files** (pkl, raw annotations) — they are too large for context
- **NEVER execute changes without user confirmation** — every proposal requires explicit approval
- **New model structures/methods only when user explicitly requests them** — agent focuses on data/config/training parameter tuning by default
- **Deterministic pipeline** — the DAG runner must never skip steps; the LLM fills parameters, the executor runs the fixed structure
- **Evaluation sources**: (1) offline eval via Volc job submission, results fetched from remote; (2) onboard benchmark — placeholder for now

## 10. Onboard Benchmark (Placeholder)

Reserved for future implementation. Will handle on-device evaluation metrics. The database schema and UI will include placeholder sections ready to be filled in when the onboard benchmark pipeline is defined.
