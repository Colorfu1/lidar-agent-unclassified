import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { Db } from "../db.js";
import { notify } from "../events.js";

interface TrtStepStatus {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped" | string;
  detail?: string;
}

interface TrtStatusFile {
  model?: string;
  name?: string;
  engine_dir?: string;
  steps?: TrtStepStatus[];
  missing_keys?: string[];
  unexpected_keys?: string[];
  user_confirm_upload?: boolean;
  terminal?: "completed" | "failed" | null;
  reason?: string | null;
  updated_at?: string;
}

interface RunningBuildRow {
  id: number;
  model: string;
  name: string | null;
  pid: number | null;
  upload_status: string | null;
  platform: string | null;
  task_id: string | null;
  instance_id: string | null;
  remote_out_dir: string | null;
}

interface NotifiedState {
  stepSeen: Record<string, string>;
  keysNotified: boolean;
}

interface BuildWatchState extends NotifiedState {
  lastHeartbeatAt: number;
  lastHeartbeatStepId: string;
  lastMtimeMs: number;
}

const HEARTBEAT_MS = 15000;
const FALLBACK_ENGINE_BASE_3090 = "/home/mi/data/det_and_seg/3090/flatformer_at720_v3";
const L4_ENGINE_BASE_LOCAL = "/home/mi/data/det_and_seg/L4/flatformer_v3";
const L4_POLL_INTERVAL_MS = 20000;
const L4_SSH_HOST = "root@localhost";
const L4_SSH_PORT = "3333";
const RUNTIME_LOG_DIR = path.resolve("data/runtime-logs");
const STATUS_FILE_RETENTION = 50;

function statusFilePath(id: number): string {
  return path.join(RUNTIME_LOG_DIR, `trt-build-${id}.status.json`);
}

function notifiedStatePath(id: number): string {
  return path.join(RUNTIME_LOG_DIR, `trt-build-${id}.notified.json`);
}

function latestPlfPath(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) return null;
  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".plf"));
  if (files.length === 0) return null;
  const sorted = files.sort((a, b) => {
    const am = fs.statSync(path.join(outputDir, a)).mtimeMs;
    const bm = fs.statSync(path.join(outputDir, b)).mtimeMs;
    return bm - am;
  });
  return path.join(outputDir, sorted[0]);
}

function readTrtStatusFile(statusPath: string): TrtStatusFile | null {
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as TrtStatusFile;
  } catch {
    return null;
  }
}

function readNotifiedState(id: number): NotifiedState {
  const p = notifiedStatePath(id);
  if (!fs.existsSync(p)) return { stepSeen: {}, keysNotified: false };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<NotifiedState>;
    return {
      stepSeen: raw.stepSeen ?? {},
      keysNotified: !!raw.keysNotified,
    };
  } catch {
    return { stepSeen: {}, keysNotified: false };
  }
}

function writeNotifiedState(id: number, state: NotifiedState): void {
  const p = notifiedStatePath(id);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function statusMtimeMs(statusPath: string): number {
  try {
    return fs.statSync(statusPath).mtimeMs;
  } catch {
    return 0;
  }
}

// Note: pid === null means the row predates pid tracking; we must treat it as
// alive so we never auto-fail legacy builds. Newer rows always have pid set.
function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH";
  }
}

function isStepSuccess(status: string): boolean {
  return status === "success" || status === "skipped";
}

function terminalFromSteps(steps: TrtStepStatus[]): "completed" | "failed" | null {
  if (steps.length === 0) return null;
  if (steps.some((s) => s.status === "running" || s.status === "pending")) return null;
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.every((s) => isStepSuccess(s.status))) return "completed";
  return null;
}

function resolveEngineDir(statusFile: TrtStatusFile | null, row: RunningBuildRow): string {
  if (statusFile?.engine_dir) return statusFile.engine_dir;
  return path.join(FALLBACK_ENGINE_BASE_3090, row.name || row.model);
}

function finalizeBuild(
  db: Db,
  row: RunningBuildRow,
  status: "completed" | "failed",
  engineDir: string,
  reason?: string,
): boolean {
  const enginePath = status === "completed" ? latestPlfPath(engineDir) : null;
  const result = db.raw
    .prepare(
      "UPDATE trt_builds SET status = ?, engine_path = COALESCE(engine_path, ?), pid = NULL, completed_at = datetime('now') WHERE id = ? AND status = 'running'",
    )
    .run(status, enginePath, row.id);
  if (result.changes === 0) return false;
  if (status === "completed") {
    notify("TRT Build Complete", `Build #${row.id} (${row.model}) finished`, "success");
    if (row.upload_status === "pending_confirm" && enginePath) {
      const uploadInfo = {
        build_id: row.id,
        model: row.model,
        name: enginePath ? path.basename(enginePath, ".plf") : (row.name || row.model),
        engine_path: enginePath,
        upload_dir: path.join(path.dirname(enginePath!), "cloudml_upload"),
        platform: "ipc3090",
        runtime: "trt108",
        precision: "fp32",
        app_label: "ipc3090",
      };
      const confirmTemplate = {
        build_id: row.id,
        version: "v1.0.0",
        app_label: "ipc3090",
        confirm: true,
      };
      const prefilledTemplate = {
        build_id: row.id,
        version: "v1.0.0",
        app_label: "ipc3090",
        confirm: true,
      };
      const payload = {
        stage: "upload_confirm_pending",
        upload_info: uploadInfo,
        confirm_fields: {
          readonly: [
            "build_id",
            "model",
            "name",
            "engine_path",
            "upload_dir",
            "platform",
            "runtime",
            "precision",
          ],
          user_confirmed: [
            "version",
            "confirm",
          ],
        },
        uncertain_defaults: {
          version: "v1.0.0",
          confirm: true,
        },
        prefilled_json_template: prefilledTemplate,
        uncertain_fields: [
          "version",
          "confirm",
        ],
        confirm_json_template: confirmTemplate,
        instruction: "Show only uncertain fields with defaults, then ask: 'Is it ok or need change?'. If user says OK, execute with defaults.",
      };
      notify(
        "TRT Upload Confirm",
        JSON.stringify(payload, null, 2),
        "info",
      );
    }
  } else {
    notify("TRT Build Failed", `Build #${row.id} (${row.model}) failed${reason ? `: ${reason}` : ""}`, "error");
  }
  gcOldStatusFiles();
  return true;
}

function gcOldStatusFiles(): void {
  try {
    if (!fs.existsSync(RUNTIME_LOG_DIR)) return;
    const files = fs
      .readdirSync(RUNTIME_LOG_DIR)
      .filter((f) => f.startsWith("trt-build-") && (f.endsWith(".status.json") || f.endsWith(".notified.json")))
      .map((f) => ({ f, mtime: fs.statSync(path.join(RUNTIME_LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(STATUS_FILE_RETENTION)) {
      try { fs.unlinkSync(path.join(RUNTIME_LOG_DIR, f)); } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
}

// ---- L4 (Volc ML task) monitor ----

interface L4WatchState {
  lastPolledAt: number;
  instanceId: string | null;
  seenSteps: Set<string>;
  finalized: boolean;
  lastVolcStatus: string;
  lastHeartbeatAt: number;
}

const l4Watchers = new Map<number, L4WatchState>();

function runCmd(cmd: string, args: string[], timeoutMs = 20000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function volcTaskStatus(taskId: string): string | null {
  const out = runCmd("volc", ["ml_task", "get", "--id", taskId, "--output", "json"]);
  if (!out) return null;
  try {
    const d = JSON.parse(out);
    const r = Array.isArray(d) ? d[0] : (d?.Result ?? d);
    return r?.Status ?? null;
  } catch { return null; }
}

function volcInstanceId(taskId: string): string | null {
  const out = runCmd("volc", ["ml_task", "instance", "list", "--id", taskId, "--output", "json"]);
  if (!out) return null;
  try {
    const arr = JSON.parse(out);
    if (Array.isArray(arr) && arr.length > 0) return arr[0].Name ?? null;
  } catch { /* ignore */ }
  return null;
}

function volcTaskLog(taskId: string, instanceId: string, lines = 300): string | null {
  const logInstanceId = instanceId.startsWith(`${taskId}-`) ? instanceId.slice(`${taskId}-`.length) : instanceId;
  return runCmd("volc", ["ml_task", "logs", "-t", taskId, "-i", logInstanceId, "--lines", String(lines)], 30000);
}

function ensureL4LogDir(buildId: number): string {
  const p = path.join(RUNTIME_LOG_DIR, `trt-build-${buildId}.l4.log`);
  if (!fs.existsSync(RUNTIME_LOG_DIR)) fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true });
  return p;
}

function fetchL4Engine(row: RunningBuildRow): string | null {
  const name = row.name || row.model;
  const remoteDir = row.remote_out_dir;
  if (!remoteDir) return null;
  const listOut = runCmd("ssh", ["-p", L4_SSH_PORT, "-o", "StrictHostKeyChecking=no", L4_SSH_HOST,
    `ls ${remoteDir}/*.plf 2>/dev/null | head -1`]);
  if (!listOut) return null;
  const plfPath = listOut.trim().split("\n")[0];
  if (!plfPath) return null;
  const stem = path.basename(plfPath, ".plf");
  const newName = `${stem}_L4`;
  const localDir = path.join(L4_ENGINE_BASE_LOCAL, newName);
  fs.mkdirSync(localDir, { recursive: true });
  const localPlf = path.join(localDir, `${newName}.plf`);
  const scp = runCmd("scp", ["-P", L4_SSH_PORT, "-o", "StrictHostKeyChecking=no",
    `${L4_SSH_HOST}:${plfPath}`, localPlf], 120000);
  return scp === null ? null : localPlf;
}

function fetchL4OutputJson(remoteDir: string, localDir: string): string | null {
  const remoteJson = `${remoteDir}/output.json`;
  const localJson = path.join(localDir, "output.json");
  const scp = runCmd("scp", ["-P", L4_SSH_PORT, "-o", "StrictHostKeyChecking=no",
    `${L4_SSH_HOST}:${remoteJson}`, localJson], 60000);
  return scp === null ? null : localJson;
}

function parseEngineOutput(outputJsonPath: string, outDir: string): string | null {
  const script = path.resolve("scripts/parse_engine_output_json.py");
  if (!fs.existsSync(script)) return null;
  const out = runCmd("python3", [script, outputJsonPath, "--out-dir", outDir], 30000);
  if (!out) return null;
  const resultPath = path.join(outDir, "trt_result.txt");
  return fs.existsSync(resultPath) ? resultPath : null;
}

function finalizeL4Build(db: Db, row: RunningBuildRow, status: "completed" | "failed", enginePath: string | null, reason?: string, trtResultPath?: string | null): void {
  const result = db.raw
    .prepare("UPDATE trt_builds SET status = ?, engine_path = COALESCE(engine_path, ?), completed_at = datetime('now') WHERE id = ? AND status = 'running'")
    .run(status, enginePath, row.id);
  if (result.changes === 0) return;
  if (status === "completed") {
    const resultInfo = trtResultPath ? `\nInference check: less ${trtResultPath}` : "";
    notify("TRT Build Complete", `L4 build #${row.id} (${row.model}) finished. engine=${enginePath || "(scp failed)"}${resultInfo}`, "success");
    if (row.upload_status === "pending_confirm" && enginePath) {
      const uploadInfo = {
        build_id: row.id,
        model: row.model,
        name: enginePath ? path.basename(enginePath, ".plf") : (row.name || row.model),
        engine_path: enginePath,
        upload_dir: path.join(path.dirname(enginePath!), "cloudml_upload"),
        platform: "l4",
        runtime: "trt108",
        precision: "fp32",
        app_label: "l4",
      };
      const tmpl = { build_id: row.id, version: "v1.0.0", app_label: "l4", confirm: true };
      const payload = {
        stage: "upload_confirm_pending",
        upload_info: uploadInfo,
        confirm_fields: {
          readonly: ["build_id", "model", "name", "engine_path", "upload_dir", "platform", "runtime", "precision"],
          user_confirmed: ["version", "confirm"],
        },
        uncertain_defaults: { version: "v1.0.0", confirm: true },
        prefilled_json_template: tmpl,
        uncertain_fields: ["version", "confirm"],
        confirm_json_template: tmpl,
        instruction: "Show only uncertain fields with defaults, then ask: 'Is it ok or need change?'. If user says OK, execute with defaults.",
      };
      notify("TRT Upload Confirm", JSON.stringify(payload, null, 2), "info");
    }
  } else {
    const hint = row.remote_out_dir ? ` Remote log: ${row.remote_out_dir}/build.log (ssh -p ${L4_SSH_PORT} ${L4_SSH_HOST})` : "";
    notify("TRT Build Failed", `L4 build #${row.id} (${row.model}) failed${reason ? `: ${reason}` : ""}.${hint}`, "error");
  }
}

function parseL4Steps(logText: string): { steps: string[]; terminal: "completed" | "failed" | null; failStep?: string; failReason?: string } {
  const steps: string[] = [];
  let terminal: "completed" | "failed" | null = null;
  let failStep: string | undefined;
  let failReason: string | undefined;
  for (const line of logText.split(/\r?\n/)) {
    const stepMatch = line.match(/>>> (\w+)/);
    if (stepMatch) steps.push(stepMatch[1]);
    if (line.startsWith("SUCCESS ")) terminal = "completed";
    const failMatch = line.match(/^FAIL\[([^\]]+)\]:\s*(.*)$/);
    if (failMatch) {
      terminal = "failed";
      failStep = failMatch[1];
      failReason = failMatch[2];
    }
  }
  return { steps, terminal, failStep, failReason };
}

function tickL4(db: Db, row: RunningBuildRow): void {
  if (!row.task_id) return;
  let state = l4Watchers.get(row.id);
  if (!state) {
    state = {
      lastPolledAt: 0,
      instanceId: row.instance_id,
      seenSteps: new Set(),
      finalized: false,
      lastVolcStatus: "",
      lastHeartbeatAt: 0,
    };
    l4Watchers.set(row.id, state);
  }
  const now = Date.now();
  if (now - state.lastPolledAt < L4_POLL_INTERVAL_MS) return;
  state.lastPolledAt = now;

  const volcStatus = volcTaskStatus(row.task_id) || "";
  if (volcStatus && volcStatus !== state.lastVolcStatus) {
    state.lastVolcStatus = volcStatus;
    notify("TRT Build Step", `L4 build #${row.id} volc_status=${volcStatus}`, "info");
  }

  if (!state.instanceId && (volcStatus === "Running" || volcStatus === "Success" || volcStatus === "Failed")) {
    state.instanceId = volcInstanceId(row.task_id);
    if (state.instanceId) {
      db.raw.prepare("UPDATE trt_builds SET instance_id = ? WHERE id = ?").run(state.instanceId, row.id);
    }
  }

  let logText = "";
  if (state.instanceId) {
    logText = volcTaskLog(row.task_id, state.instanceId, 500) || "";
    if (logText) {
      try { fs.writeFileSync(ensureL4LogDir(row.id), logText); } catch { /* ignore */ }
    }
  }

  const parsed = parseL4Steps(logText);
  for (const s of parsed.steps) {
    if (!state.seenSteps.has(s)) {
      state.seenSteps.add(s);
      notify("TRT Build Step", `L4 build #${row.id} ${s}: running`, "info");
    }
  }

  // Heartbeat while running with no step change.
  if (!parsed.terminal && volcStatus === "Running" && now - state.lastHeartbeatAt >= HEARTBEAT_MS * 2) {
    state.lastHeartbeatAt = now;
    const last = [...state.seenSteps].pop() || "staging";
    notify("TRT Build Heartbeat", `L4 build #${row.id} ... ${last} still running`, "info");
  }

  if (state.finalized) return;

  // Terminal decision: prefer parsed SUCCESS/FAIL from log; fall back to volc status.
  if (parsed.terminal === "completed" || volcStatus === "Success") {
    state.finalized = true;
    notify("TRT Build Step", `L4 build #${row.id} fetching engine + output.json via scp`, "info");
    const localPlf = fetchL4Engine(row);
    const localDir = localPlf ? path.dirname(localPlf) : null;
    let trtResultPath: string | null = null;
    if (localDir && row.remote_out_dir) {
      const outputJson = fetchL4OutputJson(row.remote_out_dir, localDir);
      if (outputJson) {
        trtResultPath = parseEngineOutput(outputJson, localDir);
      }
    }
    finalizeL4Build(db, row, "completed", localPlf, undefined, trtResultPath);
  } else if (parsed.terminal === "failed" || volcStatus === "Failed" || volcStatus === "Killed") {
    state.finalized = true;
    const reason = parsed.failReason || (parsed.failStep ? `step ${parsed.failStep}` : volcStatus);
    finalizeL4Build(db, row, "failed", null, reason);
  }
}

export function startTrtBuildMonitor(db: Db): NodeJS.Timeout {
  const watchers = new Map<number, BuildWatchState>();

  const tick = () => {
    const rows = db.raw
      .prepare("SELECT id, model, name, pid, upload_status, platform, task_id, instance_id, remote_out_dir FROM trt_builds WHERE status = 'running' ORDER BY id")
      .all() as RunningBuildRow[];

    const activeIds = new Set(rows.map((r) => r.id));
    for (const id of Array.from(watchers.keys())) {
      if (!activeIds.has(id)) watchers.delete(id);
    }

    for (const row of rows) {
      if ((row.platform || "3090") === "L4") {
        tickL4(db, row);
        continue;
      }
      let state = watchers.get(row.id);
      if (!state) {
        const persisted = readNotifiedState(row.id);
        state = {
          stepSeen: { ...persisted.stepSeen },
          keysNotified: persisted.keysNotified,
          lastHeartbeatAt: 0,
          lastHeartbeatStepId: "",
          lastMtimeMs: 0,
        };
        watchers.set(row.id, state);
      }

      const statusPath = statusFilePath(row.id);
      const mtime = statusMtimeMs(statusPath);

      const statusChanged = mtime > 0 && mtime !== state.lastMtimeMs;
      let statusFile: TrtStatusFile | null = null;
      let steps: TrtStepStatus[] = [];
      if (mtime > 0) {
        statusFile = readTrtStatusFile(statusPath);
        if (statusFile) {
          steps = statusFile.steps ?? [];
          if (statusChanged) {
            state.lastMtimeMs = mtime;
          }
        }
      }

      if (statusChanged && steps.length > 0) {
        let notifiedDirty = false;
        for (const step of steps) {
          const prev = state.stepSeen[step.id];
          if (prev === step.status) continue;
          state.stepSeen[step.id] = step.status;
          notifiedDirty = true;
          const level = step.status === "failed" ? "error" : step.status === "success" ? "success" : "info";
          notify("TRT Build Step", `Build #${row.id} ${step.name}: ${step.status}`, level);
        }

        const step3 = steps.find((s) => s.id === "step3_checkpoint_report");
        if (!state.keysNotified && (step3?.status === "success" || step3?.status === "failed")) {
          state.keysNotified = true;
          notifiedDirty = true;
          const missingList = statusFile?.missing_keys ?? [];
          const unexpectedList = statusFile?.unexpected_keys ?? [];
          notify(
            "TRT Build Keys",
            `Build #${row.id} missing_keys (${missingList.length}): ${missingList.join(", ") || "none"}; unexpected_keys (${unexpectedList.length}): ${unexpectedList.join(", ") || "none"}`,
            "info",
          );
        }

        if (notifiedDirty) {
          writeNotifiedState(row.id, { stepSeen: state.stepSeen, keysNotified: state.keysNotified });
        }
      }

      // Prefer explicit terminal marker from writer; fall back to step inference.
      const terminal = statusFile?.terminal ?? terminalFromSteps(steps);

      // Heartbeat should continue even when status file content does not change.
      if (!terminal) {
        const runningStep = steps.find((s) => s.status === "running");
        const now = Date.now();
        if (runningStep) {
          const shouldHeartbeat =
            state.lastHeartbeatStepId !== runningStep.id || now - state.lastHeartbeatAt >= HEARTBEAT_MS;
          if (shouldHeartbeat) {
            state.lastHeartbeatAt = now;
            state.lastHeartbeatStepId = runningStep.id;
            notify("TRT Build Heartbeat", `Build #${row.id} ... ${runningStep.name} is still running`, "info");
          }
        } else {
          const initStepId = "__active__";
          const shouldHeartbeat =
            state.lastHeartbeatStepId !== initStepId || now - state.lastHeartbeatAt >= HEARTBEAT_MS;
          if (shouldHeartbeat) {
            state.lastHeartbeatAt = now;
            state.lastHeartbeatStepId = initStepId;
            notify("TRT Build Heartbeat", `Build #${row.id} ... still running`, "info");
          }
        }
      } else {
        state.lastHeartbeatStepId = "";
      }

      const engineDir = resolveEngineDir(statusFile, row);
      if (terminal) {
        finalizeBuild(db, row, terminal, engineDir, statusFile?.reason ?? undefined);
        continue;
      }

      if (!isProcessAlive(row.pid)) {
        finalizeBuild(db, row, "failed", engineDir, "process exited unexpectedly");
      }
    }
  };

  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return timer;
}
