import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { buildProcessEnv } from "./environment.js";
import { resolveAllowedPath } from "./security.js";

function validateRevision(revision) {
  if (!revision) return "";
  if (revision.startsWith("-") || revision.includes("\0") || revision.length > 240) {
    throw new Error("Invalid Git revision.");
  }
  return revision;
}

function runGit(args, { cwd, timeoutMs, maxOutputBytes }) {
  const executable = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-c", "color.ui=false", "-c", "core.pager=cat", ...args], {
      cwd,
      env: { ...buildProcessEnv(), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", PAGER: "cat" },
      detached: os.platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      const kept = stdout.reduce((total, item) => total + item.length, 0);
      if (kept < maxOutputBytes) stdout.push(chunk.subarray(0, maxOutputBytes - kept));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      const kept = stderr.reduce((total, item) => total + item.length, 0);
      if (kept < maxOutputBytes) stderr.push(chunk.subarray(0, maxOutputBytes - kept));
    });
    child.on("error", reject);
    let forceKillTimer;
    const terminate = (signal) => {
      try {
        if (os.platform() === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimer = setTimeout(() => terminate("SIGKILL"), 1_500);
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes,
      });
    });
  });
}

function requireSuccess(result, operation) {
  if (result.timedOut) throw new Error(`${operation} timed out.`);
  if (result.code !== 0) throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  return result;
}

function parsePorcelainV2(output) {
  const branch = {};
  const changes = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) branch.head = record.slice(14);
    else if (record.startsWith("# branch.oid ")) branch.oid = record.slice(13);
    else if (record.startsWith("# branch.upstream ")) branch.upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+) -(\d+)/);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
    } else if (record.startsWith("? ")) changes.push({ kind: "untracked", path: record.slice(2) });
    else if (record.startsWith("! ")) changes.push({ kind: "ignored", path: record.slice(2) });
    else if (record.startsWith("1 ")) {
      const match = record.match(/^1 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]*)$/);
      if (match) changes.push({ kind: "tracked", index: match[1][0], worktree: match[1][1], path: match[8] });
    } else if (record.startsWith("2 ")) {
      const match = record.match(/^2 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]*)$/);
      const originalPath = records[index + 1] ?? "";
      index += 1;
      if (match) changes.push({ kind: "renamed", index: match[1][0], worktree: match[1][1], score: match[8], path: match[9], originalPath });
    } else if (record.startsWith("u ")) {
      const match = record.match(/^u ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]*)$/);
      if (match) changes.push({ kind: "unmerged", index: match[1][0], worktree: match[1][1], path: match[10] });
    }
  }
  return { branch, changes };
}

export class GitTools {
  constructor(config) {
    this.config = config;
  }

  resolveDirectory(requested = ".") {
    return resolveAllowedPath(requested, this.config, { expectDirectory: true, access: "read" });
  }

  async root({ path = "." } = {}) {
    const directory = this.resolveDirectory(path);
    const result = requireSuccess(await runGit(["rev-parse", "--show-toplevel"], {
      cwd: directory,
      timeoutMs: this.config.ioTimeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
    }), "Git root discovery");
    const root = resolveAllowedPath(result.stdout.trim(), this.config, { expectDirectory: true, access: "read" });
    return { requestedPath: directory, root };
  }

  async status({ path = ".", includeUntracked = true } = {}) {
    const directory = this.resolveDirectory(path);
    const root = (await this.root({ path: directory })).root;
    const result = requireSuccess(await runGit(["status", "--porcelain=v2", "-z", "--branch", includeUntracked ? "--untracked-files=all" : "--untracked-files=no"], {
      cwd: root,
      timeoutMs: Math.max(this.config.ioTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    }), "Git status");
    const parsed = parsePorcelainV2(result.stdout);
    return { root, clean: parsed.changes.length === 0, ...parsed, raw: result.stdout, truncated: result.truncated };
  }

  async diff({ path = ".", staged = false, base = "", file = "", context = 3 } = {}) {
    const directory = this.resolveDirectory(path);
    const root = (await this.root({ path: directory })).root;
    const args = ["diff", "--no-ext-diff", "--text", `--unified=${Math.min(Math.max(context, 0), 20)}`];
    if (staged) args.push("--cached");
    if (base) args.push(validateRevision(base));
    if (file) args.push("--", file);
    const result = requireSuccess(await runGit(args, {
      cwd: root,
      timeoutMs: Math.max(this.config.ioTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    }), "Git diff");
    return { root, staged, base, file, diff: result.stdout, truncated: result.truncated };
  }

  async log({ path = ".", limit = 20, revision = "HEAD" } = {}) {
    const directory = this.resolveDirectory(path);
    const root = (await this.root({ path: directory })).root;
    const selectedRevision = validateRevision(revision || "HEAD");
    const format = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";
    const result = requireSuccess(await runGit(["log", `--max-count=${Math.min(Math.max(limit, 1), 100)}`, `--format=${format}`, selectedRevision], {
      cwd: root,
      timeoutMs: Math.max(this.config.ioTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    }), "Git log");
    const commits = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, shortHash, author, authoredAt, subject] = line.split("\x1f");
      return { hash, shortHash, author, authoredAt, subject };
    });
    return { root, revision: selectedRevision, commits, truncated: result.truncated };
  }
}
