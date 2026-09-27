import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function decide(previous, healthy, now) {
  const state = { failures: 0, restarts: 0, nextRestart: 0, healthySince: 0, ...previous };
  if (healthy) {
    state.failures = 0;
    state.healthySince ||= now;
    if (now - state.healthySince >= 600000) state.restarts = 0;
    return { state, restart: false };
  }
  state.healthySince = 0;
  state.failures++;
  const restart = state.failures >= 3 && now >= state.nextRestart;
  if (restart) {
    state.nextRestart = now + Math.min(1800000, 180000 * 2 ** Math.min(state.restarts, 4));
    state.restarts++;
    state.failures = 0;
  }
  return { state, restart };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.join(os.homedir(), "Library/Application Support/ChatWorkBridge");
  const stateFile = path.join(root, "state/watchdog.json");
  const checker = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-tunnel-health.mjs");
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const check = spawnSync(process.execPath, [checker], { encoding: "utf8", timeout: 20000, maxBuffer: 100000 });
  const { state, restart } = decide(previous, check.status === 0, Date.now());
  state.checkedAt = new Date().toISOString();
  state.healthy = check.status === 0;
  if (restart) {
    const domain = "gui/" + process.getuid();
    const label = "com.openai.chatwork-bridge";
    const loaded = spawnSync("/bin/launchctl", ["print", domain + "/" + label], { timeout: 5000, stdio: "ignore" });
    const result = loaded.status === 0
      ? spawnSync("/bin/launchctl", ["kickstart", "-k", domain + "/" + label], { timeout: 15000, encoding: "utf8" })
      : spawnSync("/bin/launchctl", ["bootstrap", domain, path.join(os.homedir(), "Library/LaunchAgents/" + label + ".plist")], { timeout: 15000, encoding: "utf8" });
    state.lastRestartAt = state.checkedAt;
    state.lastRestartExit = result.status;
  }
  // A single atomically replaced status file keeps diagnostics bounded.
  fs.writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(stateFile + ".tmp", stateFile);
}
