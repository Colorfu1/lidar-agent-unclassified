import express from "express";
import expressWs from "express-ws";
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
import { startDatasetJobMonitor } from "./data/monitor.js";

const PORT = parseInt(process.env.PORT || "3000");
const DB_PATH = process.env.DB_PATH || "./data/lidar-agent.db";

const db = createDb(DB_PATH);
const mgr = new ExperimentManager(db);
const bridge = new PipelineBridge(path.resolve("pipeline"));
const merger = new BranchMerger(process.env.MMDET3D_ROOT || "../mmdet3d");
const toolDeps = { mgr, merger, bridge, db };
const dataScheduler = new DataUpdateScheduler(db, bridge, path.resolve("pipeline"));
startTrtBuildMonitor(db);
startDatasetJobMonitor(db);

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

      // If a CloudML upload is pending confirmation, hint the agent so it knows
      // which build_id the user is talking about. The agent decides preview vs
      // execute vs decline from natural language per the system prompt.
      let effectiveUserPrompt = msg.content;
      const hintedBuildId = wsPendingUploadBuild.get(ws);
      const pending: any =
        (hintedBuildId && getPendingUploadById.get(hintedBuildId)) ||
        getLatestPendingUpload.get();
      if (pending) {
        effectiveUserPrompt = [
          `[context] A CloudML upload is pending confirmation: build #${pending.id} (${pending.name || pending.model}), default version ${pending.version || "v1.0.0"}.`,
          "Follow the CloudML Upload rules in the system prompt: questions → cloudml_upload_preview; explicit confirmation → cloudml_upload_execute; decline → trt_decline_upload.",
          "",
          `User message: ${msg.content}`,
        ].join("\n");
      }

      assistantBuffer = "";

      for await (const event of agentSession.chat(effectiveUserPrompt)) {
        console.log(`[chat ws] event: ${event.type}`, event.type === "error" ? event.content : "");
        if (event.type === "text") {
          ws.send(JSON.stringify(event));
          assistantBuffer += event.content;
        } else if (event.type === "tool_call") {
          ws.send(JSON.stringify(event));
          insertMessage.run(currentSessionId, "tool", event.content);
        } else if (event.type === "tool_progress" || event.type === "tool_result" || event.type === "error") {
          ws.send(JSON.stringify(event));
        } else if (event.type === "done") {
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

const server = app.listen(PORT, () => {
  console.log(`lidar-agent listening on :${PORT}`);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
