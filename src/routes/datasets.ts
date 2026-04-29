import { Router } from "express";
import { execFile } from "child_process";
import type { Db } from "../db.js";

const SSH_HOST = process.env.SSH_HOST || "root@localhost";
const SSH_PORT = process.env.SSH_PORT || "3333";
const REMOTE_DATA_ROOT = "/high_perf_store3/l3_data/wuwenda/l3_deep/data";
const VIS_SCRIPT = "/high_perf_store3/l3_data/wuwenda/l3_deep/data/mi_pyvista_vis_multi_browser.py";
const VIS_CONFIG_TEMPLATE = "/high_perf_store3/l3_data/wuwenda/l3_deep/data/config/mi_pyvista_vis_multi_browser.yaml";
const VIS_TMP_CONFIG = "/tmp/lidar_agent_vis.yaml";
const VIS_PORT = 8766;

function assertSafePath(p: string): void {
  if (/[`$;|&(){}!#\\]/.test(p) || p.includes("'")) {
    throw new Error(`Unsafe path rejected: ${p}`);
  }
}

function sshExec(command: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-p", SSH_PORT, "-o", "StrictHostKeyChecking=no", SSH_HOST, command],
      { encoding: "utf-8", timeout: timeoutMs },
      (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout || "").trim());
      },
    );
  });
}

export interface VisProcess {
  pid: number;
  port: number;
  pklPath: string;
  startedAt: number;
}

let cachedProxyIp: string | null = null;

async function getProxyIp(): Promise<string> {
  if (cachedProxyIp) return cachedProxyIp;
  try {
    const ip = await sshExec("ip -4 addr show eth1 2>/dev/null | grep -oP 'inet \\K[\\d.]+'", 5000);
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      cachedProxyIp = ip;
      return ip;
    }
  } catch {}
  return "localhost";
}

export async function visUrl(port: number): Promise<string> {
  const ip = await getProxyIp();
  if (ip !== "localhost") {
    return `http://${ip}/proxy/${port}/`;
  }
  return `http://localhost:${port}`;
}

export let activeVis: VisProcess | null = null;

export function setActiveVis(v: VisProcess | null): void {
  activeVis = v;
}

export async function killAllVis(): Promise<void> {
  try {
    await sshExec(
      `pkill -f "mi_pyvista_vis_multi_browser" 2>/dev/null; sleep 0.3; pkill -9 -f "mi_pyvista_vis_multi_browser" 2>/dev/null || true`,
      8000,
    );
  } catch {}
  activeVis = null;
}

export function datasetRoutes(db: Db): Router {
  const router = Router();

  // List all datasets
  router.get("/", (_req, res) => {
    const datasets = db.raw.prepare("SELECT * FROM datasets ORDER BY synced_at DESC").all();
    res.json(datasets);
  });

  // --- Static paths BEFORE /:id to avoid route shadowing ---

  // Current visualization status
  router.get("/visualize/status", async (_req, res) => {
    if (!activeVis) return res.json({ active: false });
    res.json({ active: true, ...activeVis, url: await visUrl(activeVis.port) });
  });

  // Visualize a single pkl file: kill existing, write config, start new
  router.post("/file/visualize", async (req, res) => {
    const { path: filePath } = req.body as { path?: string };
    if (!filePath) return res.status(400).json({ error: "path is required" });

    if (activeVis && activeVis.pklPath === filePath) {
      return res.json({ url: await visUrl(activeVis.port), port: activeVis.port, pid: activeVis.pid, already_running: true });
    }

    try {
      assertSafePath(filePath);

      // 1. Kill any existing visualization processes
      await killAllVis();

      // 2. Write temp config with the target pkl file and host 0.0.0.0
      const yamlContent = [
        `pkl_file: ${filePath}`,
        `eval_dir: ""`,
        `host: 0.0.0.0`,
        `port: ${VIS_PORT}`,
        `fps: 5.0`,
        `point_size: 2.0`,
        `sample_rate: 1`,
        `label_source: gt`,
        `at720: true`,
        `open_browser: false`,
      ].join("\n");

      await sshExec(`cat > ${VIS_TMP_CONFIG} << 'EOFCFG'\n${yamlContent}\nEOFCFG`, 5000);

      // 3. Start visualization with the temp config
      const pidStr = await sshExec(
        `nohup python3 ${VIS_SCRIPT} --config ${VIS_TMP_CONFIG} > /tmp/vis_browser.log 2>&1 & echo $!`,
        10000,
      );
      const pid = parseInt(pidStr.split("\n").pop() || "", 10);
      if (!pid || isNaN(pid)) {
        return res.status(500).json({ error: "Failed to get PID from remote" });
      }

      activeVis = { pid, port: VIS_PORT, pklPath: filePath, startedAt: Date.now() };
      res.json({ url: await visUrl(VIS_PORT), port: VIS_PORT, pid });
    } catch (e) {
      res.status(500).json({ error: `Failed to start visualization: ${e}` });
    }
  });

  // Stop current visualization
  router.post("/file/visualize/stop", async (_req, res) => {
    if (!activeVis) return res.status(404).json({ error: "No running visualization" });

    try {
      await killAllVis();
      res.json({ stopped: true });
    } catch {
      activeVis = null;
      res.json({ stopped: true, note: "kill may have failed but cleared tracking" });
    }
  });

  // --- Dynamic /:id routes below ---

  // Get single dataset
  router.get("/:id", (req, res) => {
    const ds = db.raw.prepare("SELECT * FROM datasets WHERE id = ?").get(Number(req.params.id));
    if (!ds) return res.status(404).json({ error: "Not found" });
    res.json(ds);
  });

  // Scan remote for datasets
  router.post("/scan", async (_req, res) => {
    try {
      const output = await sshExec(
        `ls -d ${REMOTE_DATA_ROOT}/*/ 2>/dev/null | head -30`,
      );

      if (!output) {
        return res.json({ scanned: 0, datasets: [] });
      }

      const dirs = output.split("\n").filter(Boolean);
      const results: any[] = [];
      for (const dir of dirs) {
        const name = dir.split("/").filter(Boolean).pop() || dir;
        const remotePath = dir.replace(/\/$/, "");
        const existing = db.raw.prepare("SELECT * FROM datasets WHERE name = ?").get(name) as any;
        if (!existing) {
          const r = db.raw
            .prepare("INSERT INTO datasets (name, remote_path, synced_at) VALUES (?, ?, datetime('now'))")
            .run(name, remotePath);
          results.push({ name, remote_path: remotePath, id: Number(r.lastInsertRowid) });
        } else {
          results.push(existing);
        }
      }

      res.json({ scanned: dirs.length, datasets: results });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Refresh stats for a single dataset
  router.post("/:id/refresh", async (req, res) => {
    const ds = db.raw.prepare("SELECT * FROM datasets WHERE id = ?").get(Number(req.params.id)) as any;
    if (!ds) return res.status(404).json({ error: "Not found" });
    if (!ds.remote_path) return res.status(400).json({ error: "No remote_path" });

    try {
      assertSafePath(ds.remote_path);
      const statsJson = await sshExec(
        `python3 ${REMOTE_DATA_ROOT}/dataset_stats.py --path "${ds.remote_path}" 2>/dev/null`,
        30000,
      );
      const stats = JSON.parse(statsJson);
      db.raw
        .prepare(
          `UPDATE datasets SET total_frames = ?, train_frames = ?, val_frames = ?, class_distribution_json = ?, synced_at = datetime('now') WHERE id = ?`,
        )
        .run(
          stats.total_frames ?? null,
          stats.train_frames ?? null,
          stats.val_frames ?? null,
          stats.class_distribution ? JSON.stringify(stats.class_distribution) : null,
          ds.id,
        );
      const updated = db.raw.prepare("SELECT * FROM datasets WHERE id = ?").get(ds.id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: `Stats fetch failed: ${e}` });
    }
  });

  return router;
}
