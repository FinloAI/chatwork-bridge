import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.homedir(), "Library/Application Support/ChatWorkBridge");
const target = path.join(root, "watchdog");
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
for (const name of ["watchdog.mjs", "check-tunnel-health.mjs"]) fs.copyFileSync(path.join(source, name), path.join(target, name));
const label = "com.openai.chatwork-bridge-watchdog";
const plist = path.join(os.homedir(), "Library/LaunchAgents", label + ".plist");
const esc = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(path.join(target, "watchdog.mjs"))}</string></array>
<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>`, { mode: 0o600 });
const domain = "gui/" + process.getuid();
spawnSync("/bin/launchctl", ["bootout", domain + "/" + label], { stdio: "ignore", timeout: 10000 });
const loaded = spawnSync("/bin/launchctl", ["bootstrap", domain, plist], { encoding: "utf8", timeout: 15000 });
if (loaded.status !== 0) throw new Error(loaded.stderr || "Unable to load watchdog.");
console.log("Installed watchdog: 60-second checks, 3 failures before restart, 3–30 minute backoff.");
