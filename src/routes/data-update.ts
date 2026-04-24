import { Router } from "express";
import type { DataUpdateScheduler } from "../data-update/scheduler.js";

export function dataUpdateRoutes(scheduler: DataUpdateScheduler): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json(scheduler.getStatus());
  });

  router.post("/trigger", async (req, res) => {
    const { raw_data_path, data_config_yaml } = req.body;
    if (!raw_data_path) return res.status(400).json({ error: "raw_data_path required" });
    const id = await scheduler.triggerUpdate(raw_data_path, data_config_yaml);
    res.json({ update_id: id });
  });

  return router;
}
