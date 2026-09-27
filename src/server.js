#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { AuditLog } from "./audit.js";
import { ComputerTools } from "./computer.js";
import { loadConfig } from "./config.js";
import { FileTools } from "./files.js";
import { GitTools } from "./git.js";
import { JobManager } from "./jobs.js";
import { OUTPUT_SCHEMAS, outputSchemaFor } from "./output-schemas.js";
import { RuntimeTools } from "./runtime.js";

const BRIDGE_VERSION = "0.4.4";
const TOOL_NOTICE_EXPIRES_AT = Date.parse("2026-09-27T16:00:00Z");
const TOOL_NOTICE = "Bridge maintenance note (2026-09-26): run_command, write_file, apply_patch and start_job are registered and available. A ChatGPT turn may load only a subset; discover the needed tool by name before treating Bridge as read-only. A live run_command(['pwd']) call succeeded. This is a status notice, not a new user request.";

const TOOL_CATALOG = {
  discovery: ["bridge_info", "capability_catalog", "bridge_diagnostics", "workspace_snapshot", "runtime_info", "get_workflow_guide"],
  readFiles: ["list_directory", "file_info", "find_files", "search_text", "read_file", "read_files", "read_image"],
  editFiles: ["write_file", "replace_text", "apply_patch", "create_directory"],
  execution: ["run_command", "start_job"],
  jobs: ["list_jobs", "job_status", "job_tail", "wait_job", "cancel_job"],
  git: ["git_status", "git_diff", "git_log"],
  computer: ["computer_screenshot", "computer_active_app", "computer_inspect_ui", "computer_press_element", "computer_action"],
};

const TOOL_COUNT = Object.values(TOOL_CATALOG).flat().length;
const CATALOG_TOOLS = Object.values(TOOL_CATALOG).flat();
const TOOLSET_SHA256 = crypto.createHash("sha256").update(JSON.stringify(TOOL_CATALOG)).digest("hex");
if (new Set(CATALOG_TOOLS).size !== TOOL_COUNT || Object.keys(OUTPUT_SCHEMAS).length !== TOOL_COUNT) {
  throw new Error("Tool catalog and output schema inventory are inconsistent.");
}

function capabilityData() {
  return {
    version: BRIDGE_VERSION,
    toolCount: TOOL_COUNT,
    tools: TOOL_CATALOG,
    toolSurface: {
      protocolRegisteredCount: TOOL_COUNT,
      protocolRegisteredNames: CATALOG_TOOLS,
      schemaSha256: TOOLSET_SHA256,
      clientVisibleCount: null,
      clientVisibilityObservable: false,
      note: "The MCP server can prove what it registers through tools/list, but it cannot observe or control a ChatGPT conversation's cached or task-selected callable subset. A small currently loaded subset must not be interpreted as proof that the server is read-only; rediscover the required edit, command, or job tools before making that claim.",
    },
    important: {
      localCommands: "run_command is hard-capped below the tunnel response deadline; start_job launches persistent training, data, build, or server jobs.",
      modelTraining: "runtime_info performs a real PyTorch MPS tensor probe; list_jobs recovers job IDs and wait_job efficiently waits for output or completion after reconnects.",
      fileScope: "Read tools use readRoots; writes, commands, and jobs remain restricted to writeRoots.",
      desktop: "computer_inspect_ui and computer_press_element provide bounded native macOS Accessibility semantics; screenshots and computer_action remain visible-UI fallbacks.",
      confirmation: "Mutating, command, cancellation, and desktop-action tools are intentionally marked high risk so ChatGPT can request confirmation; this does not mean they are unavailable.",
    },
  };
}

const PROJECT_MARKERS = new Set([
  "AGENTS.md", "README.md", "README", "package.json", "pyproject.toml", "requirements.txt",
  "Cargo.toml", "go.mod", "Makefile", "CMakeLists.txt", ".gitignore", "environment.yml",
]);

async function bridgeDiagnostics({ config, audit, jobs, computer }) {
  const inspectRoot = async (root, access) => {
    try {
      await fs.promises.access(root.realPath, access === "write" ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
      return { path: root.realPath, ok: true };
    } catch (error) {
      return { path: root.realPath, ok: false, error: error?.code || error?.message || String(error) };
    }
  };
  const readRoots = await Promise.all(config.readRoots.map((root) => inspectRoot(root, "read")));
  const writeRoots = await Promise.all(config.writeRoots.map((root) => inspectRoot(root, "write")));
  const recentJobs = await jobs.list({ limit: 20 }).catch(() => ({ jobs: [], total: 0 }));
  const runningJobs = recentJobs.jobs.filter((job) => job.alive);
  return {
    ok: readRoots.every((root) => root.ok) && writeRoots.every((root) => root.ok),
    version: BRIDGE_VERSION,
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      memory: process.memoryUsage(),
    },
    host: { platform: process.platform, architecture: process.arch, hostname: os.hostname() },
    readRoots,
    writeRoots,
    accessProfile: {
      name: config.readRoots.some((root) => root.realPath === "/")
        ? "full-machine-read-project-write"
        : "scoped-read-project-write",
      fullFilesystemRead: config.readRoots.some((root) => root.realPath === "/"),
      readScopeEnvironmentVariable: "CHATWORK_READ_ROOTS",
      writeScopeEnvironmentVariable: "CHATWORK_ROOTS",
    },
    toolSurface: capabilityData().toolSurface,
    state: { directory: config.stateDir, auditWritable: fs.existsSync(audit.path) || fs.existsSync(config.stateDir) },
    security: {
      processSandboxRequired: config.requireProcessSandbox,
      sensitiveCommandReadsAllowed: config.allowSensitiveCommandReads,
    },
    computer: {
      supported: process.platform === "darwin",
      nativeHelperAvailable: Boolean(computer.nativeHelperPath),
      nativeHelperPath: computer.nativeHelperPath || null,
    },
    jobs: { known: recentJobs.total, running: runningJobs.map((job) => ({ id: job.id, label: job.label, pid: job.pid })) },
    limits: {
      ioTimeoutMs: config.ioTimeoutMs,
      maxReadBytes: config.maxReadBytes,
      maxWriteBytes: config.maxWriteBytes,
      maxImageBytes: config.maxImageBytes,
      maxOutputBytes: config.maxOutputBytes,
      maxCommandSeconds: config.maxCommandSeconds,
      maxScanEntries: config.maxScanEntries,
      maxConcurrentJobs: config.maxConcurrentJobs,
      maxJobLogBytes: config.maxJobLogBytes,
      maxAuditLogBytes: config.maxAuditLogBytes,
    },
  };
}

async function workspaceSnapshot(requestedPath, { files, git, jobs }) {
  const info = await files.fileInfo({ path: requestedPath, hash: false });
  if (info.type !== "directory") throw new Error(`Workspace path is not a directory: ${requestedPath}`);
  const listing = await files.listDirectory({ path: info.path, depth: 2, includeHidden: true, maxEntries: 240 });
  const markers = listing.entries.filter((entry) => PROJECT_MARKERS.has(path.basename(entry.path)) || path.basename(entry.path) === ".git");
  const guidePaths = markers
    .filter((entry) => entry.type === "file" && ["AGENTS.md", "README.md", "README"].includes(path.basename(entry.path)))
    .slice(0, 6)
    .map((entry) => entry.path);
  const guides = guidePaths.length ? await files.readFiles({ paths: guidePaths, startLine: 1, endLine: 240 }) : { files: [], succeeded: 0, failed: 0 };
  let repository;
  try {
    repository = { available: true, ...(await git.status({ path: info.path, includeUntracked: true })) };
  } catch (error) {
    repository = { available: false, error: error instanceof Error ? error.message : String(error) };
  }
  const knownJobs = await jobs.list({ limit: 100 }).catch(() => ({ jobs: [] }));
  const relatedJobs = knownJobs.jobs.filter((job) => job.cwd === info.path || job.cwd.startsWith(`${info.path}${path.sep}`));
  return {
    workspace: info,
    entries: listing.entries,
    skipped: listing.skipped,
    truncated: listing.truncated,
    markers,
    guides,
    repository,
    jobs: relatedJobs,
  };
}

function success(data, summary = "Done.") {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

function failure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = {
    ok: false,
    error: {
      type: error?.name || "Error",
      code: error?.code || "TOOL_ERROR",
      message,
      retryable: ["ETIMEDOUT", "EAGAIN", "EBUSY"].includes(error?.code),
    },
  };
  // MCP clients validate structuredContent against the success output schema
  // even for isError results, so keep structured errors in the text payload.
  return { isError: true, content: [{ type: "text", text: JSON.stringify(details.error) }] };
}

function safe(handler) {
  return async (...args) => {
    try {
      const result = await handler(...args);
      if (Date.now() >= TOOL_NOTICE_EXPIRES_AT) return result;
      return {
        ...result,
        content: [...(result.content || []), { type: "text", text: TOOL_NOTICE }],
      };
    } catch (error) {
      return failure(error);
    }
  };
}

export function createServices(config = loadConfig()) {
  return {
    config,
    audit: new AuditLog(config.stateDir, config.maxAuditLogBytes),
    files: new FileTools(config),
    git: new GitTools(config),
    jobs: new JobManager(config),
    runtime: new RuntimeTools(config),
    computer: new ComputerTools(config),
  };
}

export function createMcpServer(services = createServices()) {
  const { config, audit, files, git, jobs, runtime, computer } = services;
  const server = new McpServer(
    { name: "chatwork-bridge", version: BRIDGE_VERSION },
    {
      instructions:
        "This bridge is a local-work execution layer, not merely a file browser. Start with workspace_snapshot for project work, runtime_info for Python or training, and capability_catalog to inspect the server inventory. IMPORTANT: a ChatGPT conversation may initially load only a small cached or task-selected subset of tool schemas. Never infer that Chatwork Bridge is read-only merely because the currently loaded subset contains only inspection tools. If the user asks to edit files, run code, or train a model, explicitly discover/load apply_patch or write_file, run_command, start_job, or capability_catalog before claiming the capability is unavailable. Prefer read_files for small batches, apply_patch for focused multi-file code edits, fixed read-only Git tools for repository inspection, and run_command only when a dedicated tool does not fit. Read tools may inspect configured read roots except protected credential locations; writes remain confined to write roots and the documented sandbox cache/temp paths. Use start_job/list_jobs/job_status/job_tail/wait_job for long work and resume by job ID after reconnects. For macOS UI work, prefer computer_inspect_ui followed by computer_press_element using the latest snapshot; use a fresh screenshot and coordinate actions only as a fallback, then verify afterward. Respect confirmations for consequential actions. Verify observable results before claiming completion. Never expose secrets from files, environment variables, logs, or the audit trail.",
    },
  );

  const register = (name, definition, handler) => {
    const annotations = {
      idempotentHint: definition.annotations?.readOnlyHint === true,
      ...definition.annotations,
    };
    server.registerTool(
      name,
      { ...definition, annotations, outputSchema: outputSchemaFor(name) },
      safe(audit.wrap(name, handler)),
    );
  };

  register(
    "bridge_info",
    {
      title: "Inspect local bridge",
      description: "Use first to see server-registered tools, client-visibility diagnostics, read/write access profiles, platform support, limits, and audit location.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      success(
        {
          roots: config.writeRoots.map((root) => root.realPath),
          readRoots: config.readRoots.map((root) => root.realPath),
          writeRoots: config.writeRoots.map((root) => root.realPath),
          accessProfile: {
            name: config.readRoots.some((root) => root.realPath === "/")
              ? "full-machine-read-project-write"
              : "scoped-read-project-write",
            fullFilesystemRead: config.readRoots.some((root) => root.realPath === "/"),
            intentionalForChatRuntime: config.readRoots.some((root) => root.realPath === "/"),
            tightenWith: "Set CHATWORK_READ_ROOTS to one or more narrower directories, then reinstall/restart the runtime.",
          },
          platform: process.platform,
          stateDir: config.stateDir,
          auditLog: audit.path,
          limits: {
            maxReadBytes: config.maxReadBytes,
            maxWriteBytes: config.maxWriteBytes,
            maxImageBytes: config.maxImageBytes,
            maxOutputBytes: config.maxOutputBytes,
            maxCommandSeconds: config.maxCommandSeconds,
            maxScanEntries: config.maxScanEntries,
            ioTimeoutMs: config.ioTimeoutMs,
            maxConcurrentJobs: config.maxConcurrentJobs,
            maxJobLogBytes: config.maxJobLogBytes,
            maxAuditLogBytes: config.maxAuditLogBytes,
          },
          ...capabilityData(),
          capabilities: {
            files: true,
            commands: true,
            persistentJobs: true,
            runtimeInspection: true,
            appleMps: process.platform === "darwin" && process.arch === "arm64",
            computerControl: process.platform === "darwin",
            semanticComputerControl: process.platform === "darwin" && Boolean(computer.nativeHelperPath),
          },
          security: "HTTP binds to loopback by default; read and write roots are independently allowlisted; credential paths are denied; the ChatGPT macOS runtime fails closed without its process sandbox; mutating tools are risk-annotated and audited.",
        },
        "Bridge is ready.",
      ),
  );

  register(
    "capability_catalog",
    {
      title: "List every local-work capability",
      description: "Return the server's complete categorized tool inventory for diagnosis. Use this before saying the Bridge is read-only when only inspection schemas are currently visible. If the client tool list is genuinely stale, refresh or reinstall the plugin and start a new conversation; this tool cannot mutate the client cache.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => success(capabilityData(), `Chatwork Bridge exposes ${TOOL_COUNT} tools.`),
  );

  register(
    "bridge_diagnostics",
    {
      title: "Diagnose the local bridge",
      description: "Check bridge process health, configured roots, state storage, output limits, and recoverable long jobs. Use after a timeout, reconnect, 404, or unexpected missing capability.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => success(await bridgeDiagnostics(services), "Bridge diagnostics complete."),
  );

  register(
    "workspace_snapshot",
    {
      title: "Inspect a local project and reveal execution eligibility",
      description: "Start or resume project work in one read-only call: inspect the directory, project instruction files, repository status, write eligibility, and related long-running jobs. This tool itself is read-only, but its presence does NOT mean Chatwork Bridge is read-only. When the requested task needs changes, commands, or training, discover/load apply_patch or write_file, run_command, start_job, or capability_catalog instead of claiming those capabilities are unavailable.",
      inputSchema: { path: z.string().default(".") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await workspaceSnapshot(args.path, services), "Workspace context collected."),
  );

  register(
    "runtime_info",
    {
      title: "Inspect local runtimes and Apple MPS",
      description: "Discover host executables and test whether an installed PyTorch can run a real tensor on Apple Metal Performance Shaders (MPS). Use before model training. When MPS is ready and training is requested, use start_job; if start_job is not in the currently loaded schema subset, rediscover it rather than inferring that training is unsupported.",
      inputSchema: {
        path: z.string().default(".").describe("Project directory used to discover local .venv/venv Python interpreters."),
        refresh: z.boolean().default(false).describe("Bypass the 60-second runtime probe cache."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await runtime.inspect(args), "Local runtime inspected."),
  );

  register(
    "get_workflow_guide",
    {
      title: "Read Work-style workflow",
      description: "Load the bridge's project continuation workflow when planning multi-step local work, model training, or desktop operation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const guideDirectory = path.dirname(config.skillPath);
      const [guide, modelTraining, computerControl] = await Promise.all([
        fs.promises.readFile(config.skillPath, "utf8"),
        fs.promises.readFile(path.join(guideDirectory, "references", "model-training.md"), "utf8"),
        fs.promises.readFile(path.join(guideDirectory, "references", "computer-control.md"), "utf8"),
      ]);
      return success({ guide, references: { modelTraining, computerControl } }, "Loaded the local-work guide and references.");
    },
  );

  register(
    "list_directory",
    {
      title: "List a readable directory",
      description: "Inspect files and folders anywhere under a configured read root. Unreadable macOS-protected locations are reported as skipped.",
      inputSchema: {
        path: z.string().default(".").describe("Absolute path under an allowed root, or a path relative to the first root."),
        depth: z.number().int().min(1).max(8).default(1),
        includeHidden: z.boolean().default(false),
        maxEntries: z.number().int().min(1).max(1000).default(300),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.listDirectory(args), "Directory inspected."),
  );

  register(
    "file_info",
    {
      title: "Inspect a local path",
      description: "Read metadata for a file, directory, or symlink, including size, mode, dates, optional SHA-256, and whether bridge writes are allowed there.",
      inputSchema: { path: z.string().min(1), hash: z.boolean().default(false) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.fileInfo(args), "Path inspected."),
  );

  register(
    "find_files",
    {
      title: "Find readable files",
      description: "Find files under a configured read root by a simple glob such as *.py, **/*.ts, or README*.",
      inputSchema: {
        path: z.string().default("."),
        pattern: z.string().max(500).default("*"),
        includeHidden: z.boolean().default(false),
        excludeDirectories: z.array(z.string()).max(50).optional().describe("Directory basenames to skip. Defaults to common generated/vendor directories."),
        maxResults: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.findFiles(args), "File search complete."),
  );

  register(
    "search_text",
    {
      title: "Search readable text",
      description: "Search text across reasonably sized files under a configured read root and return matching lines.",
      inputSchema: {
        path: z.string().default("."),
        query: z.string().min(1).max(500),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        includeHidden: z.boolean().default(false),
        excludeDirectories: z.array(z.string()).max(50).optional().describe("Directory basenames to skip. Defaults to common generated/vendor directories."),
        maxResults: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.searchText(args), "Text search complete."),
  );

  register(
    "read_file",
    {
      title: "Read a local text file",
      description: "Read a UTF-8 text file anywhere under a configured read root, with line numbers and a SHA-256 revision guard.",
      inputSchema: {
        path: z.string().min(1),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(0).default(0).describe("0 means the end of the file."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.readFile(args), "File read."),
  );

  register(
    "read_files",
    {
      title: "Read several local text files",
      description: "Read a small batch of UTF-8 files with line numbers and revision hashes, returning per-file errors instead of failing the whole batch. Use to inspect related project files efficiently.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(config.maxBatchFiles),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await files.readFiles(args), "File batch read."),
  );

  register(
    "read_image",
    {
      title: "View a local image",
      description: "Load a PNG, JPEG, GIF, or WebP image from a readable path so the model can visually inspect local screenshots, plots, diagrams, or assets.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const image = await files.readImage(args);
      return {
        structuredContent: { path: image.path, size: image.size, mimeType: image.mimeType, sha256: image.sha256 },
        content: [
          { type: "text", text: `Loaded local image ${image.path} (${image.size} bytes).` },
          { type: "image", data: image.data, mimeType: image.mimeType },
        ],
      };
    },
  );

  register(
    "write_file",
    {
      title: "Write a project file",
      description: "Create or overwrite one UTF-8 project file. Pass expectedSha256 after reading an existing file to prevent stale overwrites.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        expectedSha256: z.string().default(""),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => success(await files.writeFile(args), "File written."),
  );

  register(
    "replace_text",
    {
      title: "Make a focused text edit",
      description: "Replace an exact string in one file. By default refuses ambiguous multiple matches and supports a SHA-256 revision guard.",
      inputSchema: {
        path: z.string().min(1),
        search: z.string().min(1),
        replacement: z.string(),
        expectedSha256: z.string().default(""),
        replaceAll: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => success(await files.replaceText(args), "Text replaced."),
  );

  register(
    "apply_patch",
    {
      title: "Apply a focused project patch",
      description: "Validate and apply a standard unified diff to one or more files under an allowed project root. Use for precise multi-file code edits; optional SHA-256 guards prevent stale changes.",
      inputSchema: {
        cwd: z.string().default("."),
        patch: z.string().min(1).describe("Unified diff, normally using a/ and b/ prefixes."),
        strip: z.number().int().min(0).max(3).default(1),
        expectedSha256: z.record(z.string(), z.string()).default({}).describe("Optional map of paths relative to cwd to hashes returned by read_file/read_files."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => success(await files.applyPatch(args), "Patch validated and applied."),
  );

  register(
    "create_directory",
    {
      title: "Create a project directory",
      description: "Create a directory and missing parents under an allowed project root.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => success(await files.createDirectory(args), "Directory created."),
  );

  const argvSchema = z.array(z.string()).min(1).max(200).describe("Executable followed by individual arguments; no shell-string parsing.");
  const envSchema = z.record(z.string(), z.string()).default({}).describe("Optional environment overrides. Secret-looking values are redacted from audit logs.");

  register(
    "run_command",
    {
      title: "Run a local command",
      description: `Run a bounded command in an allowed project directory and return stdout/stderr. The hard maximum is ${config.maxCommandSeconds} seconds so the Secure MCP Tunnel cannot expire and poison the channel; use start_job for anything longer, including training, downloads, builds, or benchmarks.`,
      inputSchema: {
        argv: argvSchema,
        cwd: z.string().default("."),
        env: envSchema,
        timeoutSeconds: z.number().int().min(1).max(config.maxCommandSeconds).default(Math.min(60, config.maxCommandSeconds)),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => success(await jobs.run(args), "Command finished."),
  );

  register(
    "start_job",
    {
      title: "Start a long-running local job",
      description: "Start model training, data preparation, a dev server, or another long task. The process continues independently and writes a local log.",
      inputSchema: {
        argv: argvSchema,
        cwd: z.string().default("."),
        env: envSchema,
        label: z.string().max(120).default("task"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => success(await jobs.start(args), "Job started."),
  );

  register(
    "list_jobs",
    {
      title: "List local jobs",
      description: "Recover running and recent model-training, data, build, or server jobs after a reconnect or context change. Returns job IDs for job_status, job_tail, and wait_job.",
      inputSchema: {
        status: z.string().default("").describe("Optional exact status filter, for example running or succeeded."),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await jobs.list(args), "Local jobs listed."),
  );

  register(
    "job_status",
    {
      title: "Check a local job",
      description: "Check whether a previously started long-running job is alive and whether it succeeded or failed.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await jobs.status(args), "Job status read."),
  );

  register(
    "job_tail",
    {
      title: "Read a local job log",
      description: "Read the latest lines from a model-training or other long-running job log.",
      inputSchema: { jobId: z.string().min(1), lines: z.number().int().min(1).max(1000).default(120) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await jobs.tail(args), "Job log read."),
  );

  register(
    "wait_job",
    {
      title: "Wait for local job progress",
      description: "Wait up to 50 seconds for a job to finish, change status, or append log output. Use instead of rapid polling while training, building, or running a development server.",
      inputSchema: {
        jobId: z.string().min(1),
        afterStatus: z.string().default(""),
        afterBytes: z.number().int().min(-1).default(-1).describe("Previous job_tail fileSize; -1 disables output-change detection."),
        timeoutSeconds: z.number().int().min(1).max(50).default(30),
        lines: z.number().int().min(1).max(1000).default(120),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => success(await jobs.wait(args), "Job wait completed."),
  );

  register(
    "cancel_job",
    {
      title: "Cancel a local job",
      description: "Request termination of a long-running job and its process group. Use only after the user confirms cancellation.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => success(await jobs.cancel(args), "Cancellation requested."),
  );

  register(
    "git_status",
    {
      title: "Inspect Git working state",
      description: "Read repository branch, upstream divergence, staged, modified, unmerged, and untracked paths without changing Git state. Prefer this over a general command for project inspection.",
      inputSchema: { path: z.string().default("."), includeUntracked: z.boolean().default(true) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await git.status(args), "Git status inspected."),
  );

  register(
    "git_diff",
    {
      title: "Read a Git diff",
      description: "Read an unstaged, staged, or revision-based textual diff with bounded output. This tool never changes the repository.",
      inputSchema: {
        path: z.string().default("."),
        staged: z.boolean().default(false),
        base: z.string().max(240).default(""),
        file: z.string().default(""),
        context: z.number().int().min(0).max(20).default(3),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await git.diff(args), "Git diff read."),
  );

  register(
    "git_log",
    {
      title: "Read Git history",
      description: "Read recent structured commit history for a local repository without changing Git state.",
      inputSchema: { path: z.string().default("."), limit: z.number().int().min(1).max(100).default(20), revision: z.string().max(240).default("HEAD") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => success(await git.log(args), "Git history read."),
  );

  register(
    "computer_screenshot",
    {
      title: "Take a macOS screenshot",
      description: "Capture the current Mac screen. Use immediately before coordinate-based clicks and again afterward to verify the result.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const shot = await computer.screenshot();
      return {
        structuredContent: {
          path: shot.path,
          mimeType: shot.mimeType,
          bytes: shot.bytes,
          sha256: shot.sha256,
          capturedAt: shot.capturedAt,
          activeApp: shot.activeApp,
          coordinates: shot.coordinates,
        },
        content: [
          { type: "text", text: `Screenshot captured at ${shot.path}` },
          { type: "image", data: shot.data, mimeType: shot.mimeType },
        ],
      };
    },
  );

  register(
    "computer_active_app",
    {
      title: "Inspect active macOS app",
      description: "Read the name of the frontmost macOS application before deciding on a desktop action.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => success(await computer.activeApp(), "Active app inspected."),
  );

  register(
    "computer_inspect_ui",
    {
      title: "Inspect native macOS UI elements",
      description: "Read a bounded Accessibility snapshot of the frontmost app with stable element paths, roles, labels, values, bounds, and actions. Sensitive input values are redacted. Use its latest snapshotId and elementPath with computer_press_element.",
      inputSchema: {
        maxElements: z.number().int().min(1).max(500).default(200),
        maxDepth: z.number().int().min(0).max(10).default(6),
        maxValueLength: z.number().int().min(0).max(1000).default(256),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => success(await computer.inspectUi(args), "Native macOS UI inspected."),
  );

  register(
    "computer_press_element",
    {
      title: "Press an inspected macOS UI element",
      description: "Perform AXPress only on a pressable element from the latest, unexpired computer_inspect_ui snapshot. The frontmost app, element path, role, and title are revalidated immediately before the action.",
      inputSchema: {
        snapshotId: z.string().min(8).max(128),
        elementPath: z.string().regex(/^\d+(?:\.\d+){0,10}$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => success(await computer.pressElement(args), "Native macOS element pressed."),
  );

  register(
    "computer_action",
    {
      title: "Operate the macOS desktop",
      description: "Control the mouse with mouse_move, mouse_click (left/right/middle, single/double/triple), mouse_drag, and mouse_scroll (pixel deltas: positive Y down, X right). Coordinates are macOS global logical points, not Retina image pixels. Take a fresh screenshot before every mouse action and verify afterward. Also supports typing, keys, legacy click/page-scroll, apps and URLs.",
      // MCP SDK registration requires an object shape; a top-level union was
      // advertised as an empty object. Per-action requirements are enforced by
      // normalizeComputerAction before any native event is delivered.
      inputSchema: {
        action: z.enum(["click", "mouse_move", "mouse_click", "mouse_drag", "mouse_scroll", "type", "key", "scroll", "open_app", "open_url"]),
        x: z.number().optional(), y: z.number().optional(),
        toX: z.number().optional(), toY: z.number().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        clickCount: z.number().int().min(1).max(3).optional(),
        durationMs: z.number().int().min(100).max(3000).optional(),
        deltaX: z.number().int().min(-2000).max(2000).optional(),
        deltaY: z.number().int().min(-2000).max(2000).optional(),
        text: z.string().optional(), key: z.string().min(1).optional(),
        modifiers: z.array(z.enum(["command", "control", "option", "shift"])).max(4).optional(),
        amount: z.number().int().min(-10).max(10).optional(),
        app: z.string().min(1).optional(), url: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => success(await computer.action(args), "Computer action completed."),
  );

  return server;
}

function authorize(config, req, res) {
  if (!config.token) return true;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-chatwork-token"];
  const supplied = Buffer.from(String(bearer || ""));
  const expected = Buffer.from(config.token);
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true;
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  return false;
}

export async function startHttp(services = createServices()) {
  const { config } = services;
  const app = createMcpExpressApp({ host: config.host });
  app.get("/healthz", (_req, res) => res.json({ ok: true, name: "chatwork-bridge", version: BRIDGE_VERSION, toolCount: TOOL_COUNT }));
  app.post("/mcp", async (req, res) => {
    if (!authorize(config, req, res)) return;
    const mcpServer = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    } finally {
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

  return await new Promise((resolve, reject) => {
    const listener = app.listen(config.port, config.host, (error) => {
      if (error) reject(error);
      else {
        console.error(`Chatwork Bridge listening on http://${config.host}:${config.port}/mcp`);
        resolve(listener);
      }
    });
  });
}

export async function startStdio(services = createServices()) {
  const server = createMcpServer(services);
  await server.connect(new StdioServerTransport());
  console.error("Chatwork Bridge connected over stdio.");
  return server;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const services = createServices();
  if (process.argv.includes("--stdio")) await startStdio(services);
  else await startHttp(services);
}
