import os from "node:os";
import path from "node:path";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function buildRuntimePath(env = process.env) {
  const home = os.homedir();
  const configured = (env.PATH || "").split(path.delimiter);
  return unique([
    ...configured,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/Library/Frameworks/Python.framework/Versions/Current/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".uv", "bin"),
    path.join(home, "miniforge3", "bin"),
    path.join(home, "mambaforge", "bin"),
    path.join(home, "anaconda3", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]).join(path.delimiter);
}

export function buildProcessEnv(overrides = {}, env = process.env) {
  return {
    ...env,
    PATH: buildRuntimePath(env),
    PYTHONUNBUFFERED: env.PYTHONUNBUFFERED || "1",
    ...overrides,
  };
}
