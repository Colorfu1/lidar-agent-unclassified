import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";

let codexHome: string | undefined;

function prepareCodexHome(): string {
  const runtimeDir = path.join(process.cwd(), ".codex-runtime");
  mkdirSync(runtimeDir, { recursive: true });

  const userCodexDir = path.join(homedir(), ".codex");
  for (const filename of ["auth.json", "version.json"]) {
    const src = path.join(userCodexDir, filename);
    const dst = path.join(runtimeDir, filename);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      copyFileSync(src, dst);
    } catch {
      console.warn(`Failed to copy ${src} -> ${dst}`);
    }
  }

  const configPath = path.join(runtimeDir, "config.toml");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      [
        `model = "${process.env.AGENT_MODEL || "gpt-5.4"}"`,
        `model_reasoning_effort = "${process.env.AGENT_REASONING_EFFORT || "medium"}"`,
        `approval_policy = "on-failure"`,
        `sandbox_mode = "read-only"`,
        "",
        `[projects.${JSON.stringify(process.cwd())}]`,
        `trust_level = "trusted"`,
        "",
      ].join("\n"),
    );
  }

  return runtimeDir;
}

export function initRuntime(): void {
  codexHome = prepareCodexHome();
  process.env.CODEX_HOME = codexHome;
}

export function getCodexOptions(mcpUrl: string): CodexOptions {
  return {
    env: {
      ...process.env,
      CODEX_HOME: codexHome ?? process.env.CODEX_HOME ?? path.join(process.cwd(), ".codex-runtime"),
    },
    config: {
      mcp_servers: {
        lidar: {
          url: mcpUrl,
        },
      },
      web_search: "disabled",
    },
  };
}

export function getCodexThreadOptions(): ThreadOptions {
  return {
    model: process.env.AGENT_MODEL || "gpt-5.4",
    modelReasoningEffort: (process.env.AGENT_REASONING_EFFORT as ThreadOptions["modelReasoningEffort"]) || "medium",
    sandboxMode: "read-only",
    approvalPolicy: "on-failure",
    workingDirectory: process.cwd(),
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
    networkAccessEnabled: false,
  };
}
