import { Codex, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { SYSTEM_PROMPT } from "./prompts.js";
import { getCodexOptions, getCodexThreadOptions } from "./runtime.js";

export interface StreamMessage {
  type: "text" | "tool_call" | "tool_progress" | "tool_result" | "done" | "error";
  content: string;
}

function toolDisplayName(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  return `mcp__${item.server}__${item.tool}`;
}

function buildPrompt(userMessage: string): string {
  return [
    "System instructions for this LiDAR assistant session:",
    SYSTEM_PROMPT,
    "",
    "Codex runtime constraints:",
    "- Use only the lidar MCP tools for LiDAR data, experiment, TRT, and CloudML actions.",
    "- Do not run shell commands, edit files, or use non-lidar tools for this chat.",
    "- If a needed operation is not available as a lidar MCP tool, explain the limitation.",
    "",
    "User message:",
    userMessage,
  ].join("\n");
}

export class AgentSession {
  private codex: Codex;
  private thread: Thread;
  private threadId: string | null = null;
  private onThreadStarted?: (threadId: string) => void;

  constructor(mcpUrl: string, options?: { threadId?: string; onThreadStarted?: (threadId: string) => void }) {
    this.codex = new Codex(getCodexOptions(mcpUrl));
    const threadOptions = getCodexThreadOptions();
    this.thread = options?.threadId
      ? this.codex.resumeThread(options.threadId, threadOptions)
      : this.codex.startThread(threadOptions);
    if (options?.threadId) this.threadId = options.threadId;
    this.onThreadStarted = options?.onThreadStarted;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async *chat(userMessage: string): AsyncGenerator<StreamMessage> {
    try {
      const { events } = await this.thread.runStreamed(buildPrompt(userMessage));
      for await (const event of events) {
        yield* this.processEvent(event);
      }
      yield { type: "done", content: "" };
    } catch (e) {
      yield { type: "error", content: String(e) };
    }
  }

  private *processEvent(event: ThreadEvent): Generator<StreamMessage> {
    if (event.type === "thread.started") {
      this.threadId = event.thread_id;
      this.onThreadStarted?.(event.thread_id);
      return;
    }

    if (event.type === "turn.failed") {
      yield { type: "error", content: event.error.message };
      return;
    }

    if (event.type === "error") {
      yield { type: "error", content: event.message };
      return;
    }

    if (event.type === "item.started" && event.item.type === "mcp_tool_call") {
      yield {
        type: "tool_call",
        content: JSON.stringify({
          name: toolDisplayName(event.item),
          input: event.item.arguments,
        }),
      };
      return;
    }

    if (event.type === "item.updated" && event.item.type === "mcp_tool_call") {
      yield {
        type: "tool_progress",
        content: JSON.stringify({
          name: toolDisplayName(event.item),
          status: event.item.status,
        }),
      };
      return;
    }

    if (event.type !== "item.completed") return;

    const item = event.item;
    if (item.type === "agent_message") {
      yield { type: "text", content: item.text };
    } else if (item.type === "mcp_tool_call") {
      if (item.status === "failed") {
        const msg = item.error?.message ?? "failed";
        yield {
          type: "error",
          content: `${toolDisplayName(item)}: ${msg}`,
        };
        return;
      }
      yield {
        type: "tool_result",
        content: JSON.stringify({
          name: toolDisplayName(item),
          result: item.result ?? null,
        }),
      };
    } else if (item.type === "error") {
      yield { type: "error", content: item.message };
    } else if (item.type === "command_execution") {
      yield {
        type: "error",
        content: `Blocked unexpected shell command attempt: ${item.command}`,
      };
    }
  }
}
