import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildProcessEnv } from "./environment.js";
import { isSensitiveReadPath, isWithin, resolveAllowedPath, sha256File } from "./security.js";

const SKIPPABLE_IO_ERRORS = new Set(["EACCES", "EPERM", "ENOENT", "ELOOP", "ETIMEDOUT", "ABORT_ERR"]);
const DEFAULT_EXCLUDED_DIRECTORIES = [".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__"];

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs} ms.`);
  error.code = "ETIMEDOUT";
  return error;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBuffer(filePath, maxBytes, timeoutMs) {
  const stat = await withTimeout(fs.promises.stat(filePath), timeoutMs, `Stat ${filePath}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { stat, buffer: await fs.promises.readFile(filePath, { signal: controller.signal }) };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw timeoutError(`Read ${filePath}`, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function relativeToRoot(filePath, config) {
  return filePath;
}

async function walk(start, options, visit) {
  const {
    includeHidden = false,
    maxEntries = 300,
    maxDepth = 8,
    timeoutMs = 15_000,
    overallTimeoutMs = 60_000,
    excludeDirectories = [],
    isSensitive = () => false,
    stopWhen = () => false,
  } = options;
  const excluded = new Set(excludeDirectories);
  const startedAt = Date.now();
  const deadlineMs = Math.max(timeoutMs, overallTimeoutMs);
  const deadline = startedAt + deadlineMs;
  const queue = [{ dir: start, depth: 0 }];
  const skipped = [];
  const recordSkip = (filePath, error) => {
    if (skipped.length < 50) skipped.push({ path: filePath, reason: error?.code || error?.message || "unreadable" });
  };
  let seen = 0;
  let deadlineExceeded = false;
  let stoppedByCondition = false;
  let unvisitedEntries = false;
  while (queue.length > 0 && seen < maxEntries) {
    if (stopWhen()) {
      stoppedByCondition = true;
      break;
    }
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      recordSkip(start, { code: "SCAN_DEADLINE" });
      break;
    }
    const { dir, depth } = queue.shift();
    if (isSensitive(dir)) {
      recordSkip(dir, { code: "SENSITIVE_PATH" });
      continue;
    }
    let entries;
    try {
      entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), timeoutMs, `List ${dir}`);
    } catch (error) {
      if (SKIPPABLE_IO_ERRORS.has(error?.code)) {
        recordSkip(dir, error);
        continue;
      }
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      if (stopWhen()) {
        stoppedByCondition = true;
        unvisitedEntries ||= entryIndex < entries.length;
        break;
      }
      if (Date.now() >= deadline) {
        deadlineExceeded = true;
        unvisitedEntries ||= entryIndex < entries.length;
        recordSkip(start, { code: "SCAN_DEADLINE" });
        break;
      }
      if (!includeHidden && entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (isSensitive(fullPath)) {
        recordSkip(fullPath, { code: "SENSITIVE_PATH" });
        continue;
      }
      seen += 1;
      let shouldDescend;
      try {
        shouldDescend = await visit(fullPath, entry, depth + 1);
      } catch (error) {
        if (SKIPPABLE_IO_ERRORS.has(error?.code)) {
          recordSkip(fullPath, error);
          continue;
        }
        throw error;
      }
      if (seen >= maxEntries) {
        unvisitedEntries ||= entryIndex < entries.length - 1;
        unvisitedEntries ||= entry.isDirectory() && shouldDescend !== false && depth + 1 < maxDepth;
        break;
      }
      if (entry.isDirectory() && shouldDescend !== false && depth + 1 < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  const entryLimitReached = !stoppedByCondition && seen >= maxEntries && (queue.length > 0 || unvisitedEntries);
  return {
    seen,
    skipped,
    deadlineExceeded,
    entryLimitReached,
    stoppedByCondition,
    maxEntries,
    deadlineMs,
    elapsedMs: Date.now() - startedAt,
    budgetExhausted: deadlineExceeded || entryLimitReached,
  };
}

function scanReport(walkResult, { resultLimitReached = false, resultLimit = null, entryLimitReason = "scan_entry_limit" } = {}) {
  const truncationReasons = [];
  if (resultLimitReached) truncationReasons.push("result_limit");
  if (walkResult.entryLimitReached) truncationReasons.push(entryLimitReason);
  if (walkResult.deadlineExceeded) truncationReasons.push("scan_deadline");
  return {
    truncated: truncationReasons.length > 0,
    truncationReasons,
    scan: {
      scannedEntries: walkResult.seen,
      maxEntries: walkResult.maxEntries,
      elapsedMs: walkResult.elapsedMs,
      deadlineMs: walkResult.deadlineMs,
      complete: truncationReasons.length === 0,
      ...(resultLimit === null ? {} : { resultLimit }),
    },
  };
}

function globToRegExp(glob) {
  if (!glob) return null;
  const normalized = glob.replaceAll("\\", "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function compileSearchExpression(query, regex, caseSensitive) {
  const flags = caseSensitive ? "g" : "gi";
  if (!regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  if (query.length > 240) throw new Error("Regular expressions are limited to 240 characters.");
  if (/\\[1-9]/.test(query) || /\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\)\s*(?:[+*]|\{)/.test(query)) {
    throw new Error("Potentially exponential regular expressions and backreferences are not supported.");
  }
  return new RegExp(query, flags);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function atomicWrite(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.chatwork-${crypto.randomUUID()}.tmp`;
  const existingMode = await fs.promises.stat(filePath).then((stat) => stat.mode & 0o777).catch(() => 0o600);
  try {
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode: existingMode });
    await fs.promises.chmod(temporary, existingMode);
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

function parsePatchTarget(rawValue, strip) {
  const raw = rawValue.split("\t", 1)[0].trim();
  if (raw === "/dev/null") return null;
  if (!raw || raw.startsWith('"') || path.posix.isAbsolute(raw) || raw.includes("\\")) {
    throw new Error(`Unsupported or unsafe patch path: ${raw || "<empty>"}`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part === "")) throw new Error(`Unsafe patch path: ${raw}`);
  if (parts.length <= strip) throw new Error(`Patch path ${raw} cannot be stripped by ${strip} component(s).`);
  return parts.slice(strip).join(path.sep);
}

function collectPatchTargets(patch, strip) {
  const targets = new Set();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const target = parsePatchTarget(line.slice(4), strip);
    if (target) targets.add(target);
  }
  if (targets.size === 0) throw new Error("Patch does not contain any unified-diff file headers.");
  return [...targets];
}

function runWithInput(executable, args, { cwd, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: buildProcessEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const collect = (bucket) => (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: bytes > maxOutputBytes,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export class FileTools {
  constructor(config) {
    this.config = config;
  }

  async listDirectory({ path: requested = ".", depth = 1, includeHidden = false, maxEntries = 300 }) {
    const directory = resolveAllowedPath(requested, this.config, { expectDirectory: true, access: "read" });
    const entries = [];
    const walkResult = await walk(directory, {
      includeHidden,
      maxEntries,
      maxDepth: Math.min(depth, 8),
      timeoutMs: this.config.ioTimeoutMs,
      overallTimeoutMs: 60_000,
      isSensitive: (candidate) => isSensitiveReadPath(candidate, this.config),
    }, async (fullPath, dirent, itemDepth) => {
      const stat = await withTimeout(fs.promises.lstat(fullPath), this.config.ioTimeoutMs, `Stat ${fullPath}`);
      entries.push({
        path: relativeToRoot(fullPath, this.config),
        type: dirent.isDirectory() ? "directory" : dirent.isSymbolicLink() ? "symlink" : "file",
        size: stat.size,
        modified: stat.mtime.toISOString(),
        depth: itemDepth,
      });
      return !dirent.isSymbolicLink();
    });
    return {
      root: directory,
      entries,
      skipped: walkResult.skipped,
      ...scanReport(walkResult, { entryLimitReason: "entry_limit" }),
    };
  }

  async findFiles({ path: requested = ".", pattern = "*", includeHidden = false, maxResults = 200, excludeDirectories = DEFAULT_EXCLUDED_DIRECTORIES }) {
    const directory = resolveAllowedPath(requested, this.config, { expectDirectory: true, access: "read" });
    const matcher = globToRegExp(pattern);
    const files = [];
    const walkResult = await walk(directory, {
      includeHidden,
      maxEntries: Math.max(maxResults + 1, this.config.maxScanEntries),
      maxDepth: 20,
      timeoutMs: this.config.ioTimeoutMs,
      overallTimeoutMs: 45_000,
      excludeDirectories,
      isSensitive: (candidate) => isSensitiveReadPath(candidate, this.config),
      stopWhen: () => files.length > maxResults,
    }, async (fullPath, dirent) => {
      if (dirent.isFile()) {
        const relative = path.relative(directory, fullPath).split(path.sep).join("/");
        if (!matcher || matcher.test(relative) || matcher.test(dirent.name)) files.push(relativeToRoot(fullPath, this.config));
      }
      return !dirent.isSymbolicLink();
    });
    return {
      path: directory,
      pattern,
      files: files.slice(0, maxResults),
      skipped: walkResult.skipped,
      ...scanReport(walkResult, { resultLimitReached: files.length > maxResults, resultLimit: maxResults }),
    };
  }

  async searchText({ path: requested = ".", query, regex = false, caseSensitive = false, includeHidden = false, maxResults = 100, excludeDirectories = DEFAULT_EXCLUDED_DIRECTORIES }) {
    const directory = resolveAllowedPath(requested, this.config, { expectDirectory: true, access: "read" });
    const expression = compileSearchExpression(query, regex, caseSensitive);
    const matches = [];
    const walkResult = await walk(directory, {
      includeHidden,
      maxEntries: Math.max(maxResults + 1, this.config.maxScanEntries),
      maxDepth: 25,
      timeoutMs: this.config.ioTimeoutMs,
      overallTimeoutMs: 30_000,
      excludeDirectories,
      isSensitive: (candidate) => isSensitiveReadPath(candidate, this.config),
      stopWhen: () => matches.length > maxResults,
    }, async (fullPath, dirent) => {
      if (!dirent.isFile() || matches.length > maxResults) return !dirent.isSymbolicLink();
      const stat = await withTimeout(fs.promises.stat(fullPath), this.config.ioTimeoutMs, `Stat ${fullPath}`);
      if (stat.size > 2_000_000) return true;
      const { buffer } = await readBuffer(fullPath, 2_000_000, this.config.ioTimeoutMs);
      if (buffer.includes(0)) return true;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length <= maxResults; index += 1) {
        expression.lastIndex = 0;
        const searchableLine = lines[index].slice(0, 20_000);
        if (expression.test(searchableLine)) {
          matches.push({ path: relativeToRoot(fullPath, this.config), line: index + 1, text: lines[index].slice(0, 500) });
        }
      }
      return true;
    });
    return {
      path: directory,
      query,
      matches: matches.slice(0, maxResults),
      skipped: walkResult.skipped,
      ...scanReport(walkResult, { resultLimitReached: matches.length > maxResults, resultLimit: maxResults }),
    };
  }

  async readFile({ path: requested, startLine = 1, endLine = 0 }) {
    const filePath = resolveAllowedPath(requested, this.config, { access: "read" });
    const { buffer } = await readBuffer(filePath, this.config.maxReadBytes, this.config.ioTimeoutMs);
    if (buffer.includes(0)) throw new Error("Binary files are not returned as text.");
    const allLines = buffer.toString("utf8").split(/\r?\n/);
    const from = Math.max(1, startLine);
    const to = endLine > 0 ? Math.min(endLine, allLines.length) : allLines.length;
    const content = allLines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n");
    return {
      path: filePath,
      startLine: from,
      endLine: to,
      totalLines: allLines.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      content,
    };
  }

  async readFiles({ paths, startLine = 1, endLine = 0 }) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths must contain at least one file.");
    if (paths.length > this.config.maxBatchFiles) throw new Error(`A batch may contain at most ${this.config.maxBatchFiles} files.`);
    const reads = await mapWithConcurrency(paths, 4, async (requested) => {
      try {
        return { ok: true, ...(await this.readFile({ path: requested, startLine, endLine })) };
      } catch (error) {
        return { ok: false, path: requested, error: error instanceof Error ? error.message : String(error) };
      }
    });
    const files = [];
    let outputBytes = 0;
    for (const read of reads) {
      if (outputBytes >= this.config.maxOutputBytes) {
        files.push({ ok: false, path: read.path, error: "Batch output limit reached before this file was returned." });
        continue;
      }
      if (read.ok) {
        const bytes = Buffer.byteLength(read.content);
        const remaining = Math.max(0, this.config.maxOutputBytes - outputBytes);
        if (bytes > remaining) {
          const clipped = Buffer.from(read.content).subarray(0, remaining).toString("utf8");
          files.push({ ...read, content: clipped, truncated: true, returnedBytes: Buffer.byteLength(clipped) });
          outputBytes = this.config.maxOutputBytes;
        } else {
          files.push({ ...read, truncated: false, returnedBytes: bytes });
          outputBytes += bytes;
        }
      } else files.push(read);
    }
    return {
      files,
      succeeded: files.filter((item) => item.ok).length,
      failed: files.filter((item) => !item.ok).length,
      outputBytes,
      outputLimitBytes: this.config.maxOutputBytes,
      truncated: files.some((item) => item.truncated),
    };
  }

  async fileInfo({ path: requested, hash = false }) {
    const filePath = resolveAllowedPath(requested, this.config, { access: "read" });
    const stat = await withTimeout(fs.promises.lstat(filePath), this.config.ioTimeoutMs, `Stat ${filePath}`);
    const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
    const result = {
      path: filePath,
      type,
      size: stat.size,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
      readable: true,
      writableByBridge: this.config.writeRoots.some((root) => isWithin(root.realPath, filePath)),
    };
    if (stat.isSymbolicLink()) result.linkTarget = await fs.promises.readlink(filePath);
    if (hash && stat.isFile()) result.sha256 = await withTimeout(sha256File(filePath), this.config.ioTimeoutMs, `Hash ${filePath}`);
    return result;
  }

  async readImage({ path: requested }) {
    const filePath = resolveAllowedPath(requested, this.config, { access: "read" });
    const extension = path.extname(filePath).toLowerCase();
    const mimeTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]]);
    const mimeType = mimeTypes.get(extension);
    if (!mimeType) throw new Error("Supported image formats are PNG, JPEG, GIF, and WebP.");
    const { stat, buffer } = await readBuffer(filePath, this.config.maxImageBytes, this.config.ioTimeoutMs);
    return { path: filePath, size: stat.size, mimeType, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), data: buffer.toString("base64") };
  }

  async writeFile({ path: requested, content, expectedSha256 = "" }) {
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > this.config.maxWriteBytes) throw new Error(`File content exceeds ${this.config.maxWriteBytes} bytes.`);
    const filePath = resolveAllowedPath(requested, this.config, { mustExist: false });
    const existed = fs.existsSync(filePath);
    if (expectedSha256) {
      if (!existed) throw new Error("expectedSha256 was provided but the file does not exist.");
      const current = await withTimeout(sha256File(filePath), this.config.ioTimeoutMs, `Hash ${filePath}`);
      if (current !== expectedSha256) throw new Error("File changed since it was read; refusing to overwrite it.");
    }
    await atomicWrite(filePath, content);
    return { path: filePath, created: !existed, bytes: contentBytes, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  }

  async replaceText({ path: requested, search, replacement, expectedSha256 = "", replaceAll = false }) {
    const filePath = resolveAllowedPath(requested, this.config);
    const { buffer } = await readBuffer(filePath, this.config.maxWriteBytes, this.config.ioTimeoutMs);
    const currentHash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (expectedSha256 && currentHash !== expectedSha256) {
      throw new Error("File changed since it was read; refusing to edit it.");
    }
    if (buffer.includes(0)) throw new Error("Binary files cannot be edited as text.");
    const current = buffer.toString("utf8");
    const count = current.split(search).length - 1;
    if (count === 0) throw new Error("Search text was not found.");
    if (!replaceAll && count !== 1) throw new Error(`Search text occurs ${count} times; set replaceAll=true or provide more context.`);
    const updated = replaceAll ? current.split(search).join(replacement) : current.replace(search, replacement);
    if (Buffer.byteLength(updated, "utf8") > this.config.maxWriteBytes) throw new Error(`Edited file exceeds ${this.config.maxWriteBytes} bytes.`);
    await atomicWrite(filePath, updated);
    return { path: filePath, replacements: replaceAll ? count : 1, sha256: crypto.createHash("sha256").update(updated).digest("hex") };
  }

  async createDirectory({ path: requested }) {
    const directory = resolveAllowedPath(requested, this.config, { mustExist: false });
    await fs.promises.mkdir(directory, { recursive: true });
    return { path: directory };
  }

  async applyPatch({ cwd = ".", patch, strip = 1, expectedSha256 = {} }) {
    if (typeof patch !== "string" || patch.trim().length === 0) throw new Error("patch must be a non-empty unified diff.");
    if (Buffer.byteLength(patch) > this.config.maxPatchBytes) throw new Error(`Patch exceeds ${this.config.maxPatchBytes} bytes.`);
    const workingDirectory = resolveAllowedPath(cwd, this.config, { expectDirectory: true });
    const targets = collectPatchTargets(patch, strip);
    const absoluteTargets = targets.map((target) => {
      const candidate = resolveAllowedPath(path.resolve(workingDirectory, target), this.config, { mustExist: false });
      if (!isWithin(workingDirectory, candidate)) throw new Error(`Patch target escapes cwd: ${target}`);
      return { target, path: candidate };
    });
    for (const [requested, expected] of Object.entries(expectedSha256 || {})) {
      const guarded = resolveAllowedPath(path.resolve(workingDirectory, requested), this.config);
      if (!isWithin(workingDirectory, guarded)) throw new Error(`Revision guard escapes cwd: ${requested}`);
      if ((await sha256File(guarded)) !== expected) throw new Error(`File changed since it was read: ${requested}`);
    }
    const executable = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
    const commonArgs = ["apply", "--whitespace=nowarn", "--recount", `-p${strip}`, "-"];
    const checked = await runWithInput(executable, ["apply", "--check", "--whitespace=nowarn", "--recount", `-p${strip}`, "-"], {
      cwd: workingDirectory,
      input: patch,
      timeoutMs: Math.max(this.config.ioTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    if (checked.timedOut) throw new Error("Patch validation timed out.");
    if (checked.code !== 0) throw new Error(`Patch validation failed: ${checked.stderr || checked.stdout || `exit ${checked.code}`}`);
    const applied = await runWithInput(executable, commonArgs, {
      cwd: workingDirectory,
      input: patch,
      timeoutMs: Math.max(this.config.ioTimeoutMs, 30_000),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    if (applied.timedOut) throw new Error("Patch application timed out.");
    if (applied.code !== 0) throw new Error(`Patch application failed: ${applied.stderr || applied.stdout || `exit ${applied.code}`}`);
    const files = [];
    for (const item of absoluteTargets) {
      if (!fs.existsSync(item.path)) files.push({ path: item.path, exists: false });
      else {
        const stat = await fs.promises.stat(item.path);
        files.push({ path: item.path, exists: true, size: stat.size, sha256: stat.isFile() && stat.size <= 20_000_000 ? await sha256File(item.path) : undefined });
      }
    }
    return { cwd: workingDirectory, files, patchBytes: Buffer.byteLength(patch), stdout: applied.stdout, stderr: applied.stderr, truncated: applied.truncated };
  }
}
