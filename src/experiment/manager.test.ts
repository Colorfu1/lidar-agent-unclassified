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
