import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { isWithin, resolveAllowedPath, sensitiveReadPolicy, validateArgv } from "./security.js";
import { buildProcessEnv } from "./environment.js";

const ACTIVE_STATUSES = new Set(["running", "cancelling"]);
const CANCELLATION_GRACE_MS = 2_000;
const SANDBOX_PROFILE_VERSION = 1;

// A detached supervisor preserves the command's real exit result when the
// bridge restarts or Chat reconnects. Its launch file avoids shell parsing and
// its result sidecar is merged into the durable job metadata on the next read.
const SUPERVISOR_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const launchPath = process.argv[1];
const resultPath = process.argv[2];
const fallbackLogPath = process.argv[3];
const jobId = process.argv[4];
let finished = false;
let command;
let logFd;
let logSize = 0;
let spec;

function atomicWrite(value) {
  const temporary = resultPath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, jobId, ...value }), { mode: 0o600 });
  fs.renameSync(temporary, resultPath);
}

function fallbackLog(message) {
  try {
    fs.appendFileSync(fallbackLogPath, "[bridge-supervisor] " + message + "\n", { mode: 0o600 });
  } catch {}
}

function openLog() {
  logFd = fs.openSync(spec.logPath, "a", 0o600);
  logSize = fs.fstatSync(logFd).size;
}

function rotateLog() {
  if (logFd !== undefined) fs.closeSync(logFd);
  try { fs.unlinkSync(spec.previousLogPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { fs.renameSync(spec.logPath, spec.previousLogPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  openLog();
}

function writeLog(value) {
  let chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const limit = Math.max(1, Number(spec.maxLogBytes) || 1);
  try {
    if (chunk.length >= limit) {
      if (logSize > 0) rotateLog();
      fs.ftruncateSync(logFd, 0);
      chunk = chunk.subarray(chunk.length - limit);
      logSize = 0;
    } else if (logSize > 0 && logSize + chunk.length > limit) {
      rotateLog();
    }
    fs.writeSync(logFd, chunk);
    logSize += chunk.length;
  } catch (error) {
    fallbackLog("log write failed: " + error.message);
  }
}

function finish(value, processExitCode = 1) {
  if (finished) return;
  finished = true;
  try { if (logFd !== undefined) fs.closeSync(logFd); } catch {}
  try { atomicWrite({ ...value, finishedAt: new Date().toISOString() }); }
  catch (error) { fallbackLog("result persistence failed: " + error.message); }
  process.exitCode = Number.isInteger(processExitCode) ? processExitCode : 1;
}

try {
  spec = JSON.parse(fs.readFileSync(launchPath, "utf8"));
  try { fs.unlinkSync(launchPath); } catch {}
  openLog();
  command = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  command.stdout.on("data", writeLog);
  command.stderr.on("data", writeLog);
  atomicWrite({ status: "running", commandPid: command.pid, commandStartedAt: new Date().toISOString() });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      try { if (command.pid) command.kill(signal); } catch {}
    });
  }
  command.once("error", (error) => finish({
    status: "spawn-failed",
    exitCode: null,
    signal: null,
    spawnError: { name: error.name, message: error.message, code: error.code || null },
  }, 127));
  command.once("close", (code, signal) => finish({
    status: code === 0 ? "succeeded" : "failed",
    exitCode: code,
    signal,
    commandPid: command.pid,
  }, code === 0 ? 0 : 1));
} catch (error) {
  try { fs.unlinkSync(launchPath); } catch {}
  finish({
    status: "spawn-failed",
    exitCode: null,
    signal: null,
    spawnError: { name: error.name, message: error.message, code: error.code || null },
  }, 127);
}
`;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processDuration(meta, now = Date.now()) {
  const started = Date.parse(meta.startedAt || "");
  const finished = Date.parse(meta.finishedAt || "");
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, (Number.isFinite(finished) ? finished : now) - started);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (os.platform() === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

class BoundedTailBuffer {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.buffers = [];
    this.bytes = 0;
    this.totalBytes = 0;
  }

  append(value) {
    let buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += buffer.length;
    if (buffer.length >= this.limit) {
      this.buffers = [buffer.subarray(buffer.length - this.limit)];
      this.bytes = this.limit;
      return;
    }
    this.buffers.push(buffer);
    this.bytes += buffer.length;
    while (this.bytes > this.limit && this.buffers.length > 0) {
      const excess = this.bytes - this.limit;
      const first = this.buffers[0];
      if (first.length <= excess) {
        this.buffers.shift();
        this.bytes -= first.length;
      } else {
        this.buffers[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  get truncated() {
    return this.totalBytes > this.bytes;
  }

  toString() {
    return Buffer.concat(this.buffers, this.bytes).toString("utf8");
  }
}

export class JobManager {
  constructor(config) {
    this.config = config;
    this.jobsDir = path.join(config.stateDir, "jobs");
    this.cacheDir = path.join(config.stateDir, "cache");
    this.writeQueues = new Map();
    this.cancelTimers = new Map();
    this.startQueue = Promise.resolve();
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  validateJobId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid job ID.");
  }

  metadataPath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.json`);
  }

  logPath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.log`);
  }

  previousLogPath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.log.1`);
  }

  resultPath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.result.json`);
  }

  launchPath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.launch.json`);
  }

  sandboxProfilePath(id) {
    this.validateJobId(id);
    return path.join(this.jobsDir, `${id}.sandbox.sb`);
  }

  outputLimit() {
    return positiveInteger(this.config.maxOutputBytes, 200_000);
  }

  jobLogLimit() {
    return positiveInteger(this.config.maxJobLogBytes, 100_000_000);
  }

  concurrentJobLimit() {
    return positiveInteger(this.config.maxConcurrentJobs, 8);
  }

  processEnvironment(overrides) {
    const env = buildProcessEnv(overrides);
    env.XDG_CACHE_HOME ||= this.cacheDir;
    env.TORCH_HOME ||= path.join(this.cacheDir, "torch");
    env.HF_HOME ||= path.join(this.cacheDir, "huggingface");
    env.MPLCONFIGDIR ||= path.join(this.cacheDir, "matplotlib");
    return env;
  }

  sandboxWritePaths() {
    const home = os.homedir();
    const roots = this.config.writeRoots || this.config.roots || [];
    const candidates = [
      ...roots.flatMap((root) => [root.path, root.realPath]),
      this.jobsDir,
      this.cacheDir,
      "/private/tmp",
      "/tmp",
      os.tmpdir(),
      path.resolve(os.tmpdir(), "..", "C"),
      path.resolve(os.tmpdir(), "..", "0"),
      path.join(home, "Library", "Caches"),
      path.join(home, "Library", "Developer", "Xcode", "DerivedData"),
      path.join(home, ".cache"),
      path.join(home, ".npm"),
      path.join(home, ".cargo", "registry"),
      path.join(home, ".cargo", "git"),
      path.join(home, ".gradle", "caches"),
      path.join(home, ".m2", "repository"),
    ];
    return [...new Set(candidates.filter(Boolean).map((candidate) => {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return path.resolve(candidate);
      }
    }))];
  }

  sandboxProfile() {
    const writeRules = this.sandboxWritePaths().map((item) => `  (subpath ${JSON.stringify(item)})`);
    const rules = [
      `(version ${SANDBOX_PROFILE_VERSION})`,
      "(allow default)",
      "(deny file-write*)",
      "(allow file-write*",
      '  (literal "/dev/null")',
      '  (literal "/dev/zero")',
      ...writeRules,
      ")",
    ];
    if (!this.config.allowSensitiveCommandReads) {
      const policy = sensitiveReadPolicy(this.config);
      const protectedDirectories = policy.directories.filter((candidate) => !isWithin(this.config.stateDir, candidate) && !isWithin(candidate, this.jobsDir));
      const runtimeInternal = path.resolve(path.dirname(this.config.skillPath), "../..", ".chatwork-bridge");
      const projectInternals = (this.config.writeRoots || this.config.roots || []).map((root) => path.join(root.realPath, ".chatwork-bridge"));
      const readRules = [...new Set([...protectedDirectories, runtimeInternal, ...projectInternals])]
        .map((item) => `  (subpath ${JSON.stringify(item)})`);
      const readFiles = [...new Set([...policy.files, path.join(this.config.stateDir, "audit.jsonl")])]
        .map((item) => `  (literal ${JSON.stringify(item)})`);
      rules.push("(deny file-read*", ...readRules, ...readFiles, ")");
    }
    rules.push("");
    return rules.join("\n");
  }

  async prepareSandbox(id, argv) {
    const required = this.config.requireProcessSandbox === true || process.env.CHATWORK_REQUIRE_PROCESS_SANDBOX === "1";
    const executable = "/usr/bin/sandbox-exec";
    const nestedSandbox = Boolean(process.env.CODEX_SANDBOX);
    if (os.platform() !== "darwin" || !fs.existsSync(executable) || nestedSandbox) {
      const reason = nestedSandbox ? "nested sandboxing is unavailable in this Codex development process" : "OS process sandbox is unavailable";
      const warning = `${reason}; cwd is restricted but argv may access paths allowed to the local user.`;
      if (required) throw new Error(`${warning} CHATWORK_REQUIRE_PROCESS_SANDBOX is enabled.`);
      return { argv, sandboxed: false, sandboxProfileVersion: null, sandboxWarning: warning, profilePath: null };
    }

    const profilePath = this.sandboxProfilePath(id);
    await fs.promises.writeFile(profilePath, this.sandboxProfile(), { mode: 0o600 });
    return {
      argv: [executable, "-f", profilePath, ...argv],
      sandboxed: true,
      sandboxProfileVersion: SANDBOX_PROFILE_VERSION,
      sandboxWarning: null,
      profilePath,
    };
  }

  async atomicWriteJson(filePath, value) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, filePath);
    } finally {
      await handle?.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  async enqueueWrite(id, operation) {
    const previous = this.writeQueues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writeQueues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.writeQueues.get(id) === next) this.writeQueues.delete(id);
    }
  }

  async save(meta) {
    this.validateJobId(meta?.id);
    return await this.enqueueWrite(meta.id, async () => {
      await this.atomicWriteJson(this.metadataPath(meta.id), meta);
      return meta;
    });
  }

  async readMetadata(id) {
    const meta = JSON.parse(await fs.promises.readFile(this.metadataPath(id), "utf8"));
    if (!meta || typeof meta !== "object" || meta.id !== id) throw new Error("Job metadata is invalid.");
    meta.logPath = this.logPath(id);
    return meta;
  }

  async readResult(id) {
    try {
      const result = JSON.parse(await fs.promises.readFile(this.resultPath(id), "utf8"));
      if (!result || typeof result !== "object" || result.jobId !== id) return null;
      return result;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async mutate(id, updater) {
    this.validateJobId(id);
    return await this.enqueueWrite(id, async () => {
      const current = await this.readMetadata(id);
      const before = JSON.stringify(current);
      const updated = (await updater(current)) || current;
      updated.id = id;
      updated.logPath = this.logPath(id);
      if (JSON.stringify(updated) !== before) await this.atomicWriteJson(this.metadataPath(id), updated);
      return updated;
    });
  }

  applyResult(meta, result) {
    if (!result) return meta;
    if (Number.isInteger(result.commandPid) && result.commandPid > 0) meta.commandPid = result.commandPid;
    if (result.commandStartedAt) meta.commandStartedAt = result.commandStartedAt;
    if (!ACTIVE_STATUSES.has(result.status)) {
      meta.status = meta.cancelRequestedAt ? "cancelled" : result.status;
      meta.exitCode = result.exitCode ?? null;
      meta.signal = result.signal ?? null;
      meta.finishedAt = result.finishedAt || meta.finishedAt || new Date().toISOString();
      if (result.spawnError) meta.spawnError = result.spawnError;
    }
    return meta;
  }

  async reconcile(meta) {
    this.applyResult(meta, await this.readResult(meta.id));
    if (!ACTIVE_STATUSES.has(meta.status)) return meta;

    if (!isProcessAlive(meta.pid)) {
      meta.status = meta.cancelRequestedAt ? "cancelled" : "finished-unknown";
      meta.finishedAt ||= new Date().toISOString();
      return meta;
    }

    if (meta.status === "cancelling" && !meta.killEscalatedAt) {
      const requestedAt = Date.parse(meta.cancelRequestedAt || "");
      if (Number.isFinite(requestedAt) && Date.now() - requestedAt >= CANCELLATION_GRACE_MS) {
        let signalled = false;
        try {
          signalled = signalProcessGroup(meta.pid, "SIGKILL");
          meta.killEscalatedAt = new Date().toISOString();
        } catch (error) {
          meta.killEscalationError = { message: error.message, code: error.code || null };
          meta.killEscalationAttemptedAt = new Date().toISOString();
          return meta;
        }
        if (!signalled) {
          meta.status = "cancelled";
          meta.finishedAt ||= meta.killEscalatedAt;
        }
      }
    }
    return meta;
  }

  async load(id) {
    const meta = await this.mutate(id, async (current) => await this.reconcile(current));
    if (!ACTIVE_STATUSES.has(meta.status) && meta.sandboxProfilePath) {
      await fs.promises.unlink(meta.sandboxProfilePath).catch(() => {});
    }
    return meta;
  }

  describe(meta) {
    const active = ACTIVE_STATUSES.has(meta.status);
    return { ...meta, alive: active && isProcessAlive(meta.pid), durationMs: processDuration(meta) };
  }

  async countActiveJobs() {
    const entries = await fs.promises.readdir(this.jobsDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      try {
        const meta = await this.load(entry.name.slice(0, -5));
        if (ACTIVE_STATUSES.has(meta.status) && isProcessAlive(meta.pid)) count += 1;
      } catch {
        // Corrupt or interrupted metadata cannot represent an active managed job.
      }
    }
    return count;
  }

  async withStartLock(operation) {
    const next = this.startQueue.catch(() => {}).then(operation);
    this.startQueue = next.catch(() => {});
    return await next;
  }

  async start({ argv, cwd = ".", env = {}, label = "task" }) {
    validateArgv(argv);
    const workingDirectory = resolveAllowedPath(cwd, this.config, { expectDirectory: true });
    return await this.withStartLock(async () => {
      const activeJobs = await this.countActiveJobs();
      const limit = this.concurrentJobLimit();
      if (activeJobs >= limit) {
        throw new Error(`Concurrent job limit reached (${activeJobs}/${limit}). Finish or cancel a job before starting another.`);
      }

      const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
      const logPath = this.logPath(id);
      const launchPath = this.launchPath(id);
      const resultPath = this.resultPath(id);
      const startedAt = new Date().toISOString();
      await fs.promises.writeFile(logPath, "", { flag: "a", mode: 0o600 });
      await this.atomicWriteJson(launchPath, {
        id,
        argv,
        cwd: workingDirectory,
        logPath,
        previousLogPath: this.previousLogPath(id),
        maxLogBytes: this.jobLogLimit(),
      });

      const supervisorArgv = [process.execPath, "-e", SUPERVISOR_SOURCE, launchPath, resultPath, logPath, id];
      let sandbox;
      let child;
      try {
        sandbox = await this.prepareSandbox(id, supervisorArgv);
        child = spawn(sandbox.argv[0], sandbox.argv.slice(1), {
          cwd: workingDirectory,
          env: this.processEnvironment(env),
          detached: os.platform() !== "win32",
          stdio: "ignore",
          windowsHide: true,
        });
      } catch (error) {
        await fs.promises.unlink(launchPath).catch(() => {});
        await fs.promises.unlink(sandbox?.profilePath).catch(() => {});
        throw error;
      }

      const meta = {
        version: 2,
        id,
        label: String(label).slice(0, 120),
        argv,
        cwd: workingDirectory,
        pid: child.pid,
        status: "running",
        startedAt,
        logPath,
        supervised: true,
        sandboxed: sandbox.sandboxed,
        sandboxProfileVersion: sandbox.sandboxProfileVersion,
        sandboxWarning: sandbox.sandboxWarning,
        sandboxProfilePath: sandbox.profilePath,
      };

      child.once("error", (error) => {
        void this.finalize(id, {
          status: "spawn-failed",
          exitCode: null,
          signal: null,
          spawnError: { name: error.name, message: error.message, code: error.code || null },
        });
      });
      child.once("exit", (code, signal) => {
        void this.finalize(id, { status: code === 0 ? "succeeded" : "failed", exitCode: code, signal });
      });

      try {
        await this.save(meta);
      } catch (error) {
        signalProcessGroup(child.pid, "SIGTERM");
        await fs.promises.unlink(launchPath).catch(() => {});
        await fs.promises.unlink(sandbox.profilePath).catch(() => {});
        throw error;
      }
      child.unref();
      return this.describe(meta);
    });
  }

  async finalize(id, fallback) {
    try {
      const meta = await this.mutate(id, async (current) => {
        const result = await this.readResult(id);
        if (result && !ACTIVE_STATUSES.has(result.status)) return this.applyResult(current, result);
        current.status = current.cancelRequestedAt ? "cancelled" : fallback.status;
        current.exitCode = fallback.exitCode ?? null;
        current.signal = fallback.signal ?? null;
        current.finishedAt ||= new Date().toISOString();
        if (fallback.spawnError) current.spawnError = fallback.spawnError;
        return current;
      });
      if (!ACTIVE_STATUSES.has(meta.status)) {
        this.clearCancelTimer(id);
        await fs.promises.unlink(meta.sandboxProfilePath).catch(() => {});
      }
    } catch {
      // The supervisor result and log remain durable even if metadata update fails.
    }
  }

  async status({ jobId }) {
    return this.describe(await this.load(jobId));
  }

  async list({ status = "", limit = 50 } = {}) {
    const entries = await fs.promises.readdir(this.jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      const id = entry.name.slice(0, -5);
      try {
        const meta = this.describe(await this.load(id));
        if (status && meta.status !== status) continue;
        jobs.push({
          id: meta.id,
          label: meta.label,
          status: meta.status,
          pid: meta.pid,
          commandPid: meta.commandPid,
          alive: meta.alive,
          cwd: meta.cwd,
          startedAt: meta.startedAt,
          finishedAt: meta.finishedAt,
          durationMs: meta.durationMs,
          exitCode: meta.exitCode,
          signal: meta.signal,
          cancelRequestedAt: meta.cancelRequestedAt,
          sandboxed: meta.sandboxed ?? false,
          sandboxWarning: meta.sandboxWarning,
          logPath: meta.logPath,
        });
      } catch {
        // Ignore incomplete metadata left by an interrupted or external write.
      }
    }
    jobs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
    const boundedLimit = Math.min(Math.max(Number(limit) || 1, 1), 200);
    return { jobs: jobs.slice(0, boundedLimit), total: jobs.length, active: jobs.filter((job) => job.alive).length };
  }

  async readLogTail(paths, maxBytes) {
    const files = [];
    for (const filePath of paths) {
      try {
        files.push({ path: filePath, size: (await fs.promises.stat(filePath)).size });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    let remaining = maxBytes;
    const buffers = [];
    let bytesRead = 0;
    for (const file of [...files].reverse()) {
      if (remaining <= 0) break;
      let handle;
      try {
        handle = await fs.promises.open(file.path, "r");
        const size = Math.min(file.size, remaining);
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const read = await handle.read(buffer, offset, size - offset, file.size - size + offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const complete = buffer.subarray(0, offset);
        buffers.unshift(complete);
        bytesRead += complete.length;
        remaining -= complete.length;
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return { buffer: Buffer.concat(buffers), bytesRead, totalSize: files.reduce((sum, file) => sum + file.size, 0) };
  }

  async tail({ jobId, lines = 120 }) {
    const meta = await this.load(jobId);
    const logs = await this.readLogTail([this.previousLogPath(jobId), this.logPath(jobId)], this.outputLimit());
    const content = logs.buffer.toString("utf8");
    const allLines = content.split(/\r?\n/);
    if (allLines.at(-1) === "") allLines.pop();
    const requestedLines = Math.min(Math.max(Number(lines) || 1, 1), 1000);
    const selected = allLines.slice(-requestedLines);
    return {
      jobId,
      status: meta.status,
      alive: ACTIVE_STATUSES.has(meta.status) && isProcessAlive(meta.pid),
      logPath: this.logPath(jobId),
      output: selected.join("\n"),
      returnedLines: selected.length,
      bytesRead: logs.bytesRead,
      fileSize: logs.totalSize,
      truncated: logs.totalSize > logs.bytesRead || allLines.length > selected.length,
    };
  }

  async wait({ jobId, afterStatus = "", afterBytes = -1, timeoutSeconds = 30, lines = 120 }) {
    this.validateJobId(jobId);
    const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || 1, 1), 50) * 1_000;
    const startedAt = Date.now();
    let status;
    let tail;
    while (true) {
      status = await this.status({ jobId });
      tail = await this.tail({ jobId, lines });
      const terminal = !ACTIVE_STATUSES.has(status.status);
      const statusChanged = Boolean(afterStatus) && status.status !== afterStatus;
      const outputAdvanced = Number.isFinite(Number(afterBytes)) && Number(afterBytes) >= 0 && tail.fileSize > Number(afterBytes);
      if (terminal || statusChanged || outputAdvanced) {
        return { timedOut: false, waitedMs: Date.now() - startedAt, status, tail };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return { timedOut: true, waitedMs: Date.now() - startedAt, status, tail };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, timeoutMs - (Date.now() - startedAt))));
    }
  }

  clearCancelTimer(id) {
    const timer = this.cancelTimers.get(id);
    if (timer) clearTimeout(timer);
    this.cancelTimers.delete(id);
  }

  scheduleCancellationEscalation(id) {
    this.clearCancelTimer(id);
    const timer = setTimeout(() => {
      this.cancelTimers.delete(id);
      void this.load(id).catch(() => {});
    }, CANCELLATION_GRACE_MS + 25);
    timer.unref?.();
    this.cancelTimers.set(id, timer);
  }

  async cancel({ jobId }) {
    const initial = await this.load(jobId);
    if (!ACTIVE_STATUSES.has(initial.status) || !isProcessAlive(initial.pid)) {
      return { jobId, status: initial.status, stopped: false, alive: false };
    }

    let shouldSignal = false;
    const cancelling = await this.mutate(jobId, async (meta) => {
      await this.reconcile(meta);
      if (!ACTIVE_STATUSES.has(meta.status) || !isProcessAlive(meta.pid)) return meta;
      meta.status = "cancelling";
      meta.cancelRequestedAt ||= new Date().toISOString();
      shouldSignal = true;
      return meta;
    });
    if (!shouldSignal) return { jobId, status: cancelling.status, stopped: false, alive: false };

    let signalled;
    try {
      signalled = signalProcessGroup(cancelling.pid, "SIGTERM");
    } catch (error) {
      await this.mutate(jobId, (meta) => {
        meta.cancelError = { message: error.message, code: error.code || null };
        return meta;
      }).catch(() => {});
      throw error;
    }
    if (!signalled) {
      const cancelled = await this.mutate(jobId, (meta) => {
        meta.status = "cancelled";
        meta.finishedAt ||= new Date().toISOString();
        return meta;
      });
      return { jobId, status: cancelled.status, stopped: false, alive: false };
    }

    this.scheduleCancellationEscalation(jobId);
    return {
      jobId,
      status: "cancelling",
      stopped: true,
      alive: true,
      signal: "SIGTERM",
      escalationAfterMs: CANCELLATION_GRACE_MS,
    };
  }

  async run({ argv, cwd = ".", env = {}, timeoutSeconds = 60 }) {
    validateArgv(argv);
    const workingDirectory = resolveAllowedPath(cwd, this.config, { expectDirectory: true });
    const maximum = Math.min(Math.max(Number(this.config.maxCommandSeconds) || 90, 1), 90);
    const normalizedTimeoutSeconds = Math.min(Math.max(Number(timeoutSeconds) || 1, 1), maximum);
    const timeoutMs = normalizedTimeoutSeconds * 1000;
    const maxBytes = this.outputLimit();
    const startedAt = new Date();
    const runId = `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const sandbox = await this.prepareSandbox(runId, argv);

    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(sandbox.argv[0], sandbox.argv.slice(1), {
          cwd: workingDirectory,
          env: this.processEnvironment(env),
          detached: os.platform() !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        void fs.promises.unlink(sandbox.profilePath).catch(() => {});
        reject(error);
        return;
      }

      const stdout = new BoundedTailBuffer(maxBytes);
      const stderr = new BoundedTailBuffer(maxBytes);
      const combined = new BoundedTailBuffer(maxBytes);
      let timedOut = false;
      let settled = false;
      let escalationTimer;
      let terminationError;

      const collect = (name, target) => (chunk) => {
        target.append(chunk);
        combined.append(Buffer.from(`[${name}] `));
        combined.append(chunk);
      };
      child.stdout.on("data", collect("stdout", stdout));
      child.stderr.on("data", collect("stderr", stderr));

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          signalProcessGroup(child.pid, "SIGTERM");
        } catch (error) {
          terminationError = { message: error.message, code: error.code || null, signal: "SIGTERM" };
        }
        escalationTimer = setTimeout(() => {
          try {
            signalProcessGroup(child.pid, "SIGKILL");
          } catch (error) {
            terminationError = { message: error.message, code: error.code || null, signal: "SIGKILL" };
          }
        }, CANCELLATION_GRACE_MS);
        escalationTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalationTimer);
        void fs.promises.unlink(sandbox.profilePath).catch(() => {});
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalationTimer);
        void fs.promises.unlink(sandbox.profilePath).catch(() => {});
        const finishedAt = new Date();
        const status = timedOut ? "timed-out" : code === 0 ? "succeeded" : "failed";
        resolve({
          argv,
          cwd: workingDirectory,
          status,
          ok: status === "succeeded",
          exitCode: code,
          signal,
          timedOut,
          timeoutSeconds: normalizedTimeoutSeconds,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          output: combined.toString(),
          truncated: stdout.truncated || stderr.truncated || combined.truncated,
          outputBytes: { stdout: stdout.totalBytes, stderr: stderr.totalBytes },
          terminationError,
          sandboxed: sandbox.sandboxed,
          sandboxProfileVersion: sandbox.sandboxProfileVersion,
          sandboxWarning: sandbox.sandboxWarning,
        });
      });
    });
  }
}
