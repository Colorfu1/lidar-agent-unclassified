import { useState, useRef, useEffect, useCallback } from "react";
import { createChatSocket, fetchJSON } from "../api";
import { useNotifications } from "../hooks/useNotifications";

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolStatus?: "in_progress" | "completed" | "failed";
}

interface ChatSession {
  id: number;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function isPureHeartbeatLine(content: string, body: string): boolean {
  const escapedBody = body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\[TRT Build Heartbeat\\] ${escapedBody} \\(updated: \\d{2}:\\d{2}:\\d{2}\\)$`);
  return re.test(content);
}

function formatTrtUploadConfirmMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as any;
    if (!parsed || parsed.stage !== "upload_confirm_pending") {
      return `[TRT Upload Confirm]\n${body}`;
    }
    const buildId = parsed?.upload_info?.build_id ?? parsed?.prefilled_json_template?.build_id ?? "unknown";
    const version = parsed?.uncertain_defaults?.version ?? parsed?.prefilled_json_template?.version ?? "v1.0.0";
    const confirm = parsed?.uncertain_defaults?.confirm ?? parsed?.prefilled_json_template?.confirm ?? true;
    return (
      `[TRT Upload Confirm] Build #${buildId}\n` +
      `Uncertain fields (defaults):\n` +
      `- version: ${String(version)}\n` +
      `- confirm: ${String(confirm)}\n` +
      `Is it ok or need change?`
    );
  } catch {
    return `[TRT Upload Confirm]\n${body}`;
  }
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-surface rounded-xl px-4 py-3 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-tesla-red animate-bounce [animation-delay:0ms]" />
        <span className="w-2 h-2 rounded-full bg-tesla-red animate-bounce [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-tesla-red animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="chat-user-bubble max-w-[75%] bg-tesla-red text-white rounded-2xl rounded-br-sm px-4 py-2.5 overflow-hidden">
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words select-text">{msg.content}</p>
        </div>
      </div>
    );
  }

  if (msg.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] bg-surface/60 border border-border/50 rounded-lg px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <svg className="w-3 h-3 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-[10px] text-muted uppercase tracking-wider font-medium">Tool</span>
            {msg.toolStatus && (
              <span
                className={`text-[10px] uppercase tracking-wider font-medium ${
                  msg.toolStatus === "completed"
                    ? "text-green-400"
                    : msg.toolStatus === "failed"
                      ? "text-red-400"
                      : "text-yellow-400 animate-pulse"
                }`}
              >
                · {msg.toolStatus === "in_progress" ? "running" : msg.toolStatus}
              </span>
            )}
          </div>
          <pre className="text-xs text-muted/80 font-mono leading-relaxed whitespace-pre-wrap break-words m-0">{msg.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] bg-surface text-gray-200 rounded-2xl rounded-bl-sm px-4 py-2.5 overflow-hidden">
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
      </div>
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const showNotification = useNotifications();
  const menuRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const data = await fetchJSON<ChatSession[]>("/api/chat/sessions");
      setSessions(data);
    } catch {
      // ignore fetch errors on mount
    }
  }, []);

  const loadSessionMessages = useCallback(async (sessionId: number) => {
    try {
      const data = await fetchJSON<{ role: string; content: string }[]>(
        `/api/chat/sessions/${sessionId}/messages`
      );
      setMessages(data.map((m) => ({ role: m.role as Message["role"], content: m.content })));
    } catch {
      setMessages([]);
    }
  }, []);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowSessionMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const connectWs = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = createChatSocket();
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
    };
    ws.onclose = () => {
      setConnected(false);
      if (manualCloseRef.current) {
        manualCloseRef.current = false;
        return;
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        connectWs();
      }, 1000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "session_created") {
        setCurrentSessionId(msg.session_id);
        loadSessions();
      } else if (msg.type === "text") {
        setThinking(false);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // Never merge model stream text into TRT notification bubbles.
          if (last?.role === "assistant" && !last.content.startsWith("[TRT ")) {
            return [...prev.slice(0, -1), { ...last, content: last.content + msg.content }];
          }
          return [...prev, { role: "assistant", content: msg.content }];
        });
      } else if (msg.type === "tool_call") {
        let toolName: string | undefined;
        try { toolName = JSON.parse(msg.content)?.name; } catch { /* ignore */ }
        setMessages((prev) => [
          ...prev,
          { role: "tool", content: msg.content, toolName, toolStatus: "in_progress" },
        ]);
      } else if (msg.type === "tool_progress" || msg.type === "tool_result") {
        let toolName: string | undefined;
        let status: Message["toolStatus"];
        try {
          const parsed = JSON.parse(msg.content);
          toolName = parsed?.name;
          status = msg.type === "tool_result" ? "completed" : parsed?.status;
        } catch { /* ignore */ }
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === "tool" && m.toolName === toolName && m.toolStatus !== "completed" && m.toolStatus !== "failed") {
              const next = [...prev];
              next[i] = { ...m, toolStatus: status ?? m.toolStatus };
              return next;
            }
          }
          return prev;
        });
      } else if (msg.type === "done" || msg.type === "error") {
        setThinking(false);
        loadSessions();
      } else if (msg.type === "notification") {
        showNotification(msg.title, msg.body, msg.level);
        if (typeof msg.title === "string" && msg.title.startsWith("TRT ")) {
          const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
          const monitorText =
            msg.title === "TRT Upload Confirm"
              ? formatTrtUploadConfirmMessage(msg.body)
              : `[${msg.title}] ${msg.body} (updated: ${ts})`;
          if (msg.title === "TRT Build Heartbeat") {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (
                last?.role === "assistant" &&
                typeof msg.body === "string" &&
                isPureHeartbeatLine(last.content, msg.body)
              ) {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: monitorText };
                return next;
              }
              return [...prev, { role: "assistant", content: monitorText }];
            });
            return;
          }
          setMessages((prev) => [...prev, { role: "assistant", content: monitorText }]);
        }
      }
    };
    return ws;
  }, [loadSessions, showNotification]);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      manualCloseRef.current = true;
      wsRef.current?.close();
    };
  }, [connectWs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  function selectSession(session: ChatSession) {
    setCurrentSessionId(session.id);
    setShowSessionMenu(false);
    loadSessionMessages(session.id);
  }

  async function createNewSession() {
    setCurrentSessionId(null);
    setMessages([]);
    setShowSessionMenu(false);
  }

  async function deleteSession(e: React.MouseEvent, sessionId: number) {
    e.stopPropagation();
    await fetchJSON(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
      setMessages([]);
    }
    loadSessions();
  }

  function cancelChat() {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      manualCloseRef.current = true;
      wsRef.current.close();
    }
    connectWs();
    setThinking(false);
  }

  function send() {
    if (!input.trim() || !wsRef.current) return;
    setMessages((prev) => [...prev, { role: "user", content: input }]);
    const payload: Record<string, unknown> = { type: "user_message", content: input };
    if (currentSessionId) {
      payload.session_id = currentSessionId;
    }
    wsRef.current.send(JSON.stringify(payload));
    setInput("");
    setThinking(true);
  }

  const currentTitle = sessions.find((s) => s.id === currentSessionId)?.title || "New Chat";

  return (
    <div className="relative flex flex-col h-screen">
      <div className="shrink-0 border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-white">LiDAR Agent</h1>
          <span className="text-muted text-xs">/</span>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowSessionMenu(!showSessionMenu)}
              className="flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-surface"
            >
              <span className="max-w-[180px] truncate">{currentTitle}</span>
              <svg className="w-3.5 h-3.5 text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showSessionMenu && (
              <div className="absolute left-0 top-full mt-1 w-72 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                <button
                  onClick={createNewSession}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-tesla-red hover:bg-border/30 transition-colors border-b border-border"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  New Chat
                </button>
                <div className="max-h-64 overflow-auto">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => selectSession(s)}
                      className={`flex items-center justify-between px-3 py-2.5 text-sm cursor-pointer transition-colors group ${
                        s.id === currentSessionId
                          ? "bg-tesla-red/10 text-white"
                          : "text-gray-300 hover:bg-border/30"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{s.title}</div>
                        <div className="text-[10px] text-muted mt-0.5">
                          {s.message_count} messages
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteSession(e, s.id)}
                        className="shrink-0 p-1 text-muted hover:text-red-400 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {sessions.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted text-center">No sessions yet</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {thinking && (
            <span className="text-tesla-red flex items-center gap-1.5 animate-pulse">
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Working...
            </span>
          )}
          <span className={`flex items-center gap-1.5 ${connected ? "text-green-400" : "text-muted"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-muted"}`} />
            {connected ? "Connected" : "Connecting"}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-3">
        {messages.length === 0 && !thinking && (
          <div className="text-center text-muted mt-24">
            <p className="text-base">Ask about your experiments</p>
            <p className="text-xs mt-1.5 opacity-60">Compare results, diagnose regressions, propose fixes</p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} />
        ))}
        {thinking && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex gap-2">
          <input
            className="chat-input flex-1 bg-surface border border-border rounded-xl px-4 py-2.5 text-sm text-white placeholder-muted focus:outline-none focus:border-tesla-red transition-colors"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={connected ? "Ask about experiments..." : "Connecting..."}
            disabled={!connected}
          />
          {thinking ? (
            <button
              onClick={cancelChat}
              className="bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!connected || !input.trim()}
              className="bg-tesla-red hover:bg-tesla-red-hover disabled:opacity-30 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
