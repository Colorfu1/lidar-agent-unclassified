import type { Db } from "../db.js";
import type { PipelineBridge } from "../pipeline/bridge.js";
import { notify } from "../events.js";
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
        notify("Data Update Complete", `Update #${updateId} finished`, "success");
      })
      .catch((err) => {
        this.db.raw.prepare("UPDATE data_updates SET status = 'failed' WHERE id = ?").run(updateId);
        notify("Data Update Failed", `Update #${updateId} failed: ${err}`, "error");
        console.error(`[data-update #${updateId}] failed:`, err);
      });

    return updateId;
  }

  getStatus(): object[] {
    return this.db.raw.prepare("SELECT * FROM data_updates ORDER BY id DESC LIMIT 20").all() as object[];
  }
}
