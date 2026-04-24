import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New Chat',
    claude_session_id TEXT,
    codex_thread_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS volc_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    volc_task_id TEXT NOT NULL UNIQUE,
    name TEXT,
    queue TEXT,
    queue_label TEXT,
    status TEXT NOT NULL,
    workers INTEGER DEFAULT 0,
    creator TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    description TEXT,
    input_desc TEXT,
    output_desc TEXT,
    remote_host TEXT,
    remote_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS trt_builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    name TEXT,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    engine_path TEXT,
    stdout TEXT DEFAULT '',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
`;

function seedTools(raw: Database.Database): void {
  const count = (raw.prepare("SELECT COUNT(*) as c FROM tools").get() as any).c;
  if (count > 0) return;
  const seedPath = path.resolve("data/tools-seed.json");
  if (!fs.existsSync(seedPath)) return;
  const tools = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
  const insert = raw.prepare(`
    INSERT OR IGNORE INTO tools (name, type, description, input_desc, output_desc, remote_host, remote_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = raw.transaction((rows: any[]) => {
    for (const t of rows) {
      insert.run(t.name, t.type, t.description ?? null, t.input_desc ?? null, t.output_desc ?? null, t.remote_host ?? null, t.remote_path ?? null);
    }
  });
  tx(tools);
  console.log(`Seeded ${tools.length} tools from ${seedPath}`);
}

function ensureColumn(raw: Database.Database, table: string, columnDef: string): void {
  const columnName = columnDef.trim().split(/\s+/)[0];
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === columnName)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

export function createDb(dbPath: string): Db {
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  ensureColumn(raw, "chat_sessions", "codex_thread_id TEXT");
  ensureColumn(raw, "trt_builds", "pid INTEGER");
  ensureColumn(raw, "trt_builds", "upload_status TEXT");
  ensureColumn(raw, "trt_builds", "platform TEXT DEFAULT '3090'");
  ensureColumn(raw, "trt_builds", "task_id TEXT");
  ensureColumn(raw, "trt_builds", "instance_id TEXT");
  ensureColumn(raw, "trt_builds", "remote_out_dir TEXT");
  seedTools(raw);
  return {
    raw,
    close() {
      raw.close();
    },
  };
}
