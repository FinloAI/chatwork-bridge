import fs from "node:fs";
import path from "node:path";
import { redact } from "./security.js";

export class AuditLog {
  constructor(stateDir, maxBytes = 20_000_000) {
    this.path = path.join(stateDir, "audit.jsonl");
    this.previousPath = `${this.path}.1`;
    this.maxBytes = Math.max(1_000_000, Number(maxBytes) || 20_000_000);
    this.queue = Promise.resolve();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  async write(event) {
    const row = JSON.stringify({ time: new Date().toISOString(), ...redact(event) });
    const operation = this.queue.catch(() => {}).then(async () => {
      const size = await fs.promises.stat(this.path).then((stat) => stat.size).catch(() => 0);
      if (size + Buffer.byteLength(row, "utf8") + 1 > this.maxBytes) {
        await fs.promises.unlink(this.previousPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await fs.promises.rename(this.path, this.previousPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      await fs.promises.appendFile(this.path, `${row}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.queue = operation.catch(() => {});
    await operation;
  }

  wrap(toolName, handler) {
    return async (args, extra) => {
      const callId = extra?.requestId ?? null;
      const started = Date.now();
      await this.write({ event: "tool.start", tool: toolName, callId, args });
      try {
        const result = await handler(args, extra);
        await this.write({
          event: "tool.finish",
          tool: toolName,
          callId,
          elapsedMs: Date.now() - started,
          isError: Boolean(result?.isError),
        });
        return result;
      } catch (error) {
        await this.write({
          event: "tool.error",
          tool: toolName,
          callId,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }
}
