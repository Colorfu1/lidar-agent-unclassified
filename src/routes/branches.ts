import { Router } from "express";
import { BranchMerger } from "../branch/merger.js";

export function branchRoutes(merger: BranchMerger): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    try {
      const branches = merger.listBranches();
      res.json(branches);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/diff", (req, res) => {
    const { source, target } = req.query;
    if (!source || !target) return res.status(400).json({ error: "source and target required" });
    try {
      const diffs = merger.getFileDiffs(String(source), String(target));
      res.json(diffs);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/apply", (req, res) => {
    const { source, file_path } = req.body;
    if (!source || !file_path) return res.status(400).json({ error: "source and file_path required" });
    try {
      merger.applyFile(source, file_path);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
