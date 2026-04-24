# Panel Rebuild + Chat Persistence Plan

## Context

The 4 side panels need richer content based on user requirements, and all chat messages need to persist in the DB with multi-session support. This is a panel-by-panel rebuild with new DB tables, backend endpoints, and frontend components.

## New DB Tables (add to `src/db.ts` SCHEMA)

```sql
-- Chat persistence with multi-session support
CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'New Chat',
  claude_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
  role TEXT NOT NULL,  -- 'user', 'assistant', 'tool'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Volc task tracking (live sync from Volc ML Platform)
CREATE TABLE IF NOT EXISTS volc_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volc_task_id TEXT NOT NULL UNIQUE,
  name TEXT,
  queue TEXT,
  status TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tool registry (remote scripts + DAG templates)
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,  -- 'dag_template' or 'data_script'
  description TEXT,
  input_desc TEXT,
  output_desc TEXT,
  remote_host TEXT,
  remote_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dataset registry (browsable datasets on remote)
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT,
  remote_path TEXT,
  total_frames INTEGER,
  class_distribution_json TEXT,
  train_frames INTEGER,
  val_frames INTEGER,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Implementation Order (panel by panel)

### Step 1: Chat Persistence + Sessions

**Backend:**
- `src/db.ts` — add `chat_sessions` + `chat_messages` tables
- `src/routes/chat.ts` (new) — REST endpoints:
  - `GET /api/chat/sessions` — list sessions
  - `POST /api/chat/sessions` — create session
  - `GET /api/chat/sessions/:id/messages` — get messages for session
  - `DELETE /api/chat/sessions/:id` — delete session
- `src/index.ts` — update WebSocket handler to:
  - Accept `session_id` in messages
  - Save user messages + assistant responses + tool calls to `chat_messages`
  - Mount chat REST routes

**Frontend:**
- `web/src/pages/Chat.tsx` — add:
  - Session list dropdown/sidebar in the header
  - Create new session button
  - Load messages from DB on session select
  - Save outgoing messages are stored server-side (no change needed — backend saves them)

### Step 2: Experiments Panel (top-left)

**Backend:**
- `src/db.ts` — add `volc_tasks` table
- `src/routes/experiments.ts` — add endpoints:
  - `GET /api/volc-tasks` — list tasks from DB with filters (queue, status, time)
  - `POST /api/volc-tasks/sync` — call `volc ml_task list`, upsert into `volc_tasks`
  - `GET /api/experiments/tree-image` — serve `data/experiment_tree.png` as static file
  - `GET /api/experiments/:a/compare/:b` — already exists

**Frontend:**
- `web/src/pages/Dashboard.tsx` — rebuild with 2 tabs:
  - **Tasks tab**: table with columns (Volc ID, Name, Queue, Status, Time), filter dropdowns, refresh button that calls sync endpoint
  - **Graph tab**: renders experiment_tree.png image, click-to-select nodes (overlay clickable areas), select 2 → Compare button → floating modal with metric diff table

### Step 3: Pipeline Panel (bottom-left)

**Backend:**
- `src/db.ts` — add `tools` table
- `src/routes/tools.ts` (new) — CRUD endpoints:
  - `GET /api/tools` — list all tools
  - `GET /api/tools/:id` — get tool details
  - (create/update via chat agent only)
- `src/routes/data-update.ts` — add:
  - `GET /api/data-stats` — SSH to remote, count frames/classes, return stats
- Agent tool: add `register_tool` to `src/agent/tools.ts`

**Frontend:**
- `web/src/pages/Pipeline.tsx` — rebuild with 2 sections:
  - **Tools section**: list of registered tools with type badge, click to expand (shows description, input/output, remote path). Read-only.
  - **Data Stats section**: current dataset summary (frames, per-class, train/val), refresh button that triggers SSH query, processing history from `data_updates`

### Step 4: Branches Panel (top-right)

**Backend:** — existing endpoints are sufficient, just need to return file tree structure

- `src/routes/branches.ts` — modify `GET /api/branches/diff` to also return a grouped file tree structure

**Frontend:**
- `web/src/pages/BranchMerge.tsx` — rebuild:
  - Source/target branch selects (keep)
  - **Left side**: file tree showing changed files grouped by directory
  - **Right side**: click a file → show diff
  - Apply button per file (keep)

### Step 5: Data Panel (bottom-right)

**Backend:**
- `src/db.ts` — add `datasets` table
- `src/routes/datasets.ts` (new) — endpoints:
  - `GET /api/datasets` — list all datasets
  - `POST /api/datasets/scan` — SSH to remote, discover datasets, upsert into DB
  - `GET /api/datasets/:id` — get details (version, frames, class distribution)

**Frontend:**
- `web/src/pages/DataUpdate.tsx` → rename to `DataBrowser.tsx` — rebuild:
  - Dataset list with version, frame count, class distribution chart
  - Refresh/scan button to discover new datasets from remote
  - Click a dataset to see details (per-class counts, train/val split)

## Files Modified/Created Summary

| File | Action |
|------|--------|
| `src/db.ts` | Add 5 new tables |
| `src/routes/chat.ts` | New — session CRUD + message list |
| `src/routes/tools.ts` | New — tool registry endpoints |
| `src/routes/datasets.ts` | New — dataset browser endpoints |
| `src/routes/experiments.ts` | Add volc-tasks + tree-image endpoints |
| `src/routes/branches.ts` | Minor — add file tree grouping |
| `src/routes/data-update.ts` | Add SSH data stats endpoint |
| `src/agent/tools.ts` | Add `register_tool` tool |
| `src/index.ts` | Mount new routes, update WS handler |
| `web/src/pages/Chat.tsx` | Session support, load from DB |
| `web/src/pages/Dashboard.tsx` | Full rebuild — Tasks tab + Graph tab |
| `web/src/pages/Pipeline.tsx` | Full rebuild — Tools + Data Stats |
| `web/src/pages/BranchMerge.tsx` | Rebuild — file tree + diff viewer |
| `web/src/pages/DataUpdate.tsx` | Rename to DataBrowser, full rebuild |

## Verification

After each step:
1. `cd web && npx tsc --noEmit` — frontend compiles
2. `npx vitest run` — backend tests pass
3. Start both servers, verify panel renders with real data
4. Test chat persistence: send message, refresh page, messages should still be there
