#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = path.join(os.homedir(), ".chatwork-bridge-current", "scripts", "start-chatgpt-stdio.sh");
const dayParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(new Date());
const dayValues = Object.fromEntries(dayParts.map(({ type, value }) => [type, value]));
const day = `${dayValues.year}-${dayValues.month}-${dayValues.day}`;
const projectRoot = process.env.CHATWORK_SMOKE_PROJECT_DIR || process.env.CHATWORK_ROOTS?.split(path.delimiter)[0];
if (!projectRoot) throw new Error("Set CHATWORK_SMOKE_PROJECT_DIR or CHATWORK_ROOTS to a writable project directory.");
const runDirectory = path.join(projectRoot, `chatwork-bridge-mps-e2e-${day}-${Date.now()}`);
const scriptPath = path.join(runDirectory, "tiny_mps_train.py");
const metricsPath = path.join(runDirectory, "metrics.json");
const source = [
  "import json",
  "from pathlib import Path",
  "import torch",
  "",
  "STEPS = 20",
  "torch.manual_seed(7)",
  "device = torch.device('mps')",
  "x = torch.linspace(-1, 1, 256, device=device).unsqueeze(1)",
  "y = 3 * x - 0.5",
  "model = torch.nn.Sequential(torch.nn.Linear(1, 16), torch.nn.Tanh(), torch.nn.Linear(16, 1)).to(device)",
  "optimizer = torch.optim.AdamW(model.parameters(), lr=0.03)",
  "losses = []",
  "for step in range(STEPS):",
  "    optimizer.zero_grad(set_to_none=True)",
  "    loss = torch.nn.functional.mse_loss(model(x), y)",
  "    loss.backward()",
  "    optimizer.step()",
  "    losses.append(loss.item())",
  "    if step % 10 == 0 or step == STEPS - 1:",
  "        print(f'step={step:02d} loss={losses[-1]:.6f}', flush=True)",
  "torch.mps.synchronize()",
  "summary = {'device': str(device), 'steps': STEPS, 'initialLoss': losses[0], 'finalLoss': losses[-1]}",
  "Path('metrics.json').write_text(json.dumps(summary, indent=2) + '\\n')",
  "print(json.dumps(summary), flush=True)",
  "",
].join("\n");

const client = new Client(
  { name: "chatwork-training-chain-smoke", version: "1.0.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({ command: launcher, stderr: "pipe" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text || `${name} failed`;
    throw new Error(message);
  }
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const info = await call("bridge_info", {});
  if (info.version !== "0.4.4") throw new Error(`Expected bridge 0.4.4, received ${info.version}`);

  await call("create_directory", { path: runDirectory });
  const written = await call("write_file", { path: scriptPath, content: source });
  const firstRead = await call("read_file", { path: scriptPath, startLine: 1, endLine: 0 });
  const modified = await call("replace_text", {
    path: scriptPath,
    search: "STEPS = 20",
    replacement: "STEPS = 40",
    expectedSha256: firstRead.sha256,
  });
  const secondRead = await call("read_file", { path: scriptPath, startLine: 1, endLine: 8 });
  if (!secondRead.content.includes("STEPS = 40")) throw new Error("Revision-guard edit was not observable.");

  const runtime = await call("runtime_info", { path: runDirectory, refresh: true });
  if (!runtime.mpsReady || !runtime.recommendedPython) throw new Error("A ready MPS Python runtime was not found.");
  const started = await call("start_job", {
    argv: [runtime.recommendedPython, scriptPath],
    cwd: runDirectory,
    label: "chatwork-mps-e2e",
  });

  let waited;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    waited = await call("wait_job", {
      jobId: started.id,
      afterStatus: "running",
      afterBytes: -1,
      timeoutSeconds: 50,
      lines: 100,
    });
    if (waited.status?.status !== "running") break;
  }
  const status = await call("job_status", { jobId: started.id });
  const tail = await call("job_tail", { jobId: started.id, lines: 100 });
  const metricsRead = await call("read_file", { path: metricsPath, startLine: 1, endLine: 0 });
  const metrics = JSON.parse(metricsRead.content.replace(/^\d+: /gm, ""));

  const report = {
    bridgeVersion: info.version,
    runDirectory,
    scriptPath,
    initialSha256: written.sha256,
    readSha256: firstRead.sha256,
    modifiedSha256: modified.sha256,
    revisionChanged: written.sha256 !== modified.sha256,
    python: runtime.recommendedPython,
    mpsReady: runtime.mpsReady,
    disk: runtime.disk,
    memory: runtime.memory,
    jobId: started.id,
    jobSandboxed: started.sandboxed,
    jobStatus: status.status,
    lossLog: tail.output,
    metrics,
    metricsSha256: metricsRead.sha256,
  };
  console.log(JSON.stringify(report, null, 2));

  if (
    status.status !== "succeeded" ||
    started.sandboxed !== true ||
    metrics.device !== "mps" ||
    metrics.steps !== 40 ||
    !(metrics.finalLoss < metrics.initialLoss) ||
    !tail.output.includes("step=39")
  ) {
    process.exitCode = 1;
  }
} finally {
  await client.close().catch(() => {});
}
