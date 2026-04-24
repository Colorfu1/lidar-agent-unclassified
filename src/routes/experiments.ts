import { Router } from "express";
import fs from "fs";
import path from "path";
import type { ExperimentManager } from "../experiment/manager.js";

export function experimentRoutes(mgr: ExperimentManager): Router {
  const router = Router();

  // Static routes BEFORE parameterized /:id
  router.get("/volc-tasks", (req, res) => {
    const { queue, status, since } = req.query;
    let sql = "SELECT * FROM volc_tasks WHERE 1=1";
    const params: any[] = [];
    if (queue) { sql += " AND queue = ?"; params.push(queue); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (since) { sql += " AND created_at >= ?"; params.push(since); }
    sql += " ORDER BY synced_at DESC LIMIT 100";
    const tasks = mgr.db.raw.prepare(sql).all(...params);
    res.json(tasks);
  });

  router.post("/volc-tasks/sync", async (req, res) => {
    try {
      const { execSync } = await import("child_process");
      const scriptPath = path.resolve("scripts/volc_jobs_status_pretty.sh");
      const ledgerCsv = process.env.VOLC_LEDGER_CSV || path.resolve("../submitted_jobs_yamls/submission_ledger.csv");
      const args = ["bash", scriptPath, "--json", "--all", "--csv", ledgerCsv];

      const output = execSync(args.join(" "), { encoding: "utf-8", timeout: 120000 });
      const tasks: any[] = JSON.parse(output);

      const upsert = mgr.db.raw.prepare(`
        INSERT INTO volc_tasks (volc_task_id, name, queue, queue_label, status, workers, creator, created_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(volc_task_id) DO UPDATE SET
          name = excluded.name,
          queue = excluded.queue,
          queue_label = excluded.queue_label,
          status = excluded.status,
          workers = excluded.workers,
          creator = excluded.creator,
          synced_at = datetime('now')
      `);
      const normalQ = "q-20241104174420-vt829";
      const pipelineQ = "q-20250327162123-lwvqb";
      const tx = mgr.db.raw.transaction((rows: any[]) => {
        for (const t of rows) {
          const qid = t.resource_queue_id || "";
          const qlabel = qid === normalQ ? "normal" : qid === pipelineQ ? "pipeline" : qid.slice(0, 20);
          upsert.run(
            t.task_id || "",
            t.job_name || "",
            qid,
            qlabel,
            t.status || "Unknown",
            t.workers || 0,
            t.creator || "",
            t.start || null,
          );
        }
      });
      tx(tasks);
      res.json({ synced: tasks.length });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/tree-image", (_req, res) => {
    const candidates = [
      path.resolve("data/experiment_tree.png"),
      path.resolve("data/model_eval_results/experiment_tree.png"),
      path.resolve("../model_eval_results/experiment_tree.png"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    }
    res.status(404).json({ error: "experiment_tree.png not found" });
  });

  router.get("/tree-svg", (_req, res) => {
    const candidates = [
      path.resolve("data/experiment_tree.svg"),
      path.resolve("data/model_eval_results/experiment_tree.svg"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        res.setHeader("Content-Type", "image/svg+xml");
        return res.sendFile(p);
      }
    }
    res.status(404).json({ error: "experiment_tree.svg not found" });
  });

  router.post("/regenerate-tree", async (_req, res) => {
    try {
      const { execSync } = await import("child_process");
      execSync("python3 scripts/gen_tree.py", { encoding: "utf-8", timeout: 30000 });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/registry", (_req, res) => {
    const registryPath = path.resolve("data/model_eval_results/experiment_registry.json");
    if (!fs.existsSync(registryPath)) {
      return res.json({ experiments: {}, edges: [] });
    }
    const data = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    res.json(data);
  });

  // Parameterized routes after static ones
  router.get("/", (_req, res) => {
    const exps = mgr.list();
    res.json(exps);
  });

  router.get("/:id", (req, res) => {
    const exp = mgr.get(Number(req.params.id));
    if (!exp) return res.status(404).json({ error: "Not found" });
    res.json(exp);
  });

  router.get("/:id/results", (req, res) => {
    const results = mgr.getEvalResults(Number(req.params.id), req.query.task_type as string | undefined);
    res.json(results);
  });

  router.get("/:id/compare/:otherId", (req, res) => {
    const diff = mgr.compare(Number(req.params.id), Number(req.params.otherId));
    res.json(diff);
  });

  router.post("/", (req, res) => {
    const { name, config_path, dataset_version, parent_id } = req.body;
    const id = mgr.create({ name, config_path, dataset_version, parent_id });
    res.status(201).json({ id });
  });

  return router;
}
