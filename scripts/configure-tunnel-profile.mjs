#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [profilePath, apiKeyPath, healthUrlFile, logFile, command] = process.argv.slice(2);

if (![profilePath, apiKeyPath, healthUrlFile, logFile, command].every(Boolean)) {
  console.error(
    "Usage: configure-tunnel-profile.mjs <profile> <api-key> <health-url-file> <log-file> <mcp-command>",
  );
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
profile.control_plane ??= {};
profile.health ??= {};
profile.log ??= {};
profile.mcp ??= {};

profile.control_plane.api_key = `file:${apiKeyPath}`;
profile.health.url_file = healthUrlFile;
profile.log.file = logFile;
profile.mcp.commands = [{ channel: "main", command }];

const temporaryPath = path.join(
  path.dirname(profilePath),
  `.${path.basename(profilePath)}.${process.pid}.tmp`,
);
fs.writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
fs.renameSync(temporaryPath, profilePath);
fs.chmodSync(profilePath, 0o600);
