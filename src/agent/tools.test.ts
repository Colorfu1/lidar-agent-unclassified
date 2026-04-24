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
    const server = createAgentTools({ mgr, db });
    expect(server).toBeDefined();
  });
});
