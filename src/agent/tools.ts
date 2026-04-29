import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExperimentManager } from "../experiment/manager.js";
import type { BranchMerger } from "../branch/merger.js";
import type { PipelineBridge } from "../pipeline/bridge.js";
import type { Db } from "../db.js";
import { notify } from "../events.js";
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import * as dsRoutes from "../routes/datasets.js";

interface ToolDeps {
  mgr: ExperimentManager;
  merger?: BranchMerger;
  bridge?: PipelineBridge;
  db: Db;
}

type ToolHandler = (args: any) => Promise<any> | any;

interface LocalToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: ToolHandler;
  annotations?: ToolAnnotations;
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodType>,
  handler: ToolHandler,
  options?: { annotations?: ToolAnnotations },
): LocalToolDef {
  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: options?.annotations,
  };
}

function createMcpServer(config: { name: string; version: string; tools: LocalToolDef[] }): McpServer {
  const server = new McpServer({ name: config.name, version: config.version });
  for (const def of config.tools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.annotations,
      },
      async (args) => def.handler(args),
    );
  }
  return server;
}

function ensureRuntimeLogDir(): string {
  const logDir = path.resolve("data/runtime-logs");
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function buildNoProxyEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, DISPLAY: "" };
  for (const key of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    delete env[key];
  }
  return env;
}

interface TrtStepStatus {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failed" | "skipped" | string;
  detail?: string;
}

interface TrtStatusFile {
  steps?: TrtStepStatus[];
  missing_keys?: string[];
  unexpected_keys?: string[];
  user_confirm_upload?: boolean;
  terminal?: "completed" | "failed" | null;
  engine_dir?: string;
  updated_at?: string;
}

function readTrtStatusFile(statusPath: string): TrtStatusFile | null {
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as TrtStatusFile;
  } catch {
    return null;
  }
}

function setTrtUserConfirmUpload(statusPath: string, confirmed: boolean): void {
  // Delegate to the status CLI so the write is atomic and serialized with the
  // bash builder's updates. Prevents torn reads when both sides mutate the file.
  if (!fs.existsSync(statusPath)) return;
  const cli = path.resolve("scripts/trt_status_cli.py");
  spawnSync("python3", [cli, "confirm", confirmed ? "true" : "false"], {
    env: { ...process.env, STATUS_FILE: statusPath },
    stdio: "ignore",
  });
}

interface CloudmlUploadPreview {
  build_id: number;
  model: string;
  name: string;
  engine_path: string;
  upload_dir: string;
  platform: string;
  runtime: string;
  precision: string;
  app_label: string;
}

interface CloudmlConfirmTemplate {
  build_id: number;
  version: string;
  app_label: string;
  confirm: boolean;
}

function buildCloudmlUploadPreview(build: any, appLabel = "ipc3090"): CloudmlUploadPreview {
  const enginePath = String(build.engine_path || "");
  const isThor = (build.platform || "3090") === "thor";
  return {
    build_id: Number(build.id),
    model: String(build.model || ""),
    name: String(build.name || build.model || ""),
    engine_path: enginePath,
    upload_dir: enginePath ? path.join(path.dirname(enginePath), "cloudml_upload") : "",
    platform: isThor ? "thor_linux" : "ipc3090",
    runtime: isThor ? "trt101010" : "trt108",
    precision: "fp32",
    app_label: appLabel,
  };
}

function buildCloudmlConfirmTemplate(build: any, appLabel = "ipc3090"): CloudmlConfirmTemplate {
  return {
    build_id: Number(build.id),
    version: "",
    app_label: appLabel,
    confirm: false,
  };
}

function submitL4Build(db: Db, buildId: number, args: { model: string; checkpoint: string; name: string }): Promise<{ taskId: string; outDir: string }> {
  return new Promise((resolve, reject) => {
    const submitLogPath = path.join(ensureRuntimeLogDir(), `trt-build-${buildId}.l4-submit.log`);
    const submitArgs = ["scripts/trt_build_l4_submit.py", "--model", args.model, "--checkpoint", args.checkpoint, "--name", args.name];
    execFile(
      "python3",
      submitArgs,
      {
        cwd: path.resolve("."),
        env: process.env,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const combined = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`;
        try {
          fs.writeFileSync(submitLogPath, combined || String(error ?? ""), "utf-8");
        } catch {
          // ignore log write failures
        }

        if (error) {
          db.raw
            .prepare("UPDATE trt_builds SET status = 'failed', completed_at = datetime('now') WHERE id = ? AND status = 'running'")
            .run(buildId);
          notify("TRT Build Failed", `L4 build #${buildId} submit failed. Check ${submitLogPath}`, "error");
          reject(new Error(`L4 submit failed: ${String(error)}`));
          return;
        }

        const taskIdMatch = combined.match(/^task_id=(t-\S+)/m);
        const outDirMatch = combined.match(/^out_dir=(.+)$/m);
        const taskId = taskIdMatch ? taskIdMatch[1].trim() : "";
        const outDir = outDirMatch ? outDirMatch[1].trim() : "";
        if (!taskId) {
          db.raw
            .prepare("UPDATE trt_builds SET status = 'failed', completed_at = datetime('now') WHERE id = ? AND status = 'running'")
            .run(buildId);
          notify("TRT Build Failed", `L4 build #${buildId} submit returned no task_id. Check ${submitLogPath}`, "error");
          reject(new Error(`L4 submit returned no task_id`));
          return;
        }

        db.raw
          .prepare("UPDATE trt_builds SET task_id = ?, remote_out_dir = ? WHERE id = ? AND status = 'running'")
          .run(taskId, outDir || null, buildId);
        notify("TRT Build Step", `L4 build #${buildId} submitted to Volc task_id=${taskId}`, "info");
        resolve({ taskId, outDir });
      },
    );
  });
}

function runShellAsync(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: stderr || "", stdout: stdout || "" }));
      } else {
        resolve(stdout || "");
      }
    });
  });
}

export function createAgentTools(deps: ToolDeps) {
  const { mgr, merger, bridge, db } = deps;
  const listExperiments = tool(
    "list_experiments",
    "List recorded experiments. Optionally filter by status or task type.",
    {
      status: z.string().optional().describe("Filter by status: created, running, completed, failed"),
    },
    async (args) => {
      const exps = mgr.list(args.status ? { status: args.status } : undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify(exps, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const getEvalResults = tool(
    "get_eval_results",
    "Get evaluation results for an experiment. Returns per-class metrics and overall scores.",
    {
      experiment_id: z.number().describe("Experiment ID"),
      task_type: z.string().optional().describe("Filter by task: OD, FS, FLOW"),
    },
    async (args) => {
      const results = mgr.getEvalResults(args.experiment_id, args.task_type);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const compareExperiments = tool(
    "compare_experiments",
    "Compare metrics between two experiments. Returns a diff table with deltas per metric.",
    {
      exp_id_a: z.number().describe("First experiment ID"),
      exp_id_b: z.number().describe("Second experiment ID"),
    },
    async (args) => {
      const diff = mgr.compare(args.exp_id_a, args.exp_id_b);
      return { content: [{ type: "text" as const, text: JSON.stringify(diff, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const readConfig = tool(
    "read_config",
    "Read and return the contents of an mmdet3d config file.",
    {
      config_path: z.string().describe("Path to config file relative to mmdet3d root"),
    },
    async (args) => {
      try {
        const mmdet3dRoot = process.env.MMDET3D_ROOT || "../mmdet3d";
        const fullPath = `${mmdet3dRoot}/${args.config_path}`;
        const content = fs.readFileSync(fullPath, "utf-8");
        return { content: [{ type: "text" as const, text: content }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to read config: ${e}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } }
  );

  const proposeChange = tool(
    "propose_change",
    "Propose a configuration or data change. Creates a pending proposal that requires user approval before execution.",
    {
      experiment_id: z.number().optional().describe("Related experiment ID"),
      change_type: z.enum(["model", "data"]).describe("Type of change"),
      description: z.string().describe("Human-readable description of the proposed change"),
      config_diff: z.string().optional().describe("Unified diff or config snippet showing the change"),
    },
    async (args) => {
      const result = mgr.db.raw
        .prepare(
          `INSERT INTO proposals (experiment_id, change_type, description, config_diff, status)
           VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(args.experiment_id ?? null, args.change_type, args.description, args.config_diff ?? null);
      const id = Number(result.lastInsertRowid);
      return {
        content: [
          {
            type: "text" as const,
            text: `Proposal #${id} created (pending user approval).\n\nType: ${args.change_type}\nDescription: ${args.description}`,
          },
        ],
      };
    },
    { annotations: { readOnlyHint: true } }
  );

  const listBranches = tool(
    "list_branches",
    "List all git branches in the mmdet3d repository with their last commit hash.",
    {},
    async () => {
      if (!merger) return { content: [{ type: "text" as const, text: "Branch merger not configured" }], isError: true };
      const branches = merger.listBranches();
      return { content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const getBranchDiff = tool(
    "get_branch_diff",
    "Get per-file diffs between two branches in the mmdet3d repository.",
    {
      source_branch: z.string().describe("Source branch name"),
      target_branch: z.string().describe("Target branch name"),
    },
    async (args) => {
      if (!merger) return { content: [{ type: "text" as const, text: "Branch merger not configured" }], isError: true };
      const diffs = merger.getFileDiffs(args.source_branch, args.target_branch);
      const summary = diffs.map((d) => ({ path: d.path, status: d.status, lines: d.diff.split("\n").length }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const getDataStatus = tool(
    "get_data_status",
    "Get the latest dataset update status including last update time and frame counts.",
    {},
    async () => {
      const updates = db.raw.prepare("SELECT * FROM data_updates ORDER BY id DESC LIMIT 5").all();
      return { content: [{ type: "text" as const, text: JSON.stringify(updates, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const submitPipeline = tool(
    "submit_pipeline",
    "Submit an approved plan to the pipeline executor. Requires a DAG template path and parameters.",
    {
      dag_template: z.string().describe("DAG template name: train_eval, eval_only, or data_update"),
      params: z.string().describe("JSON string of pipeline parameters"),
    },
    async (args) => {
      if (!bridge) return { content: [{ type: "text" as const, text: "Pipeline bridge not configured" }], isError: true };
      const dagPath = `pipeline/templates/${args.dag_template}.yaml`;
      const params = JSON.parse(args.params);
      const run = db.raw
        .prepare("INSERT INTO pipeline_runs (dag_template, params_json, status, started_at) VALUES (?, ?, 'running', datetime('now'))")
        .run(args.dag_template, args.params);
      const runId = Number(run.lastInsertRowid);
      bridge.runPipeline(dagPath, params, () => {}).then(() => {
        db.raw.prepare("UPDATE pipeline_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(runId);
        notify("Pipeline Complete", `Run #${runId} (${args.dag_template}) finished`, "success");
      }).catch((err) => {
        db.raw.prepare("UPDATE pipeline_runs SET status = 'failed', completed_at = datetime('now') WHERE id = ?").run(runId);
        notify("Pipeline Failed", `Run #${runId} (${args.dag_template}) failed: ${err}`, "error");
      });
      return { content: [{ type: "text" as const, text: `Pipeline run #${runId} submitted (${args.dag_template})` }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const getPipelineStatus = tool(
    "get_pipeline_status",
    "Get the status of a pipeline run and its stages.",
    {
      pipeline_id: z.number().describe("Pipeline run ID"),
    },
    async (args) => {
      const run = db.raw.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(args.pipeline_id);
      const stages = db.raw.prepare("SELECT * FROM pipeline_stages WHERE pipeline_run_id = ? ORDER BY id").all(args.pipeline_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ run, stages }, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const registerTool = tool(
    "register_tool",
    "Register or update a tool in the pipeline tool registry. Tools are remote scripts or DAG templates used for training and data processing.",
    {
      name: z.string().describe("Tool name (unique identifier)"),
      type: z.enum(["dag_template", "data_script"]).describe("Tool type"),
      description: z.string().describe("What the tool does"),
      input_desc: z.string().optional().describe("Description of expected inputs"),
      output_desc: z.string().optional().describe("Description of outputs"),
      remote_host: z.string().optional().describe("Remote host (e.g. root@localhost:3333)"),
      remote_path: z.string().optional().describe("Path to script/template on remote"),
    },
    async (args) => {
      db.raw.prepare(`
        INSERT INTO tools (name, type, description, input_desc, output_desc, remote_host, remote_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          type = excluded.type,
          description = excluded.description,
          input_desc = excluded.input_desc,
          output_desc = excluded.output_desc,
          remote_host = excluded.remote_host,
          remote_path = excluded.remote_path
      `).run(args.name, args.type, args.description, args.input_desc ?? null, args.output_desc ?? null, args.remote_host ?? null, args.remote_path ?? null);
      return { content: [{ type: "text" as const, text: `Tool "${args.name}" registered.` }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  const trtBuild = tool(
    "trt_build",
    "Build a TRT engine from a PyTorch checkpoint using the packaged start script. Runs async in local docker (RTX 3090).",
    {
      model: z.enum(["lite", "large"]).describe("Model type: lite (dev_lit branch) or large (feat_merge branch)"),
      checkpoint: z.string().describe("Path to .pth checkpoint file"),
      name: z.string().optional().describe("Model name for output directory (defaults to model type)"),
    },
    async (args) => {
      const scriptPath = path.resolve("scripts/trt_build_start.sh");
      const hostDataPklRoot = "/home/mi/data/data_pkl";
      const dockerDataPklRoot = "/data_pkl";
      if (!fs.existsSync(scriptPath)) {
        return { content: [{ type: "text" as const, text: `Script not found: ${scriptPath}` }], isError: true };
      }

      let resolvedCheckpoint = args.checkpoint;
      if (!fs.existsSync(resolvedCheckpoint) && resolvedCheckpoint.startsWith(`${dockerDataPklRoot}/`)) {
        resolvedCheckpoint = path.join(hostDataPklRoot, resolvedCheckpoint.slice(`${dockerDataPklRoot}/`.length));
      }

      if (!fs.existsSync(resolvedCheckpoint)) {
        return {
          content: [{
            type: "text" as const,
            text: `Checkpoint not found: ${args.checkpoint}\nTried host path: ${resolvedCheckpoint}`,
          }],
          isError: true,
        };
      }

      const startArgs = ["scripts/trt_build_start.sh", "--model", args.model, "--checkpoint", resolvedCheckpoint];
      if (args.name) startArgs.push("--name", args.name);
      try {
        const out = await runShellAsync("bash", startArgs, {
          cwd: path.resolve("."),
          env: process.env,
          timeout: 30 * 60 * 1000,
        });
        const buildIdMatch = out.match(/build_id=(\d+)/);
        const buildId = buildIdMatch ? Number(buildIdMatch[1]) : null;
        const success = /TRT build completed/i.test(out);
        return {
          content: [{
            type: "text" as const,
            text: buildId
              ? `TRT build #${buildId} ${success ? "completed" : "finished"} (${args.model}).`
              : `TRT build ${success ? "completed" : "finished"} (${args.model}).`,
          }],
        };
      } catch (e: any) {
        const stderr = e?.stderr || "";
        const stdout = e?.stdout || "";
        const buildIdMatch = (stdout + stderr).match(/build_id=(\d+)/);
        const buildId = buildIdMatch ? Number(buildIdMatch[1]) : null;
        return {
          content: [{
            type: "text" as const,
            text: buildId
              ? `TRT build #${buildId} failed (${args.model}): ${String(e?.message || e)}`
              : `Failed to run TRT build: ${String(e?.stderr || e?.message || e)}`,
          }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } }
  );

  const trtBuildL4 = tool(
    "trt_build_l4",
    "Submit an L4 TRT engine build as a Volc ML task. Parallel to trt_build (which targets local 3090 docker). Use when the user asks for an L4 / car-side engine.",
    {
      model: z.enum(["lite", "large"]).describe("Model type: lite (dev_lit branch) or large (feat_merge branch)"),
      checkpoint: z.string().describe("Path to .pth checkpoint file (must be accessible on shared vepfs)"),
      name: z.string().optional().describe("Build name / output subdir (defaults to model type)"),
    },
    async (args) => {
      const scriptPath = path.resolve("scripts/trt_build_l4_submit.py");
      if (!fs.existsSync(scriptPath)) {
        return { content: [{ type: "text" as const, text: `Script not found: ${scriptPath}` }], isError: true };
      }
      const vepfsPthBase = "/high_perf_store3/l3_data/wuwenda/centerpoint/pth_dir";
      const checkpoint = args.checkpoint.startsWith("/") ? args.checkpoint : path.join(vepfsPthBase, args.checkpoint);
      const name = (args.name || args.model).trim();
      try {
        const result = db.raw
          .prepare(
            `INSERT INTO trt_builds (model, checkpoint, name, status, upload_status, platform)
             VALUES (?, ?, ?, 'running', 'pending_confirm', 'L4')`,
          )
          .run(args.model, checkpoint, name);
        const buildId = Number(result.lastInsertRowid);
        const { taskId, outDir } = await submitL4Build(db, buildId, { model: args.model, checkpoint, name });
        return {
          content: [{
            type: "text" as const,
            text: `L4 TRT build #${buildId} submitted (model=${args.model}, task_id=${taskId}${outDir ? `, out_dir=${outDir}` : ""}). The remote Volc task is now running.`,
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to submit L4 TRT build: ${String(e?.message || e)}`,
          }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } }
  );

  const trtBuildStatus = tool(
    "trt_build_status",
    "Get status of a TRT engine build. Returns process state metadata only (no runtime logs).",
    {
      build_id: z.number().optional().describe("Build ID (omit for latest)"),
    },
    async (args) => {
      const row = args.build_id
        ? db.raw.prepare("SELECT * FROM trt_builds WHERE id = ?").get(args.build_id)
        : db.raw.prepare("SELECT * FROM trt_builds ORDER BY id DESC LIMIT 1").get();
      if (!row) {
        return { content: [{ type: "text" as const, text: "No TRT build found" }], isError: true };
      }
      const build = row as any;
      const platform = build.platform || "3090";
      const safe = {
        id: build.id,
        platform,
        model: build.model,
        checkpoint: build.checkpoint,
        name: build.name,
        version: build.version,
        status: build.status,
        engine_path: build.engine_path,
        started_at: build.started_at,
        completed_at: build.completed_at,
        log_path: path.resolve("data/runtime-logs", `trt-build-${build.id}.log`),
      };
      if (platform === "L4") {
        const engineDir = build.engine_path ? path.dirname(build.engine_path) : null;
        const trtResult = engineDir ? path.join(engineDir, "trt_result.txt") : null;
        const detail = {
          ...safe,
          task_id: build.task_id ?? null,
          instance_id: build.instance_id ?? null,
          remote_out_dir: build.remote_out_dir ?? null,
          remote_build_log: build.remote_out_dir ? `${build.remote_out_dir}/build.log` : null,
          upload_status: build.upload_status ?? null,
          volc_log_path: path.resolve("data/runtime-logs", `trt-build-${build.id}.l4.log`),
          trt_result: trtResult && fs.existsSync(trtResult) ? trtResult : null,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] };
      }
      const statusPath = path.resolve("data/runtime-logs", `trt-build-${build.id}.status.json`);
      const statusFile = readTrtStatusFile(statusPath);
      const detail = {
        ...safe,
        status_path: statusPath,
        upload_status: build.upload_status ?? null,
        steps: statusFile?.steps ?? [],
        user_confirm_upload: statusFile?.user_confirm_upload ?? false,
        missing_keys: statusFile?.missing_keys ?? [],
        unexpected_keys: statusFile?.unexpected_keys ?? [],
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } }
  );

  function loadUploadableBuild(buildId: number):
    | { ok: true; build: any }
    | { ok: false; error: { content: [{ type: "text"; text: string }]; isError: true } } {
    if (!buildId || !Number.isFinite(buildId)) {
      return { ok: false, error: { content: [{ type: "text", text: "Missing build_id." }], isError: true } };
    }
    const build = db.raw.prepare("SELECT * FROM trt_builds WHERE id = ?").get(buildId) as any;
    if (!build) return { ok: false, error: { content: [{ type: "text", text: `Build #${buildId} not found` }], isError: true } };
    if (build.status !== "completed") return { ok: false, error: { content: [{ type: "text", text: `Build #${buildId} is ${build.status}, not completed` }], isError: true } };
    if (!build.engine_path) return { ok: false, error: { content: [{ type: "text", text: `Build #${buildId} has no engine_path` }], isError: true } };
    return { ok: true, build };
  }

  const cloudmlUploadPreview = tool(
    "cloudml_upload_preview",
    "Read-only preview of the CloudML upload for a completed TRT build. Returns the model name, engine path, platform, and the JSON template the user would confirm. Does NOT upload or change state. Call this first whenever the user asks about upload details (e.g. \"what is the model name?\", \"what version?\", \"show upload info\").",
    {
      build_id: z.number().describe("Build ID of a completed TRT build."),
      app_label: z.string().optional().describe("CloudML app label (default: ipc3090)."),
    },
    async (args) => {
      const appLabel = (args.app_label ?? "ipc3090").trim() || "ipc3090";
      const loaded = loadUploadableBuild(Number(args.build_id));
      if (!loaded.ok) return loaded.error;
      const { build } = loaded;
      const preview = buildCloudmlUploadPreview(build, appLabel);
      const defaultVersion = String(build.version ?? "").trim() || "v1.0.0";
      const template = {
        build_id: Number(build.id),
        version: defaultVersion,
        app_label: appLabel,
      };
      const uploadStatus = build.upload_status ?? "pending_confirm";
      return {
        content: [{
          type: "text" as const,
          text: [
            `Upload preview for build #${build.id} (status=${uploadStatus}):`,
            JSON.stringify(preview, null, 2),
            "",
            "Confirm template (ask user before executing):",
            JSON.stringify(template, null, 2),
          ].join("\n"),
        }],
      };
    },
    { annotations: { readOnlyHint: true } }
  );

  const cloudmlUploadExecute = tool(
    "cloudml_upload_execute",
    "EXECUTE the CloudML upload for a completed TRT build. ONLY call this after the user has explicitly confirmed (e.g. said \"yes\", \"upload\", \"confirm\", \"go ahead\"). If the user is merely asking for information, use cloudml_upload_preview instead. Never call this autonomously.",
    {
      build_id: z.number().describe("Build ID of a completed TRT build."),
      version: z.string().optional().describe("Model version for CloudML (e.g. v1.0.0). Defaults to v1.0.0 if omitted."),
      app_label: z.string().optional().describe("CloudML app label (default: ipc3090)."),
    },
    async (args) => {
      const buildId = Number(args.build_id);
      const appLabel = (args.app_label ?? "ipc3090").trim() || "ipc3090";
      const loaded = loadUploadableBuild(buildId);
      if (!loaded.ok) return loaded.error;
      const { build } = loaded;

      const version = (args.version ?? "").trim() || String(build.version ?? "").trim() || "v1.0.0";
      const statusPath = path.resolve("data/runtime-logs", `trt-build-${buildId}.status.json`);
      setTrtUserConfirmUpload(statusPath, true);

      const scriptsDir = path.resolve("scripts");
      const prepareScript = path.join(scriptsDir, "prepare_cloudml_upload.py");
      const submitScript = path.join(scriptsDir, "submit_cloudml_upload.py");
      const uploadLogPath = path.join(ensureRuntimeLogDir(), `cloudml-upload-${buildId}-${Date.now()}.log`);
      const outFd = fs.openSync(uploadLogPath, "a");
      const noProxyEnv = buildNoProxyEnv(process.env);

      try {
        execFileSync("python3", [prepareScript, build.engine_path, "--force", "--name", build.name || build.model, "--version", version], {
          timeout: 60000,
          stdio: ["ignore", outFd, outFd],
          env: noProxyEnv,
        });

        const uploadDir = path.join(path.dirname(build.engine_path), "cloudml_upload");
        execFileSync("python3", [submitScript, uploadDir, "--app-label", appLabel, "--yes"], {
          timeout: 120000,
          stdio: ["ignore", outFd, outFd],
          env: noProxyEnv,
        });

        db.raw
          .prepare("UPDATE trt_builds SET version = ?, upload_status = 'approved' WHERE id = ?")
          .run(version, buildId);
        notify("CloudML Upload Complete", `${build.name || build.model} ${version} uploaded`, "success");
        fs.closeSync(outFd);

        return {
          content: [{
            type: "text" as const,
            text: `Upload complete (build #${buildId}, version ${version}, app_label ${appLabel}).`,
          }],
        };
      } catch (e) {
        fs.closeSync(outFd);
        notify("CloudML Upload Failed", `${build.name || build.model} ${version} failed`, "error");
        return {
          content: [{
            type: "text" as const,
            text: `Upload failed for build #${buildId}. Check execute env log: ${uploadLogPath}`,
          }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } }
  );

  const trtDeclineUpload = tool(
    "trt_decline_upload",
    "Decline the CloudML upload prompt for a completed TRT build. Marks the build as upload-declined so the prompt is not re-emitted.",
    {
      build_id: z.number().describe("Build ID of the completed TRT build to skip uploading"),
      reason: z.string().optional().describe("Optional reason recorded in the notification"),
    },
    async (args) => {
      const build = db.raw.prepare("SELECT * FROM trt_builds WHERE id = ?").get(args.build_id) as any;
      if (!build) return { content: [{ type: "text" as const, text: `Build #${args.build_id} not found` }], isError: true };
      if (build.upload_status !== "pending_confirm") {
        return {
          content: [{
            type: "text" as const,
            text: `Build #${args.build_id} upload_status is ${build.upload_status ?? "null"}, nothing to decline.`,
          }],
          isError: true,
        };
      }
      db.raw.prepare("UPDATE trt_builds SET upload_status = 'declined' WHERE id = ?").run(args.build_id);
      const statusPath = path.resolve("data/runtime-logs", `trt-build-${args.build_id}.status.json`);
      setTrtUserConfirmUpload(statusPath, false);
      notify(
        "CloudML Upload Declined",
        `Build #${args.build_id} (${build.name || build.model}) skipped${args.reason ? `: ${args.reason}` : ""}`,
        "info",
      );
      return {
        content: [{ type: "text" as const, text: `Upload declined for build #${args.build_id}.` }],
      };
    },
    { annotations: { readOnlyHint: true } }
  );

  // ---- Thor TRT engine build ----

  const THOR_LOCAL_OUT = "/home/mi/data/det_and_seg/thor";
  const THOR_SOC_DIR = "/tmp/wuwenda/engine";

  const trtBuildThor = tool(
    "trt_build_thor",
    "Build a TRT engine (.plf) on the Thor SOC machine. Multi-hop pipeline: uploads ONNX to gateway (10.235.234.34) then to soc1, runs trtexec inside trtexec_package/, and copies the .plf and output.json back to the local machine. Creates a new folder under /home/mi/data/det_and_seg/thor/<name>/.",
    {
      onnx_path: z.string().describe("Absolute path to the local .onnx file"),
      name: z.string().optional().describe("Build name / output folder name (defaults to onnx filename stem)"),
    },
    async (args) => {
      if (!fs.existsSync(args.onnx_path)) {
        return { content: [{ type: "text" as const, text: `ONNX file not found: ${args.onnx_path}` }], isError: true };
      }
      if (!args.onnx_path.endsWith(".onnx")) {
        return { content: [{ type: "text" as const, text: `File does not look like an ONNX: ${args.onnx_path}` }], isError: true };
      }

      const onnxBasename = path.basename(args.onnx_path, ".onnx");
      const buildName = (args.name || onnxBasename).trim();

      const result = db.raw
        .prepare(
          `INSERT INTO trt_builds (model, checkpoint, name, status, upload_status, platform)
           VALUES ('thor', ?, ?, 'running', 'pending_confirm', 'thor')`,
        )
        .run(args.onnx_path, buildName);
      const buildId = Number(result.lastInsertRowid);

      const scriptPath = path.resolve("scripts/trt_build_thor.sh");
      const logPath = path.join(ensureRuntimeLogDir(), `trt-build-${buildId}.thor.log`);

      const scriptArgs = [scriptPath, "--onnx", args.onnx_path, "--name", buildName];

      const STEP_LABELS: Record<string, string> = {
        prepare: "Preparing remote directories",
        upload_to_gateway: "Uploading ONNX to gateway",
        upload_to_soc: "Uploading ONNX to soc1",
        build: "Running trtexec on soc1",
        download_from_soc: "Downloading results from soc1",
        download_to_local: "Downloading results to local",
        done: "Pipeline finished",
      };

      try {
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn("bash", scriptArgs, {
            cwd: path.resolve("."),
            env: { ...process.env, BUILD_ID: String(buildId) },
          });
          let stdout = "";
          let stderr = "";
          const timeout = setTimeout(() => { child.kill(); reject(new Error("Thor build timed out (30m)")); }, 30 * 60 * 1000);

          child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            for (const line of text.split("\n")) {
              const stepMatch = line.match(/^step=(\w+)/);
              if (stepMatch) {
                const step = stepMatch[1];
                const label = STEP_LABELS[step] || step;
                notify("TRT Build (Thor)", `#${buildId} — ${label}`, "info");
              }
            }
          });
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("error", (err) => { clearTimeout(timeout); reject(err); });
          child.on("close", (code) => {
            clearTimeout(timeout);
            if (code !== 0) reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr }));
            else resolve(stdout);
          });
        });

        try { fs.writeFileSync(logPath, out, "utf-8"); } catch { /* ignore */ }

        const engineMatch = out.match(/^engine_path=(.+)$/m);
        const outDirMatch = out.match(/^out_dir=(.+)$/m);
        const enginePath = engineMatch ? engineMatch[1].trim() : null;
        const outDir = outDirMatch ? outDirMatch[1].trim() : null;

        if (enginePath && fs.existsSync(enginePath)) {
          db.raw
            .prepare("UPDATE trt_builds SET status = 'completed', engine_path = ?, remote_out_dir = ?, completed_at = datetime('now') WHERE id = ?")
            .run(enginePath, outDir, buildId);
          notify("TRT Build (Thor)", `Build #${buildId} "${buildName}" completed. Engine: ${enginePath}`, "success");
          const plfStem = path.basename(enginePath, ".plf");
          notify("TRT Upload Confirm", JSON.stringify({
            upload_info: { build_id: buildId, model_name: plfStem, engine_path: enginePath, platform: "thor" },
            prefilled_json_template: { build_id: buildId, version: "v1.0.0", app_label: "ipc3090" },
          }, null, 2), "info");
          return {
            content: [{
              type: "text" as const,
              text: `Thor TRT build #${buildId} completed.\nEngine: ${enginePath}\nOutput dir: ${outDir}\n\nCloudML upload is pending confirmation. Model name: ${plfStem}, default version: v1.0.0, app_label: ipc3090.\nShall I upload? (say "yes" to confirm, or specify a different version)`,
            }],
          };
        } else {
          db.raw
            .prepare("UPDATE trt_builds SET status = 'completed', remote_out_dir = ?, stdout = ?, completed_at = datetime('now') WHERE id = ?")
            .run(outDir, out.slice(-2000), buildId);
          notify("TRT Build (Thor)", `Build #${buildId} "${buildName}" finished but no PLF found. trtexec may have failed.`, "info");
          return {
            content: [{
              type: "text" as const,
              text: [
                `Thor TRT build #${buildId} pipeline finished but no .plf was downloaded.`,
                `trtexec may have failed on soc1. Check log or soc1:${THOR_SOC_DIR}/ manually.`,
                `Output dir: ${outDir}`,
                `Log: ${logPath}`,
              ].join("\n"),
            }],
          };
        }
      } catch (e: any) {
        const stderr = String(e?.stderr || "");
        const stdout = String(e?.stdout || "");
        try { fs.writeFileSync(logPath, `${stdout}\n${stderr}`, "utf-8"); } catch { /* ignore */ }
        db.raw
          .prepare("UPDATE trt_builds SET status = 'failed', stdout = ?, completed_at = datetime('now') WHERE id = ?")
          .run((stdout + stderr).slice(-2000), buildId);
        notify("TRT Build (Thor)", `Build #${buildId} "${buildName}" failed`, "error");
        return {
          content: [{
            type: "text" as const,
            text: `Thor TRT build #${buildId} failed: ${String(e?.message || e)}\nLog: ${logPath}`,
          }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const trtBuildThorStatus = tool(
    "trt_build_thor_status",
    "Get status of a Thor TRT engine build. Returns build metadata, engine path, and log location.",
    {
      build_id: z.number().optional().describe("Build ID (omit for latest Thor build)"),
    },
    async (args) => {
      const row = args.build_id
        ? db.raw.prepare("SELECT * FROM trt_builds WHERE id = ? AND platform = 'thor'").get(args.build_id)
        : db.raw.prepare("SELECT * FROM trt_builds WHERE platform = 'thor' ORDER BY id DESC LIMIT 1").get();
      if (!row) return { content: [{ type: "text" as const, text: "No Thor TRT build found" }], isError: true };
      const build = row as any;

      const detail = {
        id: build.id,
        platform: "thor",
        model: build.model,
        onnx_path: build.checkpoint,
        name: build.name,
        status: build.status,
        engine_path: build.engine_path,
        out_dir: build.remote_out_dir,
        upload_status: build.upload_status,
        started_at: build.started_at,
        completed_at: build.completed_at,
        log_path: path.resolve("data/runtime-logs", `trt-build-${build.id}.thor.log`),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  // ---- Dataset tools (mirrors TRT tool patterns) ----

  const DATA_SSH_HOST = process.env.SSH_HOST || "root@localhost";
  const DATA_SSH_PORT = process.env.SSH_PORT || "3333";
  const REMOTE_DATA_ROOT = "/high_perf_store3/l3_data/wuwenda/l3_deep/data";
  const VIS_SCRIPT = `${REMOTE_DATA_ROOT}/mi_pyvista_vis_multi_browser.py`;
  const VIS_CONFIG_TEMPLATE = `${REMOTE_DATA_ROOT}/config/mi_pyvista_vis_multi_browser.yaml`;
  const VIS_TMP_CONFIG = "/tmp/lidar_agent_vis.yaml";
  const VIS_PORT = 8766;

  function assertSafePath(p: string): void {
    if (/[`$;|&(){}!#\\]/.test(p) || p.includes("'")) {
      throw new Error(`Unsafe path rejected: ${p}`);
    }
  }

  function sshExecAsync(command: string, timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        ["-p", DATA_SSH_PORT, "-o", "StrictHostKeyChecking=no", DATA_SSH_HOST, command],
        { encoding: "utf-8", timeout: timeoutMs },
        (err, stdout) => {
          if (err) reject(err);
          else resolve((stdout || "").trim());
        },
      );
    });
  }

  function resolveDataset(args: { dataset_id?: number; dataset_name?: string }): any {
    if (args.dataset_id) return db.raw.prepare("SELECT * FROM datasets WHERE id = ?").get(args.dataset_id);
    if (args.dataset_name) return db.raw.prepare("SELECT * FROM datasets WHERE name LIKE ?").get(`%${args.dataset_name}%`);
    return null;
  }

  const datasetList = tool(
    "dataset_list",
    "List all known datasets with their statistics (frame counts, class distribution). Use to answer questions about available training/eval data.",
    {
      has_stats: z.boolean().optional().describe("If true, only return datasets that have statistics populated"),
    },
    async (args) => {
      const query = args.has_stats
        ? "SELECT * FROM datasets WHERE total_frames IS NOT NULL ORDER BY synced_at DESC"
        : "SELECT * FROM datasets ORDER BY synced_at DESC";
      const datasets = db.raw.prepare(query).all();
      return { content: [{ type: "text" as const, text: JSON.stringify(datasets, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetScan = tool(
    "dataset_scan",
    "Scan the remote machine for dataset directories and register them in the database. Does NOT fetch statistics — use dataset_refresh_stats for that.",
    {},
    async () => {
      try {
        const output = await sshExecAsync(
          `ls -d ${REMOTE_DATA_ROOT}/*/ 2>/dev/null | head -30`,
        );
        if (!output) return { content: [{ type: "text" as const, text: "No dataset directories found on remote." }] };

        const dirs = output.split("\n").filter(Boolean);
        let added = 0;
        for (const dir of dirs) {
          const name = dir.split("/").filter(Boolean).pop() || dir;
          const remotePath = dir.replace(/\/$/, "");
          const existing = db.raw.prepare("SELECT id FROM datasets WHERE name = ?").get(name);
          if (!existing) {
            db.raw.prepare("INSERT INTO datasets (name, remote_path, synced_at) VALUES (?, ?, datetime('now'))").run(name, remotePath);
            added++;
          }
        }
        return { content: [{ type: "text" as const, text: `Scanned ${dirs.length} directories, added ${added} new datasets.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Scan failed: ${e}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetRefreshStats = tool(
    "dataset_refresh_stats",
    "Fetch or refresh statistics (frame counts, class distribution) for a dataset by running dataset_stats.py on the remote machine. Use after scanning or when stats are missing.",
    {
      dataset_id: z.number().optional().describe("Dataset ID"),
      dataset_name: z.string().optional().describe("Dataset name (used if dataset_id not provided)"),
    },
    async (args) => {
      const ds = resolveDataset(args);
      if (!ds) return { content: [{ type: "text" as const, text: "Dataset not found" }], isError: true };
      if (!ds.remote_path) return { content: [{ type: "text" as const, text: `Dataset "${ds.name}" has no remote_path` }], isError: true };

      try {
        assertSafePath(ds.remote_path);
        const statsJson = await sshExecAsync(
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
        return {
          content: [{
            type: "text" as const,
            text: `Stats refreshed for "${ds.name}": ${stats.total_frames ?? "?"} frames (train: ${stats.train_frames ?? "?"}, val: ${stats.val_frames ?? "?"})`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Stats fetch failed for "${ds.name}": ${e}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetVisualize = tool(
    "dataset_visualize",
    "Start the PyVista point cloud visualization server for a pkl file on the remote machine. Kills any existing viewer first. Returns a browser URL.",
    {
      pkl_path: z.string().describe("Absolute path to the pkl file on the remote machine"),
    },
    async (args) => {
      const current = dsRoutes.activeVis;
      if (current && current.pklPath === args.pkl_path) {
        const url = await dsRoutes.visUrl(current.port);
        return { content: [{ type: "text" as const, text: `Visualization already running for ${args.pkl_path} at ${url} (pid ${current.pid})` }] };
      }

      try {
        assertSafePath(args.pkl_path);

        await dsRoutes.killAllVis();

        const yamlContent = [
          `pkl_file: ${args.pkl_path}`,
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

        await sshExecAsync(`cat > ${VIS_TMP_CONFIG} << 'EOFCFG'\n${yamlContent}\nEOFCFG`, 5000);

        const pidStr = await sshExecAsync(
          `nohup python3 ${VIS_SCRIPT} --config ${VIS_TMP_CONFIG} > /tmp/vis_browser.log 2>&1 & echo $!`,
          10000,
        );
        const pid = parseInt(pidStr.split("\n").pop() || "", 10);
        if (!pid || isNaN(pid)) {
          return { content: [{ type: "text" as const, text: "Failed to get PID from remote" }], isError: true };
        }
        dsRoutes.setActiveVis({ pid, port: VIS_PORT, pklPath: args.pkl_path, startedAt: Date.now() });
        const url = await dsRoutes.visUrl(VIS_PORT);
        notify("Dataset Vis Started", `Visualization at ${url}`, "info");
        return { content: [{ type: "text" as const, text: `Visualization started for ${args.pkl_path} at ${url} (pid ${pid})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to start visualization: ${e}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetVisualizeStop = tool(
    "dataset_visualize_stop",
    "Stop the running PyVista visualization server.",
    {},
    async () => {
      const current = dsRoutes.activeVis;
      if (!current) return { content: [{ type: "text" as const, text: "No visualization is currently running" }], isError: true };

      const pklPath = current.pklPath;
      try {
        await dsRoutes.killAllVis();
      } catch { /* ignore */ }
      notify("Dataset Vis Stopped", "Visualization stopped", "info");
      return { content: [{ type: "text" as const, text: `Visualization stopped for ${pklPath}` }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  // ---- Data generation pipeline tools ----

  const SCRIPT_DIR = "/home/mi/codes/workspace/data";
  const VOXEL_DIR = `${SCRIPT_DIR}/Sync/voxel_downsample`;

  const SAFE_VERSION = /^[\w.\-]+$/;
  const SAFE_PATH = /^\/[\w.\-/]+$/;

  function assertSafeVersion(v: string): void {
    if (!SAFE_VERSION.test(v)) throw new Error(`Unsafe version string: ${v}`);
  }

  function assertSafeRemotePath(p: string): void {
    if (!SAFE_PATH.test(p)) throw new Error(`Unsafe path rejected: ${p}`);
  }

  const datasetListVersions = tool(
    "dataset_list_versions",
    "List available dataset versions from the deep_data API for a given task type. Returns version strings sorted newest first.",
    {
      task: z.enum(["FS", "OD"]).describe("Task type: FS for free space/segmentation, OD for object detection/flow"),
    },
    async (args) => {
      const taskEnum = args.task === "FS" ? "FS" : "OD_3D";
      const snippet = [
        `import json`,
        `from deep_data.projects.dataset.core.dataset_manager import DatasetManager`,
        `from deep_data.projects.dataset.core.dataset import Task`,
        `manager = DatasetManager()`,
        `infos = manager.list_datasets_by_task(Task.${taskEnum})`,
        `result = [{"version": i.version, "name": getattr(i, "name", i.version)} for i in infos]`,
        `result.sort(key=lambda x: x["version"], reverse=True)`,
        `print(json.dumps(result[:20]))`,
      ].join("\n");

      try {
        const raw = await sshExecAsync(`python3 -c '${snippet.replace(/'/g, "'\"'\"'")}'`, 30_000);
        const versions = JSON.parse(raw);
        return { content: [{ type: "text" as const, text: JSON.stringify(versions, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to list versions: ${e}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetIncrementalStats = tool(
    "dataset_incremental_stats",
    "Compare two dataset versions and return incremental statistics (new clips minus old clips, grouped by sensor_type). Use before dataset_generate to show the user what will be generated.",
    {
      task: z.enum(["FS", "OD"]).describe("Task type"),
      new_version: z.string().describe("New dataset version string (e.g. '20260417-1818')"),
      old_version: z.string().optional().describe("Old dataset version to subtract for incremental. Omit for full dataset stats."),
    },
    async (args) => {
      try { assertSafeVersion(args.new_version); } catch (e) {
        return { content: [{ type: "text" as const, text: String(e) }], isError: true };
      }
      if (args.old_version) {
        try { assertSafeVersion(args.old_version); } catch (e) {
          return { content: [{ type: "text" as const, text: String(e) }], isError: true };
        }
      }
      const taskEnum = args.task === "FS" ? "FS" : "OD_3D";
      const oldV = args.old_version || "";
      const snippet = [
        `import json`,
        `from collections import Counter`,
        `from deep_data.projects.dataset.core.dataset_manager import DatasetManager`,
        `from deep_data.projects.dataset.core.dataset import Task`,
        `manager = DatasetManager()`,
        `task = Task.${taskEnum}`,
        `new_data = list(manager.load_dataset(task=task, version="${args.new_version}"))`,
        `old_clip_adrns = set()`,
        oldV ? `old_data = list(manager.load_dataset(task=task, version="${oldV}"))` : `old_data = []`,
        oldV ? `old_clip_adrns = set(c["clip_adrn"] for c in old_data)` : `pass`,
        `incremental = [c for c in new_data if c["clip_adrn"] not in old_clip_adrns]`,
        `by_sensor = Counter(c.get("sensor_type", "unknown") for c in incremental)`,
        `result = {`,
        `  "task": "${args.task}",`,
        `  "new_version": "${args.new_version}",`,
        `  "old_version": "${oldV}" or None,`,
        `  "total_new_clips": len(new_data),`,
        `  "total_old_clips": len(old_clip_adrns),`,
        `  "incremental_clips": len(incremental),`,
        `  "by_sensor_type": dict(by_sensor),`,
        `}`,
        `print(json.dumps(result))`,
      ].join("\n");

      try {
        const raw = await sshExecAsync(`python3 -c '${snippet.replace(/'/g, "'\"'\"'")}'`, 120_000);
        const stats = JSON.parse(raw);
        return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to get incremental stats: ${e}` }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const datasetGenerate = tool(
    "dataset_generate",
    "Launch the full data generation pipeline on the remote machine: anno_to_pkl → manifest → voxel_downsample. ONLY call after the user explicitly confirms. The monitor auto-advances through steps.",
    {
      task: z.enum(["FS", "OD"]).describe("Task type"),
      new_version: z.string().describe("New version string"),
      old_version: z.string().optional().describe("Old version for incremental (omit for full)"),
      sensor_type: z.array(z.string()).describe("Sensor type filters, e.g. ['L3-AT720-FT']"),
      output_dir: z.string().describe("Remote output base directory"),
      output_dir_name: z.string().describe("Subdirectory name (e.g. '0417')"),
      prefix: z.string().describe("File prefix (e.g. 'l3_at720', 'L3_od_at720')"),
      num_threads: z.number().optional().describe("Number of threads (default 512)"),
      debug_mode: z.boolean().optional().describe("Single-thread debug mode (default false)"),
      name: z.string().optional().describe("Human-readable job name"),
      include_demand: z.array(z.string()).optional().describe("FS only: include demand name filters"),
      exclude_demand: z.array(z.string()).optional().describe("FS only: exclude demand name filters"),
      skip_voxel_downsample: z.boolean().optional().describe("Skip voxel downsample step (default false)"),
    },
    async (args) => {
      try {
        assertSafeVersion(args.new_version);
        if (args.old_version) assertSafeVersion(args.old_version);
        assertSafeRemotePath(args.output_dir);
        if (!SAFE_VERSION.test(args.output_dir_name)) throw new Error(`Unsafe output_dir_name: ${args.output_dir_name}`);
        if (!SAFE_VERSION.test(args.prefix)) throw new Error(`Unsafe prefix: ${args.prefix}`);
        for (const st of args.sensor_type) {
          if (!SAFE_VERSION.test(st)) throw new Error(`Unsafe sensor_type: ${st}`);
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: String(e) }], isError: true };
      }

      const existingJob = db.raw
        .prepare("SELECT id, name FROM dataset_jobs WHERE task_type = ? AND status = 'running'")
        .get(args.task) as any;
      if (existingJob) {
        return {
          content: [{ type: "text" as const, text: `A ${args.task} generation job is already running: #${existingJob.id} "${existingJob.name}". Wait for it to finish or mark it failed.` }],
          isError: true,
        };
      }

      const threads = args.num_threads ?? 512;
      const debug = args.debug_mode ?? false;
      const jobName = args.name || `${args.task}_${args.new_version}`;

      let yamlContent: string;
      if (args.task === "FS") {
        const lines = [
          `dataset_list:`,
          `  - "${args.new_version}"`,
          `old_dataset_list:`,
        ];
        if (args.old_version) {
          lines.push(`  - "${args.old_version}"`);
        } else {
          lines.push(`  # none`);
        }
        lines.push(
          `num_threads:`,
          `  ${threads}`,
          `output_dir:`,
          `  "${args.output_dir}"`,
          `output_dir_name:`,
          `  - "${args.output_dir_name}"`,
          `sensor_type:`,
        );
        for (const st of args.sensor_type) lines.push(`  - "${st}"`);
        lines.push(`prefix:`, `  "${args.prefix}"`);
        lines.push(`exclude_demand:`);
        if (args.exclude_demand?.length) {
          for (const d of args.exclude_demand) lines.push(`  - "${d}"`);
        } else {
          lines.push(`  []`);
        }
        lines.push(`include_demand:`);
        if (args.include_demand?.length) {
          for (const d of args.include_demand) lines.push(`  - "${d}"`);
        } else {
          lines.push(`  []`);
        }
        lines.push(`debug_mode:`, `  ${debug ? "True" : "False"}`);
        yamlContent = lines.join("\n");
      } else {
        const lines = [
          `json_dir:`,
          `  "/high_perf_store3/l3_data/private-datasets/perception/L3_OD_Dataset/"`,
          `dataset_list:`,
          `  - "${args.new_version}"`,
          `old_dataset_list:`,
        ];
        if (args.old_version) {
          lines.push(`  - "${args.old_version}"`);
        } else {
          lines.push(`  # none`);
        }
        lines.push(
          `num_threads:`,
          `  "${threads}"`,
          `output_dir:`,
          `  ${args.output_dir}`,
          `output_dir_names:`,
          `  - "${args.output_dir_name}"`,
          `prefix:`,
          `  "${args.prefix}"`,
          `sensor_type:`,
        );
        for (const st of args.sensor_type) lines.push(`  - "${st}"`);
        lines.push(`debug_mode:`, `  ${debug ? "True" : "False"}`);
        yamlContent = lines.join("\n");
      }

      const configFile = args.task === "FS" ? "L3_FS_anno_to_pkl" : "L3_od_data_to_pkl";
      const script = args.task === "FS" ? "raw_L3_FS_anno_to_pkl.py" : "raw_L3_OD_anno_to_pkl.py";

      const result = db.raw
        .prepare(
          `INSERT INTO dataset_jobs (name, config, status, task_type, new_version, old_version, step, sensor_type, output_dir, skip_voxel)
           VALUES (?, ?, 'running', ?, ?, ?, 'anno_to_pkl', ?, ?, ?)`,
        )
        .run(
          jobName, yamlContent, args.task,
          args.new_version, args.old_version ?? null,
          JSON.stringify(args.sensor_type),
          `${args.output_dir}/${args.output_dir_name}`,
          args.skip_voxel_downsample ? 1 : 0,
        );
      const jobId = Number(result.lastInsertRowid);

      try {
        const configPath = `/tmp/lidar_agent_datagen_${jobId}.yaml`;
        const logPath = `/tmp/lidar_agent_datagen_${jobId}.log`;

        await sshExecAsync(`cat > ${configPath} << 'EOFCFG'\n${yamlContent}\nEOFCFG`, 5000);
        await sshExecAsync(`cp ${configPath} ${SCRIPT_DIR}/config/${configFile}.yaml`, 5000);

        const pidStr = await sshExecAsync(
          `cd ${SCRIPT_DIR} && nohup python3 ${script} > ${logPath} 2>&1 & echo $!`,
          10_000,
        );
        const remotePid = parseInt(pidStr.split("\n").pop() || "", 10);
        if (!remotePid || isNaN(remotePid)) {
          db.raw.prepare("UPDATE dataset_jobs SET status = 'failed' WHERE id = ?").run(jobId);
          return { content: [{ type: "text" as const, text: `Failed to get PID from remote for job #${jobId}` }], isError: true };
        }

        db.raw
          .prepare("UPDATE dataset_jobs SET remote_pid = ?, log_path = ? WHERE id = ?")
          .run(remotePid, logPath, jobId);

        notify("Dataset Generation", `Job #${jobId} "${jobName}" started (${args.task}, PID ${remotePid})`, "info");

        const steps = args.skip_voxel_downsample
          ? "anno_to_pkl → manifest"
          : "anno_to_pkl → manifest → voxel_downsample";

        return {
          content: [{
            type: "text" as const,
            text: [
              `Dataset generation job #${jobId} started.`,
              `Task: ${args.task}`,
              `Version: ${args.new_version}${args.old_version ? ` (incremental from ${args.old_version})` : " (full)"}`,
              `Sensors: ${args.sensor_type.join(", ")}`,
              `Output: ${args.output_dir}/${args.output_dir_name}`,
              `Remote PID: ${remotePid}`,
              `Log: ${logPath}`,
              `Pipeline: ${steps}`,
              ``,
              `The monitor will auto-advance through steps.`,
            ].join("\n"),
          }],
        };
      } catch (e) {
        db.raw.prepare("UPDATE dataset_jobs SET status = 'failed' WHERE id = ?").run(jobId);
        return { content: [{ type: "text" as const, text: `Failed to launch job #${jobId}: ${e}` }], isError: true };
      }
    },
  );

  const datasetGenerateStatus = tool(
    "dataset_generate_status",
    "Check status of a dataset generation job. Shows current step, remote log tail, and generated file count.",
    {
      job_id: z.number().optional().describe("Job ID (omit for latest)"),
    },
    async (args) => {
      const job = (args.job_id
        ? db.raw.prepare("SELECT * FROM dataset_jobs WHERE id = ?").get(args.job_id)
        : db.raw.prepare("SELECT * FROM dataset_jobs ORDER BY id DESC LIMIT 1").get()) as any;
      if (!job) return { content: [{ type: "text" as const, text: "No dataset jobs found" }], isError: true };

      const info: Record<string, any> = {
        id: job.id,
        name: job.name,
        status: job.status,
        task_type: job.task_type,
        step: job.step,
        new_version: job.new_version,
        old_version: job.old_version,
        output_dir: job.output_dir,
        manifest_pkl: job.manifest_pkl,
        started_at: job.started_at,
        completed_at: job.completed_at,
      };

      if (job.status === "running" && job.log_path) {
        try {
          info.log_tail = await sshExecAsync(`tail -20 "${job.log_path}" 2>/dev/null`, 10_000);
        } catch { /* ignore */ }
      }

      if (job.output_dir) {
        try {
          const count = await sshExecAsync(
            `find "${job.output_dir}" -name "*.bin" -type f 2>/dev/null | wc -l`,
            15_000,
          );
          info.generated_files = parseInt(count.trim(), 10) || 0;
        } catch { /* ignore */ }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  return createMcpServer({
    name: "lidar",
    version: "1.0.0",
    tools: [
      listExperiments, getEvalResults, compareExperiments, readConfig, proposeChange,
      listBranches, getBranchDiff, getDataStatus, submitPipeline, getPipelineStatus,
      registerTool, trtBuild, trtBuildL4, trtBuildStatus, trtBuildThor, trtBuildThorStatus, cloudmlUploadPreview, cloudmlUploadExecute, trtDeclineUpload,
      datasetList, datasetScan, datasetRefreshStats, datasetVisualize, datasetVisualizeStop,
      datasetListVersions, datasetIncrementalStats, datasetGenerate, datasetGenerateStatus,
    ],
  });
}
