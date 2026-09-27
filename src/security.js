import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PATH_BYTES = 32_768;
const MAX_ARG_BYTES = 32_000;
const MAX_ARGV_BYTES = 1_000_000;
const MAX_REDACTION_DEPTH = 24;
const MAX_AUDIT_STRING_BYTES = 32_000;
const stateDirCache = new WeakMap();

export function isWithin(parent, candidate) {
  if (typeof parent !== "string" || typeof candidate !== "string") return false;
  const normalizedParent = path.resolve(parent);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function nearestExistingAncestor(target) {
  let current = target;
  while (true) {
    try {
      // lstat sees dangling symlinks. Treating one as an existing ancestor makes
      // realpath fail closed instead of rebuilding a path through it.
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function configuredRoots(config, access) {
  if (access !== "read" && access !== "write") {
    throw new Error('Path access must be either "read" or "write".');
  }
  const roots = access === "read" ? config?.readRoots || config?.roots : config?.writeRoots || config?.roots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`No configured ${access} roots are available.`);
  }
  return roots.map((root) => {
    if (!root || typeof root.path !== "string" || root.path.length === 0) {
      throw new Error(`Invalid configured ${access} root.`);
    }
    const logicalPath = path.resolve(root.path);
    let realPath;
    try {
      realPath = fs.realpathSync.native(logicalPath);
      if (root.realPath && fs.realpathSync.native(root.realPath) !== realPath) {
        throw new Error("Configured root canonical path does not match its root path.");
      }
    } catch {
      throw new Error(`Configured ${access} root is unavailable: ${logicalPath}`);
    }
    return { logicalPath, realPath };
  });
}

function requestedPath(input) {
  if (input === undefined || input === null || input === "") return ".";
  if (typeof input !== "string") throw new Error("Path must be a string.");
  if (input.includes("\0")) throw new Error("Paths may not contain NUL bytes.");
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) throw new Error("Path is too long.");
  return input;
}

export function isProtectedInternalPath(candidate, config = {}) {
  if (typeof candidate !== "string") return true;
  const resolved = path.resolve(candidate);
  let stateDir = "";
  if (typeof config.stateDir === "string") {
    if (config && typeof config === "object" && stateDirCache.has(config)) {
      stateDir = stateDirCache.get(config);
    } else {
      const logicalStateDir = path.resolve(config.stateDir);
      try {
        stateDir = fs.realpathSync.native(logicalStateDir);
        if (config && typeof config === "object") stateDirCache.set(config, stateDir);
      } catch {
        stateDir = logicalStateDir;
      }
    }
  }
  if (stateDir && isWithin(stateDir, resolved)) return true;
  if (stateDir && resolved.split(path.sep).includes(path.basename(stateDir))) {
    try {
      const ancestor = nearestExistingAncestor(resolved);
      const canonicalCandidate = path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, resolved));
      if (isWithin(stateDir, canonicalCandidate)) return true;
    } catch {
      // Fail through to the reserved-directory-name check below.
    }
  }
  const segments = resolved.split(path.sep);
  return segments.includes(".chatwork-bridge");
}

export function sensitiveReadPolicy(config = {}) {
  const home = os.homedir();
  const directories = [
    typeof config.stateDir === "string" ? path.resolve(config.stateDir) : "",
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gcloud"),
    path.join(home, "Library", "Keychains"),
    "/Library/Keychains",
    "/System/Library/Keychains",
    path.join(home, "Library", "Safari"),
    path.join(home, "Library", "Containers", "com.apple.Safari"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Chromium"),
    path.join(home, "Library", "Application Support", "Microsoft Edge"),
    path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(home, "Library", "Application Support", "Arc", "User Data"),
    path.join(home, "Library", "Application Support", "com.operasoftware.Opera"),
    path.join(home, "Library", "Application Support", "Firefox", "Profiles"),
  ].filter(Boolean);
  const files = [
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".pypirc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".config", "gh", "hosts.yml"),
    path.join(home, ".docker", "config.json"),
    path.join(home, ".cache", "huggingface", "token"),
    path.join(home, ".huggingface", "token"),
    path.join(home, ".ollama", "id_ed25519"),
  ];
  return { directories, files };
}

export function isSensitiveReadPath(candidate, config = {}) {
  if (isProtectedInternalPath(candidate, config)) return true;
  if (typeof candidate !== "string") return true;
  const resolved = path.resolve(candidate);
  const policy = sensitiveReadPolicy(config);
  if (policy.directories.some((directory) => isWithin(directory, resolved))) return true;
  return policy.files.some((filePath) => path.resolve(filePath) === resolved);
}

export function resolveAllowedPath(input, config, options = {}) {
  const { mustExist = true, expectDirectory = false, access = "write" } = options;
  if (typeof mustExist !== "boolean" || typeof expectDirectory !== "boolean") {
    throw new Error("Path options must be booleans.");
  }
  const roots = configuredRoots(config, access);
  const requested = requestedPath(input);
  let candidateRoots = roots;
  if (access === "read" && !path.isAbsolute(requested)) {
    // Broad read roots such as "/" should not make relative paths unexpectedly
    // resolve from the filesystem root. Work-style calls expect "." and
    // "src/..." to start in the project/write root, with other read roots as
    // fallbacks for explicit exploration.
    const writeRoots = configuredRoots(config, "write");
    const unique = new Map();
    for (const root of [...writeRoots, ...roots]) unique.set(`${root.logicalPath}\0${root.realPath}`, root);
    candidateRoots = [...unique.values()];
  }
  const candidates = path.isAbsolute(requested)
    ? [path.resolve(requested)]
    : candidateRoots.map((root) => path.resolve(root.logicalPath, requested));

  for (const candidate of candidates) {
    for (const root of roots) {
      // Accept both the configured spelling and the canonical spelling of a
      // symlinked root, but never a path outside both.
      if (!isWithin(root.logicalPath, candidate) && !isWithin(root.realPath, candidate)) continue;

      let existingAncestor;
      let realAncestor;
      try {
        existingAncestor = nearestExistingAncestor(candidate);
        realAncestor = fs.realpathSync.native(existingAncestor);
      } catch {
        continue;
      }
      if (!isWithin(root.realPath, realAncestor)) continue;

      let candidateStat;
      try {
        candidateStat = fs.lstatSync(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }

      if (candidateStat) {
        let realCandidate;
        try {
          realCandidate = fs.realpathSync.native(candidate);
        } catch {
          // A dangling symlink is not a safe destination, even when creation
          // was requested.
          continue;
        }
        if (!isWithin(root.realPath, realCandidate)) continue;
        if (access === "read" ? isSensitiveReadPath(realCandidate, config) : isProtectedInternalPath(realCandidate, config)) continue;
        if (expectDirectory && !fs.statSync(realCandidate).isDirectory()) {
          throw new Error(`Expected a directory: ${requested}`);
        }
        return realCandidate;
      }

      if (mustExist) continue;
      const suffix = path.relative(existingAncestor, candidate);
      if (path.isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${path.sep}`)) continue;
      const rebuilt = path.resolve(realAncestor, suffix);
      if (!isWithin(root.realPath, rebuilt)) continue;
      if (access === "read" ? isSensitiveReadPath(rebuilt, config) : isProtectedInternalPath(rebuilt, config)) continue;
      return rebuilt;
    }
  }

  throw new Error(`Path is outside the configured ${access} roots or does not exist: ${requested}`);
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

const secretKey = /(secret|token|password|passwd|passphrase|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)/i;
const contentKey = /^(content|text|replacement|patch|diff|clipboard|body|payload|data|filedata|image|imagedata|base64|base64data)$/i;
const secretAssignment = /(^|[^A-Za-z0-9_])(secret|token|password|passwd|passphrase|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)(\s*[:=]\s*)([^\s,;]+)/gi;
const secretCliAssignment = /^(--?[^=]*(?:secret|token|password|passwd|passphrase|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)[^=]*=).+$/i;
const secretCliFlag = /^--?[A-Za-z0-9_.-]*(secret|token|password|passwd|passphrase|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*$/i;

function truncateAuditString(value) {
  if (Buffer.byteLength(value, "utf8") <= MAX_AUDIT_STRING_BYTES) return value;
  let end = Math.min(value.length, MAX_AUDIT_STRING_BYTES);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > MAX_AUDIT_STRING_BYTES) end -= 1;
  const kept = value.slice(0, end);
  return `${kept}…[TRUNCATED ${Buffer.byteLength(value, "utf8") - Buffer.byteLength(kept, "utf8")} BYTES]`;
}

function redactString(value) {
  let result = value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
    .replace(/\b((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(secretAssignment, (_match, prefix, name, separator) => `${prefix}${name}${separator}[REDACTED]`);
  if (secretCliAssignment.test(result)) result = result.replace(secretCliAssignment, "$1[REDACTED]");
  try {
    const parsed = new URL(result);
    for (const queryKey of [...parsed.searchParams.keys()]) {
      if (secretKey.test(queryKey)) parsed.searchParams.set(queryKey, "[REDACTED]");
    }
    result = parsed.toString();
  } catch {
    // Most audited strings are not URLs.
  }
  return truncateAuditString(result);
}

function redactValue(value, key, seen, depth) {
  if (secretKey.test(key)) return "[REDACTED]";
  if (contentKey.test(key)) {
    if (typeof value === "string") return `[REDACTED_CONTENT:${Buffer.byteLength(value, "utf8")} BYTES]`;
    if (Buffer.isBuffer(value)) return `[REDACTED_BINARY:${value.length} BYTES]`;
    if (Array.isArray(value)) return `[REDACTED_CONTENT:${value.length} ITEMS]`;
  }
  if (depth > MAX_REDACTION_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const previous = index > 0 ? String(value[index - 1]) : "";
        if (secretCliFlag.test(previous)) return "[REDACTED]";
        return redactValue(item, "", seen, depth + 1);
      });
    }
    if (Buffer.isBuffer(value)) return `[REDACTED_BINARY:${value.length} BYTES]`;
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey, seen, depth + 1)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function redact(value, key = "") {
  return redactValue(value, key, new WeakSet(), 0);
}

export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv must contain an executable.");
  if (argv.length > 200) throw new Error("argv is too long.");
  let totalBytes = 0;
  for (const item of argv) {
    const bytes = typeof item === "string" ? Buffer.byteLength(item, "utf8") : 0;
    if (typeof item !== "string" || item.length === 0 || bytes > MAX_ARG_BYTES || item.includes("\0")) {
      throw new Error("Every argv item must be a non-empty string under 32,000 bytes.");
    }
    totalBytes += bytes;
  }
  if (argv[0].trim().length === 0 || /[\u0000-\u001f\u007f]/.test(argv[0])) {
    throw new Error("argv[0] must be a valid executable name without control characters.");
  }
  if (totalBytes > MAX_ARGV_BYTES) throw new Error("Combined argv size exceeds 1,000,000 bytes.");
  return argv;
}
