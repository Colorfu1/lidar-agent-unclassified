import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExperimentManager } from "../experiment/manager.js";
import type { BranchMerger } from "../branch/merger.js";
import type { PipelineBridge } from "../pipeline/bridge.js";
import type { Db } from "../db.js";
import { notify } from "../events.js";
import { execFile, execFileSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

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
  return {
    build_id: Number(build.id),
    model: String(build.model || ""),
    name: String(build.name || build.model || ""),
    engine_path: enginePath,
    upload_dir: enginePath ? path.join(path.dirname(enginePath), "cloudml_upload") : "",
    platform: "ipc3090",
    runtime: "trt108",
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

function submitL4BuildInBackground(db: Db, buildId: number, args: { model: string; checkpoint: string; name: string }): void {
  const submitLogPath = path.join(ensureRuntimeLogDir(), `trt-build-${buildId}.l4-submit.log`);
  const submitArgs = ["scripts/trt_build_l4_submit.py", "--model", args.model, "--checkpoint", args.checkpoint, "--name", args.name];
  const child = execFile(
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
        return;
      }

      db.raw
        .prepare("UPDATE trt_builds SET task_id = ?, remote_out_dir = ? WHERE id = ? AND status = 'running'")
        .run(taskId, outDir || null, buildId);
      notify("TRT Build Step", `L4 build #${buildId} submitted to Volc task_id=${taskId}`, "info");
    },
  );
  child.unref();
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

      const startArgs = ["scripts/trt_build_start.sh", "--model", args.model, "--checkpoint", resolvedCheckpoint, "--detach"];
      if (args.name) startArgs.push("--name", args.name);
      try {
        const out = execFileSync("bash", startArgs, {
          cwd: path.resolve("."),
          encoding: "utf-8",
          env: process.env,
        });
        const buildIdMatch = out.match(/build_id=(\d+)/);
        const buildId = buildIdMatch ? Number(buildIdMatch[1]) : null;
        return {
          content: [{
            type: "text" as const,
            text: buildId
              ? `TRT build #${buildId} started (${args.model}). I will monitor step status and heartbeat until completion/failure.`
              : `TRT build started (${args.model}). I will monitor step status and heartbeat until completion/failure.`,
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to start TRT build: ${String(e?.stderr || e?.message || e)}`,
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
        submitL4BuildInBackground(db, buildId, { model: args.model, checkpoint, name });
        return {
          content: [{
            type: "text" as const,
            text: `L4 TRT build #${buildId} accepted locally (model=${args.model}). Volc submission is running in the backend; I will notify with task_id when accepted and then monitor until completion/failure.`,
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to submit L4 TRT build: ${String(e?.stderr || e?.message || e)}`,
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

  return createMcpServer({
    name: "lidar",
    version: "1.0.0",
    tools: [
      listExperiments, getEvalResults, compareExperiments, readConfig, proposeChange,
      listBranches, getBranchDiff, getDataStatus, submitPipeline, getPipelineStatus,
      registerTool, trtBuild, trtBuildL4, trtBuildStatus, cloudmlUploadPreview, cloudmlUploadExecute, trtDeclineUpload,
    ],
  });
}
