import { Router } from "express";
import type { Db } from "../db.js";

export function toolRoutes(db: Db): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const tools = db.raw.prepare("SELECT * FROM tools ORDER BY type, name").all();
    res.json(tools);
  });

  router.get("/:id", (req, res) => {
    const tool = db.raw.prepare("SELECT * FROM tools WHERE id = ?").get(Number(req.params.id));
    if (!tool) return res.status(404).json({ error: "Not found" });
    res.json(tool);
  });

  router.post("/", (req, res) => {
    const { name, type, description, input_desc, output_desc, remote_host, remote_path } = req.body;
    if (!name || !type) return res.status(400).json({ error: "name and type required" });
    db.raw.prepare(`
      INSERT INTO tools (name, type, description, input_desc, output_desc, remote_host, remote_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        type=excluded.type, description=excluded.description,
        input_desc=excluded.input_desc, output_desc=excluded.output_desc,
        remote_host=excluded.remote_host, remote_path=excluded.remote_path
    `).run(name, type, description ?? null, input_desc ?? null, output_desc ?? null, remote_host ?? null, remote_path ?? null);
    res.status(201).json({ ok: true });
  });

  router.post("/bulk", (req, res) => {
    const tools = req.body;
    if (!Array.isArray(tools)) return res.status(400).json({ error: "expected array" });
    const upsert = db.raw.prepare(`
      INSERT INTO tools (name, type, description, input_desc, output_desc, remote_host, remote_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        type=excluded.type, description=excluded.description,
        input_desc=excluded.input_desc, output_desc=excluded.output_desc,
        remote_host=excluded.remote_host, remote_path=excluded.remote_path
    `);
    const tx = db.raw.transaction((rows: any[]) => {
      for (const t of rows) {
        upsert.run(t.name, t.type, t.description ?? null, t.input_desc ?? null, t.output_desc ?? null, t.remote_host ?? null, t.remote_path ?? null);
      }
    });
    tx(tools);
    res.status(201).json({ inserted: tools.length });
  });

  return router;
}
