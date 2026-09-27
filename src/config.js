import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new Error(`Expected a boolean environment value, received: ${value}`);
}

function parseRoots(rawValue, fallbackRoots) {
  const rawRoots = rawValue?.trim() ? rawValue.split(path.delimiter) : fallbackRoots;
  const roots = [...new Set(rawRoots.map((root) => path.resolve(expandHome(root.trim()))))];
  if (roots.length === 0) throw new Error("At least one filesystem root is required.");

  return roots.map((root) => {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
    return { path: root, realPath: fs.realpathSync(root) };
  });
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  // CHATWORK_ROOTS remains the hard boundary for every mutating operation.
  // CHATWORK_READ_ROOTS may be broader without expanding write/command access.
  const writeRoots = parseRoots(env.CHATWORK_ROOTS, [cwd]);
  const readRoots = parseRoots(env.CHATWORK_READ_ROOTS, writeRoots.map((root) => root.path));

  const host = env.CHATWORK_HOST || "127.0.0.1";
  const token = env.CHATWORK_TOKEN || "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host) && env.CHATWORK_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing a non-loopback listener. Set CHATWORK_ALLOW_REMOTE=1 only behind TLS and authentication.");
  }
  if (!loopbackHosts.has(host) && !token) {
    throw new Error("CHATWORK_TOKEN is required for a non-loopback listener.");
  }

  const stateDir = path.resolve(
    expandHome(env.CHATWORK_STATE_DIR || path.join(writeRoots[0].path, ".chatwork-bridge")),
  );

  return {
    host,
    port: parsePositiveInt(env.CHATWORK_PORT, 7337),
    token,
    roots: writeRoots,
    writeRoots,
    readRoots,
    stateDir,
    maxReadBytes: parsePositiveInt(env.CHATWORK_MAX_READ_BYTES, 1_000_000),
    maxWriteBytes: parsePositiveInt(env.CHATWORK_MAX_WRITE_BYTES, 5_000_000),
    maxImageBytes: parsePositiveInt(env.CHATWORK_MAX_IMAGE_BYTES, 12_000_000),
    maxOutputBytes: parsePositiveInt(env.CHATWORK_MAX_OUTPUT_BYTES, 200_000),
    // Secure MCP Tunnel currently expires a tool response at roughly 120s.
    // Keep synchronous commands comfortably below that boundary; longer work
    // belongs in the persistent job supervisor.
    maxCommandSeconds: Math.min(parsePositiveInt(env.CHATWORK_MAX_COMMAND_SECONDS, 90), 90),
    maxSearchResults: parsePositiveInt(env.CHATWORK_MAX_SEARCH_RESULTS, 300),
    maxScanEntries: parsePositiveInt(env.CHATWORK_MAX_SCAN_ENTRIES, 50_000),
    maxBatchFiles: parsePositiveInt(env.CHATWORK_MAX_BATCH_FILES, 20),
    maxPatchBytes: parsePositiveInt(env.CHATWORK_MAX_PATCH_BYTES, 1_000_000),
    ioTimeoutMs: parsePositiveInt(env.CHATWORK_IO_TIMEOUT_MS, 15_000),
    maxConcurrentJobs: parsePositiveInt(env.CHATWORK_MAX_CONCURRENT_JOBS, 8),
    maxJobLogBytes: parsePositiveInt(env.CHATWORK_MAX_JOB_LOG_BYTES, 100_000_000),
    maxAuditLogBytes: parsePositiveInt(env.CHATWORK_MAX_AUDIT_LOG_BYTES, 20_000_000),
    requireProcessSandbox: parseBoolean(env.CHATWORK_REQUIRE_PROCESS_SANDBOX, false),
    allowSensitiveCommandReads: parseBoolean(env.CHATWORK_ALLOW_SENSITIVE_COMMAND_READS, false),
    skillPath: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../skills/continue-local-work/SKILL.md",
    ),
  };
}
