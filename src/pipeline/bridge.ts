import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";
import path from "path";
import { EventEmitter } from "events";

interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: BridgeMessage) => void;

export class PipelineBridge extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pendingResolve: ((msg: BridgeMessage) => void) | null = null;

  constructor(private pipelineDir: string) {
    super();
  }

  private ensureStarted(): void {
    if (this.proc) return;

    this.proc = spawn("python3", [path.join(this.pipelineDir, "executor.py"), "--bridge"], {
      cwd: this.pipelineDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const msg: BridgeMessage = JSON.parse(line);
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          resolve(msg);
        } else {
          this.emit("message", msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    });

    this.proc.stderr?.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });
  }

  private send(data: object): void {
    this.ensureStarted();
    this.proc!.stdin!.write(JSON.stringify(data) + "\n");
  }

  private waitForMessage(): Promise<BridgeMessage> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  async ping(): Promise<boolean> {
    this.send({ type: "ping" });
    const msg = await this.waitForMessage();
    return msg.type === "pong";
  }

  async runPipeline(dagPath: string, params: Record<string, unknown>, onMessage: MessageHandler): Promise<void> {
    this.ensureStarted();

    const handler = (msg: BridgeMessage) => {
      onMessage(msg);
    };
    this.on("message", handler);

    this.send({ type: "run_pipeline", dag_path: dagPath, params });

    return new Promise((resolve, reject) => {
      const done = (msg: BridgeMessage) => {
        if (msg.type === "pipeline_completed" || msg.type === "pipeline_failed") {
          this.off("message", handler);
          this.off("message", done);
          if (msg.type === "pipeline_failed") {
            reject(new Error(msg.error as string));
          } else {
            resolve();
          }
        }
      };
      this.on("message", done);
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
