import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildProcessEnv } from "./environment.js";
import { resolveAllowedPath } from "./security.js";

const MPS_PROBE = String.raw`
import json, platform, sys
result = {
    "executable": sys.executable,
    "python": platform.python_version(),
    "architecture": platform.machine(),
}
try:
    import torch
    result["torch"] = torch.__version__
    result["mpsBuilt"] = bool(torch.backends.mps.is_built())
    result["mpsAvailable"] = bool(torch.backends.mps.is_available())
    if result["mpsAvailable"]:
        value = (torch.ones(2, device="mps") * 3).sum().item()
        result["mpsTensorSmokeTest"] = value == 6
except Exception as exc:
    result["torchError"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(result))
`;

function commandResult(command, args, env, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let forceKillTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve(result);
    };
    const collect = (chunk) => {
      outputBytes += chunk.length;
      output = Buffer.concat([output, chunk]);
      if (output.length > 100_000) output = output.subarray(output.length - 100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("exit", (code, signal) => {
      if (timedOut) finish({ ok: false, code, signal, error: `Probe timed out after ${timeoutMs} ms.` });
      else finish({ ok: code === 0, code, signal, output: output.toString("utf8").trim().slice(-20_000), truncated: outputBytes > output.length });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_500);
    }, timeoutMs);
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function findOnPath(name, env) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  return "";
}

function optionalSystemValue(reader, fallback = null) {
  try {
    return reader();
  } catch {
    return fallback;
  }
}

export class RuntimeTools {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
    this.cacheTtlMs = 60_000;
  }

  async inspect({ path: requested = ".", refresh = false } = {}) {
    const projectPath = resolveAllowedPath(requested, this.config, { expectDirectory: true, access: "read" });
    const cached = this.cache.get(projectPath);
    if (!refresh && cached && Date.now() - cached.createdAt < this.cacheTtlMs) {
      return { ...cached.value, cached: true, cacheAgeMs: Date.now() - cached.createdAt };
    }
    const env = buildProcessEnv();
    const executableNames = ["node", "python3", "python", "uv", "conda", "micromamba", "git", "clang", "cmake", "swift", "xcodebuild", "java", "docker"];
    const executables = {};
    await Promise.all(executableNames.map(async (name) => {
      const executable = findOnPath(name, env);
      if (!executable) return;
      const versionArgs = name === "xcodebuild" ? ["-version"] : ["--version"];
      const version = await commandResult(executable, versionArgs, env, 8_000);
      executables[name] = { path: executable, version: version.output || version.error || "unknown" };
    }));

    const localPythonCandidates = [".venv/bin/python", "venv/bin/python", "env/bin/python"]
      .map((relative) => path.join(projectPath, relative))
      .filter((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    const pythonCandidates = [...new Set([
      ...localPythonCandidates,
      env.VIRTUAL_ENV ? path.join(env.VIRTUAL_ENV, "bin", "python") : "",
      env.CONDA_PREFIX ? path.join(env.CONDA_PREFIX, "bin", "python") : "",
      executables.python3?.path,
      executables.python?.path,
    ].filter(Boolean))];
    const python = await mapWithConcurrency(pythonCandidates, 2, async (executable) => {
      const probe = await commandResult(executable, ["-c", MPS_PROBE], env, 30_000);
      if (!probe.ok) {
        return { executable, probeError: probe.error || probe.output || `exit ${probe.code}` };
      }
      try {
        return JSON.parse(probe.output.split(/\r?\n/).at(-1));
      } catch {
        return { executable, probeError: `Invalid probe output: ${probe.output}` };
      }
    });

    let disk = null;
    try {
      const stat = fs.statfsSync(projectPath);
      const totalBytes = stat.blocks * stat.bsize;
      const freeBytes = stat.bavail * stat.bsize;
      const gibibyte = 1024 ** 3;
      disk = {
        totalBytes,
        freeBytes,
        usedBytes: (stat.blocks - stat.bfree) * stat.bsize,
        freeGiB: Math.round((freeBytes / gibibyte) * 10) / 10,
        freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1_000) / 10 : null,
        lowSpaceForTraining: freeBytes < 30 * gibibyte,
      };
    } catch {
      // Disk information is optional on older Node releases.
    }

    const cpus = optionalSystemValue(() => os.cpus(), []);
    const rawFreeMemoryBytes = optionalSystemValue(() => os.freemem());
    const memory = {
      rawFreeMemoryBytes,
      rawFreeMemoryMeaning: "Immediately unused pages reported by Node/os.freemem; on macOS this is not the same as memory available to applications.",
      pressureFreePercent: null,
      pressureSource: null,
    };
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/memory_pressure")) {
      const pressure = await commandResult("/usr/bin/memory_pressure", ["-Q"], env, 5_000);
      const match = pressure.output?.match(/System-wide memory free percentage:\s*(\d+)%/i);
      if (pressure.ok && match) {
        memory.pressureFreePercent = Number.parseInt(match[1], 10);
        memory.pressureSource = "/usr/bin/memory_pressure -Q";
      }
    }
    const value = {
      host: {
        platform: process.platform,
        release: os.release(),
        architecture: os.arch(),
        cpu: cpus[0]?.model || "unknown",
        cpuCount: cpus.length,
        totalMemoryBytes: optionalSystemValue(() => os.totalmem()),
        freeMemoryBytes: rawFreeMemoryBytes,
        freeMemoryNote: memory.rawFreeMemoryMeaning,
        uptimeSeconds: optionalSystemValue(() => os.uptime()),
      },
      memory,
      projectPath,
      disk,
      executables,
      python,
      mpsReady: python.some((item) => item.mpsAvailable && item.mpsTensorSmokeTest),
      recommendedPython: python.find((item) => item.mpsAvailable && item.mpsTensorSmokeTest)?.executable || python.find((item) => !item.probeError)?.executable || "",
      processEnvironment: {
        PATH: env.PATH,
        VIRTUAL_ENV: env.VIRTUAL_ENV || "not set",
        CONDA_PREFIX: env.CONDA_PREFIX || "not set",
        PYTORCH_ENABLE_MPS_FALLBACK: env.PYTORCH_ENABLE_MPS_FALLBACK || "not set",
      },
      resourceGuidance: {
        disk: disk?.lowSpaceForTraining
          ? `Only ${disk.freeGiB} GiB is free. Keep datasets/checkpoints bounded and prune or redirect intermediate artifacts before a larger training run.`
          : "Disk space is above the bridge's 30 GiB training caution threshold.",
        memory: memory.pressureFreePercent === null
          ? "Use macOS Activity Monitor memory pressure rather than raw freeMemoryBytes when deciding whether a training job fits."
          : `memory_pressure reports ${memory.pressureFreePercent}% system-wide free; use this pressure-aware signal rather than raw freeMemoryBytes alone.`,
      },
      guidance: "For training, use start_job with the reported Python path. Set env.PYTORCH_ENABLE_MPS_FALLBACK=1 only when a model contains operations unsupported by MPS.",
      cached: false,
    };
    this.cache.set(projectPath, { createdAt: Date.now(), value });
    return value;
  }
}
