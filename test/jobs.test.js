import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { JobManager } from "../src/jobs.js";

function fixture(overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chatwork-jobs-test-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const config = loadConfig({
    CHATWORK_ROOTS: root,
    CHATWORK_STATE_DIR: path.join(root, ".state"),
    CHATWORK_MAX_OUTPUT_BYTES: "256",
    CHATWORK_MAX_JOB_LOG_BYTES: "1024",
    ...overrides,
  }, root);
  return {
    base,
    root,
    outside,
    config,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

async function waitForStatus(manager, id, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await manager.status({ jobId: id });
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for job ${id}; last status was ${status?.status}`);
}

function processIsActive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (os.platform() === "win32") return true;
  const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && !result.stdout.trim().startsWith("Z");
}

test("run returns structured bounded output and preserves the newest bytes", async () => {
  const item = fixture({ CHATWORK_MAX_OUTPUT_BYTES: "96" });
  try {
    const manager = new JobManager(item.config);
    const result = await manager.run({
      argv: [process.execPath, "-e", "process.stdout.write('A'.repeat(200));setTimeout(()=>process.stdout.write('B'.repeat(200)),20)"],
      timeoutSeconds: 5,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, true);
    assert.equal(result.outputBytes.stdout, 400);
    assert.ok(Buffer.byteLength(result.stdout) <= 96);
    assert.match(result.stdout, /^B+$/);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(typeof result.sandboxed, "boolean");
    if (!result.sandboxed) assert.match(result.sandboxWarning, /sandbox/i);
  } finally {
    item.cleanup();
  }
});

test("run_command timeout is hard-capped below the tunnel response deadline", async () => {
  const item = fixture({ CHATWORK_MAX_COMMAND_SECONDS: "300" });
  try {
    assert.equal(item.config.maxCommandSeconds, 90);
    const manager = new JobManager(item.config);
    const result = await manager.run({
      argv: [process.execPath, "-e", "process.stdout.write('bounded')"],
      timeoutSeconds: 300,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.timeoutSeconds, 90);
  } finally {
    item.cleanup();
  }
});

test("run timeout escalates and removes a stubborn descendant process", { skip: os.platform() === "win32" }, async () => {
  const item = fixture();
  let descendantPid;
  try {
    const pidPath = path.join(item.root, "descendant.pid");
    const descendantSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parentSource = [
      "const fs=require('node:fs')",
      "const {spawn}=require('node:child_process')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'})`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(";");
    const manager = new JobManager(item.config);
    const result = await manager.run({ argv: [process.execPath, "-e", parentSource], timeoutSeconds: 1 });
    assert.equal(result.status, "timed-out");
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(result.durationMs >= 1_000 && result.durationMs < 5_000, `unexpected duration ${result.durationMs}`);
    descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
    for (let index = 0; index < 40 && processIsActive(descendantPid); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(processIsActive(descendantPid), false);
  } finally {
    if (processIsActive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    item.cleanup();
  }
});

test("a detached supervisor preserves exact exit status across bridge restart", async () => {
  const item = fixture();
  try {
    const moduleUrl = new URL("../src/jobs.js", import.meta.url).href;
    const launcher = [
      "const {JobManager}=await import(process.argv[1])",
      "const config=JSON.parse(process.argv[2])",
      "const manager=new JobManager(config)",
      "const job=await manager.start({argv:[process.execPath,'-e','setTimeout(()=>process.exit(7),150)'],label:'recovery-test'})",
      "process.stdout.write(JSON.stringify(job))",
    ].join(";");
    const launched = spawnSync(process.execPath, ["--input-type=module", "-e", launcher, moduleUrl, JSON.stringify(item.config)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const started = JSON.parse(launched.stdout);
    const recovered = new JobManager(item.config);
    const status = await waitForStatus(recovered, started.id, (value) => !["running", "cancelling"].includes(value.status));
    assert.equal(status.status, "failed");
    assert.equal(status.exitCode, 7);
    assert.equal(status.alive, false);
    assert.equal(Number.isInteger(status.commandPid), true);
    assert.equal(status.supervised, true);
  } finally {
    item.cleanup();
  }
});

test("persistent logs rotate, remain bounded, and tail reports truncation", async () => {
  const item = fixture({ CHATWORK_MAX_OUTPUT_BYTES: "100", CHATWORK_MAX_JOB_LOG_BYTES: "128" });
  try {
    const manager = new JobManager(item.config);
    const started = await manager.start({
      argv: [process.execPath, "-e", "process.stdout.write('A'.repeat(300));setTimeout(()=>process.stdout.write('\\nLAST-LINE\\n'),30)"],
      label: "rotating-log",
    });
    await waitForStatus(manager, started.id, (value) => !["running", "cancelling"].includes(value.status));
    const tail = await manager.tail({ jobId: started.id, lines: 1 });
    assert.equal(tail.output, "LAST-LINE");
    assert.equal(tail.truncated, true);
    assert.ok(tail.bytesRead <= 100);
    for (const filePath of [manager.logPath(started.id), manager.previousLogPath(started.id)]) {
      if (fs.existsSync(filePath)) assert.ok(fs.statSync(filePath).size <= 128);
    }
  } finally {
    item.cleanup();
  }
});

test("cancellation escalates and reaches a terminal cancelled state", async () => {
  const item = fixture();
  try {
    const manager = new JobManager(item.config);
    const started = await manager.start({
      argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      label: "cancel-test",
    });
    const cancellation = await manager.cancel({ jobId: started.id });
    assert.equal(cancellation.status, "cancelling");
    assert.equal(cancellation.stopped, true);
    const status = await waitForStatus(manager, started.id, (value) => value.status === "cancelled");
    assert.equal(status.alive, false);
    assert.ok(status.cancelRequestedAt);
  } finally {
    item.cleanup();
  }
});

test("concurrent job starts honor the configured limit", async () => {
  const item = fixture({ CHATWORK_MAX_CONCURRENT_JOBS: "1" });
  try {
    const manager = new JobManager(item.config);
    const first = await manager.start({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], label: "first" });
    await assert.rejects(
      manager.start({ argv: [process.execPath, "-e", "console.log('second')"], label: "second" }),
      /Concurrent job limit reached/,
    );
    await manager.cancel({ jobId: first.id });
    await waitForStatus(manager, first.id, (value) => value.status === "cancelled");
  } finally {
    item.cleanup();
  }
});

test("wait returns when a persistent job produces output or completes", async () => {
  const item = fixture();
  try {
    const manager = new JobManager(item.config);
    const started = await manager.start({
      argv: [process.execPath, "-e", "setTimeout(()=>console.log('progress'),100);setTimeout(()=>{},1000)"],
      label: "wait-test",
    });
    const waited = await manager.wait({
      jobId: started.id,
      afterStatus: "running",
      afterBytes: 0,
      timeoutSeconds: 3,
      lines: 20,
    });
    assert.equal(waited.timedOut, false);
    assert.match(waited.tail.output, /progress/);
    await manager.cancel({ jobId: started.id });
    await waitForStatus(manager, started.id, (value) => value.status === "cancelled");
  } finally {
    item.cleanup();
  }
});

test("sandbox profile permits configured roots but not arbitrary absolute paths", () => {
  const item = fixture();
  try {
    const manager = new JobManager(item.config);
    const profile = manager.sandboxProfile();
    assert.match(profile, /deny file-write\*/);
    assert.match(profile, /deny file-read\*/);
    assert.ok(profile.includes(JSON.stringify(path.join(os.homedir(), ".ssh"))));
    assert.ok(profile.includes(JSON.stringify(fs.realpathSync(item.root))));
    assert.equal(profile.includes(JSON.stringify(fs.realpathSync(item.outside))), false);
  } finally {
    item.cleanup();
  }
});

test("macOS process sandbox blocks an absolute-path write outside configured roots", {
  skip: os.platform() !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") || Boolean(process.env.CODEX_SANDBOX),
}, async () => {
  const item = fixture();
  try {
    const manager = new JobManager(item.config);
    const allowedPath = path.join(item.root, "allowed.txt");
    const blockedPath = path.join(item.outside, "blocked.txt");
    const allowed = await manager.run({ argv: ["/usr/bin/touch", allowedPath] });
    const blocked = await manager.run({ argv: ["/usr/bin/touch", blockedPath] });
    assert.equal(allowed.sandboxed, true);
    assert.equal(allowed.exitCode, 0);
    assert.notEqual(blocked.exitCode, 0);
    assert.equal(fs.existsSync(blockedPath), false);
  } finally {
    item.cleanup();
  }
});
