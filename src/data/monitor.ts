import { execFile } from "child_process";
import type { Db } from "../db.js";
import { notify } from "../events.js";

const SSH_HOST = process.env.SSH_HOST || "root@localhost";
const SSH_PORT = process.env.SSH_PORT || "3333";
const REMOTE_POLL_MS = 30_000;
const SCRIPT_DIR = "/home/mi/codes/workspace/data";
const VOXEL_DIR = `${SCRIPT_DIR}/Sync/voxel_downsample`;

interface RunningJobRow {
  id: number;
  name: string;
  pid: number | null;
  remote_pid: number | null;
  step: string | null;
  task_type: string | null;
  output_dir: string | null;
  manifest_pkl: string | null;
  new_version: string | null;
  log_path: string | null;
  skip_voxel: number | null;
  started_at: string | null;
}

function sshExec(command: string, timeoutMs = 10_000): Promise<string> {
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

function isLocalProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH";
  }
}

async function isRemoteProcessAlive(pid: number | null): Promise<boolean> {
  if (!pid || pid <= 0) return true;
  try {
    const result = await sshExec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, 8000);
    return result === "alive";
  } catch {
    return true;
  }
}

async function collectManifest(job: RunningJobRow, db: Db): Promise<string | null> {
  if (!job.output_dir) return null;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const version = job.new_version || "";
  const taskType = job.task_type || "data";
  const outDir = job.output_dir;
  const pklPrefix = `train_${taskType}_${date}`;

  const lines = [
    "import pickle, glob, json, os",
    "from pathlib import Path",
    `out = Path("${outDir}")`,
    `bin_dir = out / "converted_dir_flow" / "pilot_concat_clip"`,
    "if not bin_dir.exists():",
    "    dirs = [d for d in out.iterdir() if d.is_dir()]",
    "    for d in dirs:",
    `        candidate = d / "converted_dir_flow" / "pilot_concat_clip"`,
    "        if candidate.exists():",
    "            bin_dir = candidate",
    "            break",
    `bin_files = sorted(str(f) for f in bin_dir.glob("*.bin")) if bin_dir.exists() else []`,
    "if not bin_files:",
    `    print(json.dumps({"error": "no bin files found"}))`,
    "else:",
    `    manifest = {"infos": bin_files, "metadata": {"version": "${version}", "created_at": "${date}", "task": "${taskType}", "count": len(bin_files)}}`,
    `    save_path = str(out / "${pklPrefix}_" + str(len(bin_files)) + ".pkl")`,
    "    with open(save_path, 'wb') as fh:",
    "        pickle.dump(manifest, fh)",
    `    print(json.dumps({"path": save_path, "count": len(bin_files)}))`,
  ];
  const snippet = lines.join("\n");

  try {
    const escaped = snippet.replace(/'/g, "'\"'\"'");
    const result = await sshExec(`python3 -c '${escaped}'`, 60_000);
    const parsed = JSON.parse(result);
    if (parsed.error) return null;
    return parsed.path;
  } catch {
    return null;
  }
}

async function launchVoxelDownsample(job: RunningJobRow, db: Db): Promise<number | null> {
  if (!job.manifest_pkl) return null;
  const jobId = job.id;
  const wrapperPath = `/tmp/lidar_agent_voxel_${jobId}.py`;
  const logPath = `/tmp/lidar_agent_voxel_${jobId}.log`;

  const wrapper = [
    `import sys`,
    `sys.path.insert(0, "${VOXEL_DIR}")`,
    `import voxel_downsample_for_data as vd`,
    `vd.CONFIG["pkl_path"] = "${job.manifest_pkl}"`,
    `vd.main()`,
  ].join("\n");

  try {
    await sshExec(`cat > ${wrapperPath} << 'EOFPY'\n${wrapper}\nEOFPY`, 5000);
    const pidStr = await sshExec(
      `cd ${VOXEL_DIR} && nohup python3 ${wrapperPath} > ${logPath} 2>&1 & echo $!`,
      10_000,
    );
    const pid = parseInt(pidStr.split("\n").pop() || "", 10);
    if (!pid || isNaN(pid)) return null;

    db.raw
      .prepare("UPDATE dataset_jobs SET remote_pid = ?, log_path = ? WHERE id = ?")
      .run(pid, logPath, jobId);

    return pid;
  } catch {
    return null;
  }
}

async function handleManifestAndVoxel(row: RunningJobRow, db: Db): Promise<void> {
  const manifestPath = await collectManifest(row, db);
  if (!manifestPath) {
    db.raw
      .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
      .run(row.id);
    notify("Dataset Generation", `Job #${row.id} failed to collect manifest`, "error");
    return;
  }

  if (row.skip_voxel) {
    db.raw
      .prepare("UPDATE dataset_jobs SET manifest_pkl = ?, status = 'completed', completed_at = datetime('now') WHERE id = ?")
      .run(manifestPath, row.id);
    notify("Dataset Generation", `Job #${row.id} "${row.name}" completed (voxel skipped). Manifest: ${manifestPath}`, "info");
    return;
  }

  db.raw
    .prepare("UPDATE dataset_jobs SET manifest_pkl = ?, step = 'voxel_downsample', remote_pid = NULL WHERE id = ?")
    .run(manifestPath, row.id);
  notify("Dataset Generation", `Manifest collected: ${manifestPath}. Starting voxel downsample...`, "info");

  const voxelPid = await launchVoxelDownsample({ ...row, manifest_pkl: manifestPath }, db);
  if (!voxelPid) {
    db.raw
      .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
      .run(row.id);
    notify("Dataset Generation", `Job #${row.id} failed to start voxel downsample`, "error");
  }
}

async function advanceDatasetJobs(db: Db): Promise<void> {
  const rows = db.raw
    .prepare(
      `SELECT id, name, pid, remote_pid, step, task_type, output_dir, manifest_pkl,
              new_version, log_path, skip_voxel, started_at
       FROM dataset_jobs WHERE status = 'running' ORDER BY id`,
    )
    .all() as RunningJobRow[];

  for (const row of rows) {
    if (row.remote_pid) {
      const alive = await isRemoteProcessAlive(row.remote_pid);
      if (alive) continue;

      if (row.step === "anno_to_pkl") {
        const count = await sshExec(
          `find "${row.output_dir}" -name "*.bin" -type f 2>/dev/null | wc -l`,
          15_000,
        ).catch(() => "0");
        const fileCount = parseInt(count.trim(), 10) || 0;

        if (fileCount > 0) {
          notify("Dataset Generation", `anno_to_pkl completed for job #${row.id} "${row.name}" (${fileCount} files). Collecting manifest...`, "info");
          db.raw.prepare("UPDATE dataset_jobs SET step = 'manifest', remote_pid = NULL WHERE id = ?").run(row.id);
          await handleManifestAndVoxel(row, db);
        } else {
          db.raw
            .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
            .run(row.id);
          notify("Dataset Generation", `Job #${row.id} "${row.name}" anno_to_pkl failed (no output files)`, "error");
        }
      } else if (row.step === "voxel_downsample") {
        const count = await sshExec(
          `find "${row.output_dir}" -path "*voxel_downsampled*" -name "*.bin" -type f 2>/dev/null | wc -l`,
          15_000,
        ).catch(() => "0");
        const fileCount = parseInt(count.trim(), 10) || 0;

        if (fileCount > 0) {
          db.raw
            .prepare("UPDATE dataset_jobs SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
            .run(row.id);
          notify("Dataset Generation", `Job #${row.id} "${row.name}" completed! ${fileCount} voxel-downsampled files. Manifest: ${row.manifest_pkl}`, "info");
        } else {
          db.raw
            .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
            .run(row.id);
          notify("Dataset Generation", `Job #${row.id} "${row.name}" voxel downsample failed (no output)`, "error");
        }
      }
    } else if (row.step === "manifest" && !row.remote_pid) {
      await handleManifestAndVoxel(row, db);
    } else if (row.pid) {
      if (!isLocalProcessAlive(row.pid)) {
        db.raw
          .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ? AND status = 'running'")
          .run(row.id);
        notify("Dataset Job Failed", `Job #${row.id} "${row.name}" process exited unexpectedly`, "error");
      }
    } else {
      const age = db.raw
        .prepare("SELECT (julianday('now') - julianday(started_at)) * 24 * 60 AS minutes FROM dataset_jobs WHERE id = ?")
        .get(row.id) as { minutes: number } | undefined;
      if (age && age.minutes > 5) {
        db.raw
          .prepare("UPDATE dataset_jobs SET status = 'failed', completed_at = datetime('now') WHERE id = ?")
          .run(row.id);
        notify("Dataset Generation", `Job #${row.id} "${row.name}" has no tracked process — marked failed`, "error");
      }
    }
  }
}

export function startDatasetJobMonitor(db: Db): NodeJS.Timeout {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    advanceDatasetJobs(db)
      .catch((err) => { console.error("[dataset-monitor] tick error:", err); })
      .finally(() => { running = false; });
  };

  const timer = setInterval(tick, REMOTE_POLL_MS);
  timer.unref();
  return timer;
}
