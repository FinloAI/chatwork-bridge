#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const installRoot = path.join(os.homedir(), "Library", "Application Support", "ChatWorkBridge");
const healthFile = process.env.CHATWORK_TUNNEL_HEALTH_FILE
  ?? path.join(installRoot, "state", "tunnel-health.url");
const logFile = process.env.CHATWORK_TUNNEL_LOG_FILE
  ?? path.join(installRoot, "logs", "tunnel-client.log");
const timeoutMs = 5_000;
const logTailBytes = 5 * 1024 * 1024;

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function readLogTail() {
  try {
    const stats = await fs.stat(logFile);
    const length = Math.min(stats.size, logTailBytes);
    const offset = Math.max(stats.size - length, 0);
    const handle = await fs.open(logFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseLogRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A tail read can begin inside a JSON line; the next complete line is valid.
    }
  }
  return rows;
}

const report = {
  ok: false,
  healthFile,
  logFile,
  healthUrl: null,
  health: null,
  ready: null,
  clientInstanceId: null,
  startedAt: null,
  mainChannelProbeStatus: null,
  currentInstance502Count: 0,
  last502: null,
  error: null,
};

try {
  report.healthUrl = (await fs.readFile(healthFile, "utf8")).trim();
  if (!report.healthUrl) throw new Error(`Tunnel health URL is empty: ${healthFile}`);

  const [health, ready, statusText, logTail] = await Promise.all([
    fetchText(`${report.healthUrl}/healthz`),
    fetchText(`${report.healthUrl}/readyz`),
    fetchText(`${report.healthUrl}/api/status`),
    readLogTail(),
  ]);
  const status = JSON.parse(statusText);
  const mainChannel = status.channels?.find((channel) => channel.name === "main") ?? null;

  report.health = health.trim();
  report.ready = ready.trim();
  report.clientInstanceId = status.client_instance_id ?? null;
  report.startedAt = status.started_at ?? null;
  report.mainChannelProbeStatus = mainChannel?.probe_status ?? null;

  const rows = parseLogRows(logTail).filter(row => row.client_instance_id === report.clientInstanceId);
  const pollEvents = rows.filter(row => {
    const msg = String(row.msg ?? row.message ?? "");
    return msg.includes("poll timed out") || msg.includes("poll failed")
      || msg.includes("poller recovered") || msg.includes("dispatcher forwarded command");
  });
  const lastPoll = pollEvents.at(-1);
  const lastMessage = String(lastPoll?.msg ?? lastPoll?.message ?? "");
  const pollFailed = lastMessage.includes("poll timed out") || lastMessage.includes("poll failed");
  let failureSince = null;
  if (pollFailed) {
    for (let i = pollEvents.length - 1; i >= 0; i--) {
      const msg = String(pollEvents[i].msg ?? pollEvents[i].message ?? "");
      if (!msg.includes("poll timed out") && !msg.includes("poll failed")) break;
      failureSince = pollEvents[i].time;
    }
  }
  report.controlPlane = {
    status: pollFailed ? "degraded" : lastPoll ? "operational" : "unknown",
    lastEventAt: lastPoll?.time ?? null,
    failureSince,
    sustainedFailure: pollFailed && Date.now() - Date.parse(failureSince) >= 120000,
  };
  const failures = rows.filter((row) =>
    row.client_instance_id === report.clientInstanceId
    && Number(row.status_code) === 502
    && String(row.msg ?? row.message ?? "").includes("MCP upstream error")
  );
  report.currentInstance502Count = failures.length;
  report.last502 = failures.at(-1) ?? null;
  report.ok = report.health === "live"
    && report.ready === "ready"
    && report.mainChannelProbeStatus === "ok"
    && report.currentInstance502Count === 0
    && !report.controlPlane.sustainedFailure;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
