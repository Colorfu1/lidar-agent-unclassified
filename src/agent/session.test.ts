import { describe, it, expect } from "vitest";
import { AgentSession } from "./session.js";
import { createDb } from "../db.js";
import fs from "fs";

const TEST_DB = "/tmp/lidar-agent-unclassified-session-test.db";

describe("AgentSession", () => {
  it("constructs with required dependencies", () => {
    const db = createDb(TEST_DB);
    const session = new AgentSession("http://127.0.0.1:3000/mcp");
    expect(session).toBeDefined();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
});
