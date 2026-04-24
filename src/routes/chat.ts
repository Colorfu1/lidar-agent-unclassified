import { Router } from "express";
import type { Db } from "../db.js";

export function chatRoutes(db: Db): Router {
  const router = Router();

  router.get("/sessions", (_req, res) => {
    const sessions = db.raw.prepare(
      "SELECT s.*, COUNT(m.id) as message_count FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id = s.id GROUP BY s.id ORDER BY s.updated_at DESC"
    ).all();
    res.json(sessions);
  });

  router.post("/sessions", (_req, res) => {
    const result = db.raw.prepare("INSERT INTO chat_sessions (title) VALUES ('New Chat')").run();
    const session = db.raw.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(Number(result.lastInsertRowid));
    res.status(201).json(session);
  });

  router.get("/sessions/:id/messages", (req, res) => {
    const messages = db.raw.prepare(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(Number(req.params.id));
    res.json(messages);
  });

  router.delete("/sessions/:id", (req, res) => {
    const id = Number(req.params.id);
    db.raw.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
    db.raw.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  router.patch("/sessions/:id", (req, res) => {
    const { title } = req.body;
    if (title) {
      db.raw.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").run(title, Number(req.params.id));
    }
    res.json({ ok: true });
  });

  return router;
}
