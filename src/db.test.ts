import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type Db } from "./db.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-unclassified-test.db";

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
