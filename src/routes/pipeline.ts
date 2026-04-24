import { Router } from "express";
import type { Db } from "../db.js";

export function pipelineRoutes(db: Db): Router {
  const router = Router();

  router.get("/runs", (_req, res) => {
    const runs = db.raw.prepare("SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 50").all();
    res.json(runs);
  });

  router.get("/runs/:id", (req, res) => {
    const run = db.raw.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(Number(req.params.id));
    if (!run) return res.status(404).json({ error: "Not found" });
    res.json(run);
  });

  router.get("/runs/:id/stages", (req, res) => {
    const stages = db.raw
      .prepare("SELECT * FROM pipeline_stages WHERE pipeline_run_id = ? ORDER BY id")
      .all(Number(req.params.id));
    res.json(stages);
  });

  router.get("/proposals", (req, res) => {
    const status = req.query.status as string | undefined;
    const q = status
      ? db.raw.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC").all(status)
      : db.raw.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT 50").all();
    res.json(q);
  });

  router.post("/proposals/:id/approve", (req, res) => {
    db.raw.prepare("UPDATE proposals SET status = 'approved' WHERE id = ? AND status = 'pending'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.post("/proposals/:id/reject", (req, res) => {
    db.raw.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
}
