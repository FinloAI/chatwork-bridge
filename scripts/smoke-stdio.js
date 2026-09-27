#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "chatwork-stdio-smoke-test", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDir, "src/server.js"), "--stdio"],
  env: {
    ...process.env,
    CHATWORK_ROOTS: process.env.CHATWORK_ROOTS || projectDir,
    CHATWORK_STATE_DIR: process.env.CHATWORK_STATE_DIR || path.join(os.tmpdir(), "chatwork-bridge-smoke"),
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const info = await client.callTool({ name: "bridge_info", arguments: {} });
  const diagnostics = await client.callTool({ name: "bridge_diagnostics", arguments: {} });
  const snapshot = await client.callTool({ name: "workspace_snapshot", arguments: { path: projectDir } });
  const command = await client.callTool({
    name: "run_command",
    arguments: { argv: [process.execPath, "-e", "process.stdout.write('command-ok')"], cwd: projectDir, timeoutSeconds: 10 },
  });
  const outsideRead = await client.callTool({ name: "read_file", arguments: { path: "/etc/hosts", startLine: 1, endLine: 2 } });
  console.log(JSON.stringify({
    transport: "stdio",
    toolCount: tools.tools.length,
    readRoots: info.structuredContent.readRoots,
    writeRoots: info.structuredContent.writeRoots,
    diagnosticsOk: diagnostics.structuredContent?.ok === true,
    workspaceOk: snapshot.structuredContent?.workspace?.path === projectDir,
    commandOk: command.structuredContent?.status === "succeeded" && command.structuredContent?.stdout === "command-ok",
    outsideReadOk: outsideRead.isError !== true,
  }, null, 2));
} finally {
  await client.close().catch(() => {});
}
