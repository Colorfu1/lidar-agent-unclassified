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
