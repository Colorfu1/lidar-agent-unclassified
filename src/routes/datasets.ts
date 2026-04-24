import { Router } from "express";
import type { Db } from "../db.js";

export function datasetRoutes(db: Db): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const datasets = db.raw.prepare("SELECT * FROM datasets ORDER BY synced_at DESC").all();
    res.json(datasets);
  });

  router.get("/:id", (req, res) => {
    const ds = db.raw.prepare("SELECT * FROM datasets WHERE id = ?").get(Number(req.params.id));
    if (!ds) return res.status(404).json({ error: "Not found" });
    res.json(ds);
  });

  router.post("/scan", async (_req, res) => {
    try {
      const { execSync } = await import("child_process");
      const sshHost = process.env.SSH_HOST || "root@localhost";
      const sshPort = process.env.SSH_PORT || "3333";
      const remotePath = "/high_perf_store3/l3_data/wuwenda/l3_deep/data";

      const output = execSync(
        `ssh -p ${sshPort} ${sshHost} "ls -d ${remotePath}/*/ 2>/dev/null | head -20"`,
        { encoding: "utf-8", timeout: 15000 }
      ).trim();

      if (!output) {
        return res.json({ scanned: 0, datasets: [] });
      }

      const dirs = output.split("\n").filter(Boolean);
      const upsert = db.raw.prepare(`
        INSERT INTO datasets (name, remote_path, synced_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(id) DO NOTHING
      `);

      const results: any[] = [];
      for (const dir of dirs) {
        const name = dir.split("/").filter(Boolean).pop() || dir;
        const existing = db.raw.prepare("SELECT * FROM datasets WHERE name = ?").get(name);
        if (!existing) {
          const r = upsert.run(name, dir.replace(/\/$/, ""));
          results.push({ name, remote_path: dir, id: Number(r.lastInsertRowid) });
        } else {
          results.push(existing);
        }
      }

      res.json({ scanned: dirs.length, datasets: results });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
