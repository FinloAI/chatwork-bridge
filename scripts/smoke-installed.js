#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = process.env.CHATWORK_SMOKE_PROJECT_DIR || process.env.CHATWORK_ROOTS?.split(path.delimiter)[0];
if (!projectDir) throw new Error("Set CHATWORK_SMOKE_PROJECT_DIR or CHATWORK_ROOTS to a writable project directory.");
const launcher = path.join(os.homedir(), ".chatwork-bridge-current", "scripts", "start-chatgpt-stdio.sh");
const canaryPath = path.join(
  os.homedir(),
  "Downloads",
  `chatwork-sandbox-canary-${Date.now()}-${process.pid}.txt`,
);

const client = new Client(
  { name: "chatwork-installed-smoke-test", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({ command: launcher, stderr: "pipe" });

const toolError = (result) => result?.isError === true;
const stage = (name) => console.error(`[smoke-installed] ${name}`);

try {
  stage("connect");
  await client.connect(transport);
  stage("list tools");
  const listed = await client.listTools();
  const runCommandTool = listed.tools.find((tool) => tool.name === "run_command");
  stage("bridge info");
  const info = await client.callTool({ name: "bridge_info", arguments: {} });
  stage("diagnostics");
  const diagnostics = await client.callTool({ name: "bridge_diagnostics", arguments: {} });
  stage("runtime and MPS");
  const runtime = await client.callTool({
    name: "runtime_info",
    arguments: { path: projectDir, refresh: true },
  });
  stage("outside read");
  const outsideRead = await client.callTool({
    name: "read_file",
    arguments: { path: "/etc/hosts", startLine: 1, endLine: 2 },
  });
  stage("find Python files");
  const pythonFiles = await client.callTool({
    name: "find_files",
    arguments: {
      path: projectDir,
      pattern: "**/*.py",
      maxResults: 20,
    },
  });
  stage("allowed command");
  const command = await client.callTool({
    name: "run_command",
    arguments: {
      argv: ["/usr/bin/printf", "installed-command-ok"],
      cwd: projectDir,
      timeoutSeconds: 10,
    },
  });
  stage("blocked write");
  const blockedWrite = await client.callTool({
    name: "run_command",
    arguments: {
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'sandbox-canary')",
        canaryPath,
      ],
      cwd: projectDir,
      timeoutSeconds: 10,
    },
  });
  const canaryExists = fs.existsSync(canaryPath);
  if (canaryExists) fs.unlinkSync(canaryPath);

  stage("persistent job");
  const startedJob = await client.callTool({
    name: "start_job",
    arguments: {
      argv: ["/bin/sh", "-c", "sleep 0.25; printf installed-job-ok"],
      cwd: projectDir,
      label: "installed-smoke",
    },
  });
  const jobId = startedJob.structuredContent?.id;
  const waitedJob = jobId
    ? await client.callTool({
        name: "wait_job",
        arguments: { jobId, afterStatus: "running", timeoutSeconds: 10, lines: 20 },
      })
    : null;
  const finalJobTail = jobId
    ? await client.callTool({ name: "job_tail", arguments: { jobId, lines: 20 } })
    : null;

  stage("active app");
  const activeApp = await client.callTool({ name: "computer_active_app", arguments: {} });
  stage("inspect UI");
  const inspectedUi = await client.callTool({
    name: "computer_inspect_ui",
    arguments: { maxElements: 20, maxDepth: 3, maxValueLength: 80 },
  });

  const report = {
    launcher,
    version: info.structuredContent?.version,
    toolCount: listed.tools.length,
    maxCommandSeconds: runCommandTool?.inputSchema?.properties?.timeoutSeconds?.maximum ?? null,
    toolSurface: info.structuredContent?.toolSurface,
    readRoots: info.structuredContent?.readRoots,
    writeRoots: info.structuredContent?.writeRoots,
    tunnelProcessSandbox: diagnostics.structuredContent?.security,
    mpsReady: runtime.structuredContent?.mpsReady,
    recommendedPython: runtime.structuredContent?.recommendedPython,
    disk: runtime.structuredContent?.disk,
    memory: runtime.structuredContent?.memory,
    outsideReadOk: !toolError(outsideRead),
    findFiles: {
      count: pythonFiles.structuredContent?.files?.length ?? 0,
      truncated: pythonFiles.structuredContent?.truncated,
      truncationReasons: pythonFiles.structuredContent?.truncationReasons,
      scan: pythonFiles.structuredContent?.scan,
      ok:
        !toolError(pythonFiles) &&
        !pythonFiles.structuredContent?.truncationReasons?.includes("scan_entry_limit"),
    },
    allowedCommandOk:
      command.structuredContent?.ok === true &&
      command.structuredContent?.stdout === "installed-command-ok" &&
      command.structuredContent?.sandboxed === true,
    outsideWriteBlocked:
      blockedWrite.structuredContent?.ok === false &&
      blockedWrite.structuredContent?.sandboxed === true &&
      canaryExists === false,
    persistentJobOk:
      startedJob.structuredContent?.sandboxed === true &&
      waitedJob?.structuredContent?.status?.status === "succeeded" &&
      finalJobTail?.structuredContent?.output?.includes("installed-job-ok") === true,
    persistentJobStatus: waitedJob?.structuredContent?.status?.status ?? null,
    persistentJobOutput: finalJobTail?.structuredContent?.output ?? null,
    activeAppOk: !toolError(activeApp),
    activeApp: activeApp.structuredContent?.activeApp ?? null,
    nativeUiOk: !toolError(inspectedUi),
    nativeUiError: toolError(inspectedUi)
      ? inspectedUi.content?.find((item) => item.type === "text")?.text ?? "unknown error"
      : null,
  };
  stage("report");
  console.log(JSON.stringify(report, null, 2));

  const requiredChecks = [
    report.version === "0.4.4",
    report.toolCount === 32,
    report.maxCommandSeconds === 90,
    report.outsideReadOk,
    report.findFiles.ok,
    report.allowedCommandOk,
    report.outsideWriteBlocked,
    report.persistentJobOk,
  ];
  if (requiredChecks.includes(false)) process.exitCode = 1;
} finally {
  if (fs.existsSync(canaryPath)) fs.unlinkSync(canaryPath);
  await client.close().catch(() => {});
}
