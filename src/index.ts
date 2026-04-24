import express from "express";
import expressWs from "express-ws";
import { execFileSync } from "child_process";
import path from "path";
import { initRuntime } from "./agent/runtime.js";
import { createDb } from "./db.js";

initRuntime();
import { ExperimentManager } from "./experiment/manager.js";
import { createAgentTools } from "./agent/tools.js";
import { AgentSession } from "./agent/session.js";
import { mountAgentMcpHttp } from "./agent/mcp-http.js";
import { experimentRoutes } from "./routes/experiments.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { BranchMerger } from "./branch/merger.js";
import { branchRoutes } from "./routes/branches.js";
import { DataUpdateScheduler } from "./data-update/scheduler.js";
import { dataUpdateRoutes } from "./routes/data-update.js";
import { chatRoutes } from "./routes/chat.js";
import { PipelineBridge } from "./pipeline/bridge.js";
import { toolRoutes } from "./routes/tools.js";
import { datasetRoutes } from "./routes/datasets.js";
import { eventBus, type AppNotification } from "./events.js";
import { startTrtBuildMonitor } from "./trt/monitor.js";

const PORT = parseInt(process.env.PORT || "3000");
const DB_PATH = process.env.DB_PATH || "./data/lidar-agent-unclassified.db";

const db = createDb(DB_PATH);
const mgr = new ExperimentManager(db);
const bridge = new PipelineBridge(path.resolve("pipeline"));
const merger = new BranchMerger(process.env.MMDET3D_ROOT || "../mmdet3d");
const toolDeps = { mgr, merger, bridge, db };
const dataScheduler = new DataUpdateScheduler(db, bridge, path.resolve("pipeline"));
startTrtBuildMonitor(db);

function normalizeVersion(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  return /^v/i.test(v) ? v : `v${v}`;
}

function normalizeIntentText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function extractVersion(text: string): string | null {
  const m = text.match(/\b(v?\d+(?:\.\d+){0,3})\b/i);
  if (!m) return null;
  return normalizeVersion(m[1]);
}

function isLikelyAffirmative(text: string): boolean {
  const t = normalizeIntentText(text);
  return /^(ok|okay|yes|y|it is ok|it's ok|its ok|looks good|go ahead|upload|confirm|fine|do it)$/i.test(t);
}

function isLikelyNegative(text: string): boolean {
  const t = normalizeIntentText(text);
  return /\b(no|n|skip|cancel|decline|stop upload|do not upload|don't upload|dont upload)\b/i.test(t);
}

function isLikelyUploadConfirmReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Questions are never confirmations, even if they mention "upload" / "cloudml".
  if (/\?/.test(t)) return false;
  if (/\b(what|why|which|how|where|when|who|是什么|是啥|怎么|为什么|吗|呢)\b/i.test(t)) return false;
  if (isLikelyAffirmative(t)) return true;
  if (isLikelyNegative(t)) return true;
  // Explicit upload directive, e.g. "upload v1.2.0", "go ahead and upload".
  if (/\b(upload|cloud\s*-?\s*ml|cloudml)\b/i.test(t) && /\b(yes|ok|okay|go|do|confirm|please|now)\b/i.test(t)) return true;
  if (/\bversion\s+v?\d/i.test(t) && /\b(upload|cloud\s*-?\s*ml|cloudml|confirm|yes|ok)\b/i.test(t)) return true;
  return false;
}

function isLikelyBuildRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\b(l4|trt|engine|checkpoint|vepfs|pth)\b/.test(t) && /\b(build|submit|start|retry|model)\b/.test(t)) return true;
  if (/\.pth\b/.test(t)) return true;
  if (/\bmodel\s+is\b/.test(t)) return true;
  return false;
}

function extractBuildIdFromUploadConfirmBody(body: string): number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as any;
    const id = Number(parsed?.upload_info?.build_id ?? parsed?.prefilled_json_template?.build_id);
    if (Number.isFinite(id) && id > 0) return id;
  } catch {
    // ignore json parse failures
  }
  const m = body.match(/\bbuild\s*#\s*(\d+)\b/i);
  if (m) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

function assistantClaimedToolCancellation(text: string): boolean {
  return /\b(cancelled|canceled|not submitted|was not submitted|tool call was canceled|tool call was cancelled)\b/i.test(text);
}

function normalizeL4Checkpoint(checkpoint: string): string {
  const vepfsPthBase = "/high_perf_store3/l3_data/wuwenda/centerpoint/pth_dir";
  return checkpoint.startsWith("/") ? checkpoint : `${vepfsPthBase}/${checkpoint}`;
}

function buildL4AcceptedMessage(build: any): string {
  const fields = [
    `L4 TRT build is accepted by the backend.`,
    `Build ID: #${build.id}`,
    `Status: ${build.status}`,
    build.task_id ? `Volc task: ${build.task_id}` : "Volc task: submitting in backend",
    build.instance_id ? `Instance: ${build.instance_id}` : "",
    build.remote_out_dir ? `Remote output: ${build.remote_out_dir}` : "",
  ].filter(Boolean);
  return `\n\nCorrection from backend state:\n${fields.map((f) => `- ${f}`).join("\n")}`;
}

function deriveL4BuildName(checkpoint: string): string {
  const parts = checkpoint.split("/");
  const parent = (parts[parts.length - 2] || "lite").replace(/[^A-Za-z0-9._-]+/g, "_");
  const file = parts[parts.length - 1] || "model.pth";
  const epoch = file.match(/epoch_(\d+)\.pth$/i);
  if (epoch) return `${parent}_ep${epoch[1]}_L4`;
  return `${parent}_${file.replace(/\.pth$/i, "")}_L4`;
}

function parseL4BuildRequest(text: string): { model: "lite" | "large"; checkpoint: string; name: string } | null {
  const t = text.trim();
  if (!t) return null;
  if (!/\b(l4|trt|engine)\b/i.test(t) || !/\b(build|submit|start|retry)\b/i.test(t)) return null;

  const modelMatch = t.match(/\bmodel\s*(?:is|=|:)?\s*["']?(lite|large)\b/i);
  const ckptMatch = t.match(/(\/[A-Za-z0-9._\-\/]+\.pth|[A-Za-z0-9._\-\/]+\.pth)/i);
  if (!modelMatch || !ckptMatch) return null;

  const model = modelMatch[1].toLowerCase() as "lite" | "large";
  const checkpoint = normalizeL4Checkpoint(ckptMatch[1]);
  const name = deriveL4BuildName(checkpoint);
  return { model, checkpoint, name };
}

const { app } = expressWs(express());
app.use(express.json());
const mcpUrl = process.env.AGENT_MCP_URL || `http://127.0.0.1:${PORT}/mcp`;
mountAgentMcpHttp(app, () => createAgentTools(toolDeps));

const wsClients = new Set<import("ws").WebSocket>();
const wsPendingUploadBuild = new Map<import("ws").WebSocket, number>();
eventBus.on("notification", (n: AppNotification) => {
  const payload = JSON.stringify({ type: "notification", ...n });
  const uploadBuildId = n.title === "TRT Upload Confirm" ? extractBuildIdFromUploadConfirmBody(n.body) : null;
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
      if (uploadBuildId) wsPendingUploadBuild.set(client, uploadBuildId);
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/experiments", experimentRoutes(mgr));
app.use("/api/pipeline", pipelineRoutes(db));
app.use("/api/branches", branchRoutes(merger));
app.use("/api/data-update", dataUpdateRoutes(dataScheduler));
app.use("/api/chat", chatRoutes(db));
app.use("/api/tools", toolRoutes(db));
app.use("/api/datasets", datasetRoutes(db));

app.ws("/chat", (ws, _req) => {
  wsClients.add(ws);
  ws.on("close", () => {
    wsClients.delete(ws);
    wsPendingUploadBuild.delete(ws);
  });

  let currentSessionId: number | null = null;
  let assistantBuffer = "";
  let agentSession = new AgentSession(mcpUrl);
  const getSession = db.raw.prepare("SELECT id, codex_thread_id FROM chat_sessions WHERE id = ?");
  const createSession = db.raw.prepare("INSERT INTO chat_sessions (title) VALUES ('New Chat')");
  const insertMessage = db.raw.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)");
  const touchSession = db.raw.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?");
  const setThreadId = db.raw.prepare("UPDATE chat_sessions SET codex_thread_id = ? WHERE id = ? AND codex_thread_id IS NULL");
  const makeAgentSession = (sessionId: number | null): AgentSession =>
    new AgentSession(mcpUrl, {
      threadId: sessionId ? ((getSession.get(sessionId) as any)?.codex_thread_id ?? undefined) : undefined,
      onThreadStarted: (tid) => { if (sessionId) setThreadId.run(tid, sessionId); },
    });
  const getPendingUploadById = db.raw.prepare(
    "SELECT id, model, name, version, engine_path FROM trt_builds WHERE id = ? AND status = 'completed' AND upload_status = 'pending_confirm'",
  );
  const getLatestPendingUpload = db.raw.prepare(
    "SELECT id, model, name, version, engine_path FROM trt_builds WHERE status = 'completed' AND upload_status = 'pending_confirm' ORDER BY id DESC LIMIT 1",
  );
  const getLatestL4BuildAfter = db.raw.prepare(
    "SELECT * FROM trt_builds WHERE id > ? AND platform = 'L4' ORDER BY id DESC LIMIT 1",
  );
  const getMatchingL4BuildAfter = db.raw.prepare(
    "SELECT * FROM trt_builds WHERE id > ? AND platform = 'L4' AND model = ? AND checkpoint = ? ORDER BY id DESC LIMIT 1",
  );

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type !== "user_message") return;
      if (typeof msg.content !== "string" || !msg.content.trim()) return;

      // Get or create session; reset agent on session switch.
      if (msg.session_id != null) {
        const requestedId = Number(msg.session_id);
        const exists = Number.isFinite(requestedId) && !!getSession.get(requestedId);
        if (exists) {
          if (requestedId !== currentSessionId) {
            currentSessionId = requestedId;
            agentSession = makeAgentSession(currentSessionId);
          }
        } else {
          // Client may hold a stale/deleted session id: create a new one instead of crashing.
          const result = createSession.run();
          currentSessionId = Number(result.lastInsertRowid);
          agentSession = makeAgentSession(currentSessionId);
          ws.send(JSON.stringify({ type: "session_created", session_id: currentSessionId }));
        }
      }
      if (!currentSessionId) {
        const result = createSession.run();
        currentSessionId = Number(result.lastInsertRowid);
        agentSession = makeAgentSession(currentSessionId);
        ws.send(JSON.stringify({ type: "session_created", session_id: currentSessionId }));
      }

      // Save user message
      insertMessage.run(currentSessionId, "user", msg.content);
      touchSession.run(currentSessionId);

      // Auto-title from first message
      const msgCount = (db.raw.prepare("SELECT COUNT(*) as c FROM chat_messages WHERE session_id = ?").get(currentSessionId) as any).c;
      if (msgCount === 1) {
        const title = msg.content.substring(0, 50) + (msg.content.length > 50 ? "..." : "");
        db.raw.prepare("UPDATE chat_sessions SET title = ? WHERE id = ?").run(title, currentSessionId);
      }

      // Deterministic fast-path for explicit L4 build requests.
      // This avoids Codex/MCP cancellation issues for task submission.
      const directL4 = parseL4BuildRequest(msg.content);
      if (directL4) {
        const startArgs = [
          "scripts/trt_build_l4_start.sh",
          "--model",
          directL4.model,
          "--checkpoint",
          directL4.checkpoint,
          "--name",
          directL4.name,
        ];
        try {
          const out = execFileSync("bash", startArgs, {
            cwd: path.resolve("."),
            encoding: "utf-8",
            env: process.env,
          });
          const buildIdMatch = out.match(/build_id=(\d+)/);
          const taskIdMatch = out.match(/task_id=(t-\S+)/);
          const outDirMatch = out.match(/out_dir=(.+)/);
          const buildId = buildIdMatch ? Number(buildIdMatch[1]) : null;
          const taskId = taskIdMatch ? taskIdMatch[1] : null;
          const outDir = outDirMatch ? outDirMatch[1] : null;
          const text = buildId
            ? `L4 TRT build submitted via backend.\n- Build ID: #${buildId}\n- Task ID: ${taskId ?? "(pending)"}\n- Model: ${directL4.model}\n- Checkpoint: ${directL4.checkpoint}\n- Output: ${outDir ?? "(pending)"}`
            : `L4 TRT build submit started via backend (task_id=${taskId ?? "unknown"}).`;
          ws.send(JSON.stringify({ type: "tool_call", content: JSON.stringify({ name: "backend__trt_build_l4", input: directL4 }) }));
          ws.send(JSON.stringify({ type: "text", content: text }));
          ws.send(JSON.stringify({ type: "done", content: "" }));
          insertMessage.run(currentSessionId, "tool", JSON.stringify({ name: "backend__trt_build_l4", input: directL4 }));
          insertMessage.run(currentSessionId, "assistant", text);
          return;
        } catch (e: any) {
          const errText = `Failed to submit L4 TRT build via backend: ${String(e?.stderr || e?.message || e)}`;
          ws.send(JSON.stringify({ type: "error", content: errText }));
          ws.send(JSON.stringify({ type: "done", content: "" }));
          insertMessage.run(currentSessionId, "assistant", errText);
          return;
        }
      }

      let effectiveUserPrompt = msg.content;
      let pending: any = null;
      const hintedBuildId = wsPendingUploadBuild.get(ws);
      if (hintedBuildId) {
        pending = getPendingUploadById.get(hintedBuildId) as any;
      }
      if (!pending) {
        pending = getLatestPendingUpload.get() as any;
      }
      if (pending && !isLikelyBuildRequest(msg.content) && isLikelyUploadConfirmReply(msg.content)) {
        const defaultVersion = normalizeVersion(String(pending.version || "v1.0.0"));
        const userVersion = extractVersion(msg.content);
        const confirm = !isLikelyNegative(msg.content);
        const buildId = Number(pending.id);
        if (confirm) {
          const execArgs = {
            build_id: buildId,
            version: userVersion || defaultVersion,
            app_label: "ipc3090",
          };
          effectiveUserPrompt = [
            "The user has explicitly confirmed the CloudML upload.",
            `Pending build: #${buildId} (${pending.name || pending.model})`,
            `User reply: "${msg.content}"`,
            `Mapped execute args: ${JSON.stringify(execArgs)}`,
            "Call cloudml_upload_execute immediately with these args and return the result.",
            "Do not ask generic follow-up questions.",
          ].join("\n");
        } else {
          effectiveUserPrompt = [
            "The user has declined the CloudML upload.",
            `Pending build: #${buildId} (${pending.name || pending.model})`,
            `User reply: "${msg.content}"`,
            `Call trt_decline_upload with {"build_id": ${buildId}} and return the result.`,
            "Do not ask generic follow-up questions.",
          ].join("\n");
        }
        wsPendingUploadBuild.delete(ws);
      }

      assistantBuffer = "";
      const turnBuildFloor = Number((db.raw.prepare("SELECT COALESCE(MAX(id), 0) as id FROM trt_builds").get() as any).id);
      let lastL4ToolInput: { model?: string; checkpoint?: string } | null = null;

      for await (const event of agentSession.chat(effectiveUserPrompt)) {
        if (event.type === "text") {
          ws.send(JSON.stringify(event));
          assistantBuffer += event.content;
        } else if (event.type === "tool_call") {
          ws.send(JSON.stringify(event));
          insertMessage.run(currentSessionId, "tool", event.content);
          try {
            const parsed = JSON.parse(event.content) as any;
            if (parsed?.name === "mcp__lidar__trt_build_l4" && parsed.input) {
              lastL4ToolInput = {
                model: parsed.input.model,
                checkpoint: parsed.input.checkpoint,
              };
            }
          } catch {
            // ignore malformed tool telemetry
          }
        } else if (event.type === "tool_progress" || event.type === "tool_result" || event.type === "error") {
          ws.send(JSON.stringify(event));
        } else if (event.type === "done") {
          if (lastL4ToolInput && assistantClaimedToolCancellation(assistantBuffer)) {
            const checkpoint = lastL4ToolInput.checkpoint ? normalizeL4Checkpoint(lastL4ToolInput.checkpoint) : "";
            const matching = checkpoint && lastL4ToolInput.model
              ? getMatchingL4BuildAfter.get(turnBuildFloor, lastL4ToolInput.model, checkpoint)
              : null;
            const latest = matching || getLatestL4BuildAfter.get(turnBuildFloor);
            if (latest) {
              const correction = buildL4AcceptedMessage(latest);
              ws.send(JSON.stringify({ type: "text", content: correction }));
              assistantBuffer += correction;
            }
          }
          if (assistantBuffer) {
            insertMessage.run(currentSessionId, "assistant", assistantBuffer);
          }
          ws.send(JSON.stringify(event));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[chat ws] message handling error:", err);
      try {
        ws.send(JSON.stringify({ type: "error", content: message }));
      } catch {
        // ignore websocket send failures
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`lidar-agent-unclassified listening on :${PORT}`);
});
