import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createServices } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { FileTools } from "../src/files.js";
import { JobManager } from "../src/jobs.js";
import { buildProcessEnv } from "../src/environment.js";
import { resolveAllowedPath } from "../src/security.js";

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chatwork-bridge-test-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const config = loadConfig(
    {
      CHATWORK_ROOTS: root,
      CHATWORK_STATE_DIR: path.join(root, ".state"),
      CHATWORK_HOST: "127.0.0.1",
      CHATWORK_PORT: "7337",
    },
    root,
  );
  return {
    base,
    root,
    outside,
    config,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("path policy allows roots and blocks traversal and symlink escapes", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.root, "ok.txt"), "ok");
    fs.writeFileSync(path.join(item.outside, "secret.txt"), "secret");
    fs.symlinkSync(item.outside, path.join(item.root, "escape"));
    assert.equal(resolveAllowedPath("ok.txt", item.config), path.join(fs.realpathSync(item.root), "ok.txt"));
    assert.throws(() => resolveAllowedPath("../outside/secret.txt", item.config), /outside the configured write roots/);
    assert.throws(() => resolveAllowedPath("escape/secret.txt", item.config), /outside the configured write roots/);
  } finally {
    item.cleanup();
  }
});

test("read roots may be broader without expanding write access", async () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.outside, "readable.txt"), "outside-read");
    const config = loadConfig(
      {
        CHATWORK_ROOTS: item.root,
        CHATWORK_READ_ROOTS: `${item.root}${path.delimiter}${item.outside}`,
        CHATWORK_STATE_DIR: path.join(item.root, ".state-read-scope"),
        CHATWORK_HOST: "127.0.0.1",
      },
      item.root,
    );
    const tools = new FileTools(config);
    const read = await tools.readFile({ path: path.join(item.outside, "readable.txt") });
    assert.match(read.content, /outside-read/);
    await assert.rejects(
      tools.writeFile({ path: path.join(item.outside, "blocked.txt"), content: "no" }),
      /outside the configured write roots/,
    );
    assert.equal(fs.existsSync(path.join(item.outside, "blocked.txt")), false);
  } finally {
    item.cleanup();
  }
});

test("file edits use revision hashes to prevent stale overwrites", async () => {
  const item = fixture();
  try {
    const tools = new FileTools(item.config);
    await tools.writeFile({ path: "note.txt", content: "first" });
    const read = await tools.readFile({ path: "note.txt" });
    await tools.replaceText({ path: "note.txt", search: "first", replacement: "second", expectedSha256: read.sha256 });
    await assert.rejects(
      tools.writeFile({ path: "note.txt", content: "stale", expectedSha256: read.sha256 }),
      /changed since it was read/,
    );
    assert.equal(fs.readFileSync(path.join(item.root, "note.txt"), "utf8"), "second");
  } finally {
    item.cleanup();
  }
});

test("short commands and persistent jobs produce inspectable output", async () => {
  const item = fixture();
  try {
    const jobs = new JobManager(item.config);
    const quick = await jobs.run({ argv: [process.execPath, "-e", "console.log('quick-ok')"], cwd: "." });
    assert.equal(quick.exitCode, 0);
    assert.match(quick.output, /quick-ok/);

    const started = await jobs.start({ argv: [process.execPath, "-e", "console.log('job-ok')"], cwd: ".", label: "test" });
    let status = await jobs.status({ jobId: started.id });
    let tail = await jobs.tail({ jobId: started.id, lines: 20 });
    for (let index = 0; index < 80 && !tail.output.includes("job-ok"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jobs.status({ jobId: started.id });
      tail = await jobs.tail({ jobId: started.id, lines: 20 });
    }
    assert.match(tail.output, /job-ok/);
    for (let index = 0; index < 80 && status.status === "running"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await jobs.status({ jobId: started.id });
    }
    assert.ok(["succeeded", "finished-unknown"].includes(status.status));
    const listed = await jobs.list({ limit: 10 });
    assert.equal(listed.total, 1);
    assert.equal(listed.jobs[0].id, started.id);
    assert.equal(listed.jobs[0].label, "test");
  } finally {
    item.cleanup();
  }
});

test("runtime environment includes common macOS developer paths", () => {
  const env = buildProcessEnv({}, { PATH: "/usr/bin", PYTHONUNBUFFERED: "" });
  assert.match(env.PATH, /\/usr\/local\/bin/);
  assert.match(env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(env.PYTHONUNBUFFERED, "1");
});

test("MCP initialization advertises the expected work tools", async () => {
  const item = fixture();
  const services = createServices(item.config);
  const server = createMcpServer(services);
  const client = new Client({ name: "bridge-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    const runCommand = listed.tools.find((tool) => tool.name === "run_command");
    const desktop = listed.tools.find((tool) => tool.name === "computer_action").inputSchema;
    assert.ok(desktop.properties.action.enum.includes("mouse_click"));
    assert.ok(desktop.properties.x && desktop.properties.toX && desktop.properties.text);
    assert.ok(desktop.required.includes("action"));
    const workspaceSnapshot = listed.tools.find((tool) => tool.name === "workspace_snapshot");
    const runtimeInfo = listed.tools.find((tool) => tool.name === "runtime_info");
    for (const name of ["bridge_info", "capability_catalog", "bridge_diagnostics", "workspace_snapshot", "runtime_info", "file_info", "read_file", "read_files", "read_image", "write_file", "apply_patch", "run_command", "start_job", "list_jobs", "wait_job", "git_status", "git_diff", "git_log", "computer_screenshot", "computer_inspect_ui", "computer_press_element", "computer_action"]) {
      assert.ok(names.has(name), `missing tool: ${name}`);
    }
    assert.equal(names.size, 32);
    assert.equal(runCommand.inputSchema.properties.timeoutSeconds.maximum, 90);
    assert.match(workspaceSnapshot.description, /does NOT mean Chatwork Bridge is read-only/);
    assert.match(workspaceSnapshot.description, /apply_patch/);
    assert.match(workspaceSnapshot.description, /start_job/);
    assert.match(runtimeInfo.description, /rediscover it rather than inferring that training is unsupported/);
    const info = await client.callTool({ name: "bridge_info", arguments: {} });
    assert.equal(info.isError, undefined);
    assert.deepEqual(info.structuredContent.roots, [fs.realpathSync(item.root)]);
    assert.deepEqual(info.structuredContent.readRoots, [fs.realpathSync(item.root)]);
    assert.deepEqual(info.structuredContent.writeRoots, [fs.realpathSync(item.root)]);
    assert.equal(info.structuredContent.toolCount, 32);
    assert.ok(info.structuredContent.tools.execution.includes("run_command"));
    assert.equal(info.structuredContent.toolSurface.protocolRegisteredCount, 32);
    assert.equal(info.structuredContent.toolSurface.clientVisibilityObservable, false);
    assert.equal(info.structuredContent.toolSurface.protocolRegisteredNames.length, 32);
    assert.equal(info.structuredContent.limits.maxCommandSeconds, 90);
    assert.match(info.structuredContent.toolSurface.schemaSha256, /^[a-f0-9]{64}$/);
    assert.equal(info.structuredContent.accessProfile.fullFilesystemRead, false);
    const catalog = await client.callTool({ name: "capability_catalog", arguments: {} });
    assert.equal(catalog.structuredContent.toolCount, 32);
    assert.equal(catalog.structuredContent.toolSurface.protocolRegisteredCount, 32);
    assert.ok(catalog.structuredContent.tools.computer.includes("computer_action"));
    assert.ok(catalog.structuredContent.tools.computer.includes("computer_inspect_ui"));
    const invalidClick = await client.callTool({ name: "computer_action", arguments: { action: "click" } });
    assert.equal(invalidClick.isError, true);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    item.cleanup();
  }
});
