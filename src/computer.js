import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROCESS_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_BYTES = 128_000;
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SCREENSHOTS = 50;
const FRESH_SCREENSHOT_MS = 120_000;
const MAX_TYPED_TEXT_BYTES = 200_000;
const INSPECTION_TTL_MS = 120_000;
const NATIVE_HELPER_NAME = "chatwork-ax-helper";

const KEY_CODES = Object.freeze({
  enter: 36,
  tab: 48,
  escape: 53,
  space: 49,
  backspace: 51,
  delete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
});

const KEY_ALIASES = Object.freeze({
  return: "enter",
  esc: "escape",
  forwarddelete: "delete",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  pgup: "pageup",
  pgdn: "pagedown",
});

const MODIFIER_TERMS = Object.freeze({
  command: "command down",
  control: "control down",
  option: "option down",
  shift: "shift down",
});

function computerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function attachProcessDetails(error, { stdout, stderr, exitCode, signal }) {
  error.stdout = stdout;
  error.stderr = stderr;
  error.exitCode = exitCode;
  error.signal = signal;
  return error;
}

function appendLimited(chunks, chunk, state, limit) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.seen += data.length;
  const remaining = Math.max(0, limit - state.kept);
  if (remaining > 0) {
    chunks.push(data.subarray(0, remaining));
    state.kept += Math.min(data.length, remaining);
  }
}

function processFailureMessage(executable, code, signal, stderr, stdout) {
  const detail = (stderr || stdout || "").trim().slice(-4_000);
  const status = signal ? `signal ${signal}` : `exit code ${code}`;
  return `${path.basename(executable)} failed with ${status}${detail ? `: ${detail}` : "."}`;
}

function run(executable, args, options = {}) {
  const {
    timeoutMs = PROCESS_TIMEOUT_MS,
    maxOutputBytes = MAX_PROCESS_OUTPUT_BYTES,
    ...spawnOptions
  } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(executable, args, {
        ...spawnOptions,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(computerError("COMPUTER_SPAWN_FAILED", `Unable to start ${path.basename(executable)}: ${error.message}`, error));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { seen: 0, kept: 0 };
    const stderrState = { seen: 0, kept: 0 };
    let settled = false;
    let timedOut = false;
    let forceKillTimer;

    child.stdout?.on("data", (chunk) => appendLimited(stdoutChunks, chunk, stdoutState, maxOutputBytes));
    child.stderr?.on("data", (chunk) => appendLimited(stderrChunks, chunk, stderrState, maxOutputBytes));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_500);
    }, Math.max(1, timeoutMs));

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      callback();
    };

    child.once("error", (error) => {
      finish(() => reject(computerError("COMPUTER_PROCESS_ERROR", `Unable to run ${path.basename(executable)}: ${error.message}`, error)));
    });
    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        finish(() => reject(computerError("COMPUTER_TIMEOUT", `${path.basename(executable)} timed out after ${timeoutMs} ms.`)));
        return;
      }
      if (code !== 0) {
        finish(() => reject(attachProcessDetails(
          computerError("COMPUTER_COMMAND_FAILED", processFailureMessage(executable, code, signal, stderr, stdout)),
          { stdout, stderr, exitCode: code, signal },
        )));
        return;
      }
      finish(() => resolve({
        stdout,
        stderr,
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        truncated: stdoutState.seen > stdoutState.kept || stderrState.seen > stderrState.kept,
      }));
    });
  });
}

function assertMac() {
  if (process.platform !== "darwin") {
    throw computerError("COMPUTER_UNSUPPORTED_PLATFORM", "Computer control currently supports macOS only.");
  }
}

function accessibilityHint(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not authorized|not permitted|assistive access|accessibility|辅助功能|-1719|-1743|-25211|-10827|-2700/i.test(message)) {
    return computerError(
      "COMPUTER_PERMISSION_REQUIRED",
      `${message} Grant Accessibility and Automation access to the bridge process in System Settings > Privacy & Security, then retry.`,
      error,
    );
  }
  return error;
}

function nativeHelperCandidates(config) {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  return [...new Set([
    config?.nativeHelperPath,
    process.env.CHATWORK_AX_HELPER,
    path.join(os.homedir(), "Library", "Application Support", "ChatWorkBridge", "bin", NATIVE_HELPER_NAME),
    path.resolve(sourceDir, "../native", NATIVE_HELPER_NAME),
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function findNativeHelper(config) {
  const candidates = nativeHelperCandidates(config);
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (stat.isFile()) return { path: candidate, candidates };
    } catch {
      // Continue through stable-install and source-tree candidates.
    }
  }
  return { path: "", candidates };
}

function nativeFailure(error) {
  const raw = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw.split(/\r?\n/).filter(Boolean).at(-1));
      const detail = parsed.error || parsed;
      if (detail && typeof detail === "object" && typeof detail.message === "string") {
        const message = typeof detail.hint === "string" && detail.hint
          ? `${detail.message} ${detail.hint}`
          : detail.message;
        return computerError(detail.code || "COMPUTER_NATIVE_ERROR", message, error);
      }
    } catch {
      // Fall back to the bounded process error.
    }
  }
  return accessibilityHint(error);
}

function parseNativeJson(result, command) {
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw computerError("COMPUTER_NATIVE_INVALID_JSON", `${NATIVE_HELPER_NAME} returned invalid JSON for ${command}.`, error);
  }
  if (!parsed || typeof parsed !== "object" || parsed.ok !== true) {
    throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", `${NATIVE_HELPER_NAME} returned an invalid ${command} response.`);
  }
  return parsed;
}

async function osascript(script, args = [], options = {}) {
  assertMac();
  try {
    const result = await run("/usr/bin/osascript", ["-e", script, ...args], {
      timeoutMs: options.timeoutMs || PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    return result.stdout.trim();
  } catch (error) {
    throw accessibilityHint(error);
  }
}

function finiteInteger(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  const rounded = Math.round(value);
  if (rounded < minimum || rounded > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return rounded;
}

function exactInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}

export function normalizeInspectOptions(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Inspect options must be an object.");
  return {
    maxElements: args.maxElements === undefined ? 200 : exactInteger(args.maxElements, "maxElements", 1, 500),
    maxDepth: args.maxDepth === undefined ? 6 : exactInteger(args.maxDepth, "maxDepth", 0, 10),
    maxValueLength: args.maxValueLength === undefined ? 256 : exactInteger(args.maxValueLength, "maxValueLength", 0, 1_000),
  };
}

export function normalizePressRequest(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Press arguments must be an object.");
  if (typeof args.snapshotId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(args.snapshotId)) {
    throw new Error("snapshotId must come from the latest computer_inspect_ui result.");
  }
  if (typeof args.elementPath !== "string" || !/^\d+(?:\.\d+){0,10}$/.test(args.elementPath)) {
    throw new Error("elementPath must be a numeric path from computer_inspect_ui, for example 0.2.1.");
  }
  return { snapshotId: args.snapshotId, elementPath: args.elementPath };
}

function normalizedModifiers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("modifiers must be an array with at most four items.");
  const modifiers = [...new Set(value)];
  if (modifiers.some((item) => typeof item !== "string" || !Object.hasOwn(MODIFIER_TERMS, item))) {
    throw new Error("Unsupported modifier. Use command, control, option, or shift.");
  }
  return modifiers;
}

function normalizeAppName(value) {
  if (typeof value !== "string") throw new Error("app is required for open_app.");
  const app = value.trim();
  if (!app || app.startsWith("-") || Buffer.byteLength(app, "utf8") > 1_024 || /[\0\r\n]/.test(app)) {
    throw new Error("app must be a non-empty application name under 1,024 bytes without control characters.");
  }
  return app;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8_192 || /[\0\r\n]/.test(value)) {
    throw new Error("url must be a valid URL under 8,192 bytes without control characters.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be an absolute HTTP or HTTPS URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) {
    throw new Error("Only absolute HTTP and HTTPS URLs are allowed.");
  }
  if (parsed.username || parsed.password) throw new Error("URLs containing embedded credentials are not allowed.");
  return parsed.toString();
}

function reportableUrl(value) {
  const parsed = new URL(value);
  const secretQuery = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|client[_-]?secret)/i;
  for (const key of [...parsed.searchParams.keys()]) {
    if (secretQuery.test(key)) parsed.searchParams.set(key, "[REDACTED]");
  }
  return parsed.toString();
}

export function normalizeComputerAction(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Computer action arguments must be an object.");
  const action = args.action;
  if (typeof action !== "string") throw new Error("action is required.");

  if (["mouse_move", "mouse_click", "mouse_drag", "mouse_scroll"].includes(action)) {
    const result = { action, x: finiteInteger(args.x, "x", -100_000, 100_000), y: finiteInteger(args.y, "y", -100_000, 100_000) };
    if (action === "mouse_click" || action === "mouse_drag") {
      result.button = args.button ?? "left";
      if (!["left", "right", "middle"].includes(result.button)) throw new Error("Unsupported mouse button.");
      result.modifiers = normalizedModifiers(args.modifiers);
    }
    if (action === "mouse_click") result.clickCount = exactInteger(args.clickCount ?? 1, "clickCount", 1, 3);
    if (action === "mouse_drag") {
      result.toX = finiteInteger(args.toX, "toX", -100_000, 100_000);
      result.toY = finiteInteger(args.toY, "toY", -100_000, 100_000);
      result.durationMs = exactInteger(args.durationMs ?? 500, "durationMs", 100, 3000);
    }
    if (action === "mouse_scroll") {
      result.deltaX = exactInteger(args.deltaX ?? 0, "deltaX", -2000, 2000);
      result.deltaY = exactInteger(args.deltaY ?? 0, "deltaY", -2000, 2000);
    }
    return result;
  }
  if (action === "click") {
    return {
      action,
      x: finiteInteger(args.x, "x", -100_000, 100_000),
      y: finiteInteger(args.y, "y", -100_000, 100_000),
    };
  }
  if (action === "type") {
    if (typeof args.text !== "string") throw new Error("text is required for type.");
    const bytes = Buffer.byteLength(args.text, "utf8");
    if (bytes > MAX_TYPED_TEXT_BYTES || args.text.includes("\0")) {
      throw new Error(`text must be under ${MAX_TYPED_TEXT_BYTES} bytes and may not contain NUL bytes.`);
    }
    return { action, text: args.text, bytes };
  }
  if (action === "key") {
    if (typeof args.key !== "string" || args.key.length === 0 || args.key.includes("\0")) {
      throw new Error("key is required for key.");
    }
    const raw = args.key.trim();
    const lower = raw.toLowerCase();
    const key = KEY_ALIASES[lower] || lower;
    const characters = [...raw];
    if (!Object.hasOwn(KEY_CODES, key) && characters.length !== 1) {
      throw new Error("Use one character, F1-F12, or a supported named navigation key.");
    }
    return {
      action,
      key,
      character: Object.hasOwn(KEY_CODES, key) ? "" : characters[0],
      modifiers: normalizedModifiers(args.modifiers),
    };
  }
  if (action === "scroll") {
    const amount = args.amount === undefined ? 0 : exactInteger(args.amount, "amount", -10, 10);
    return { action, amount };
  }
  if (action === "open_app") return { action, app: normalizeAppName(args.app) };
  if (action === "open_url") return { action, url: normalizeUrl(args.url) };
  throw new Error(`Unsupported computer action: ${action}`);
}

function modifiersClause(modifiers) {
  if (modifiers.length === 0) return "";
  return ` using {${modifiers.map((item) => MODIFIER_TERMS[item]).join(", ")}}`;
}

export class ComputerTools {
  constructor(config, options = {}) {
    if (!config || typeof config.stateDir !== "string") throw new Error("ComputerTools requires a configured stateDir.");
    this.screenshotDir = path.join(config.stateDir, "screenshots");
    fs.mkdirSync(this.screenshotDir, { recursive: true, mode: 0o700 });
    const screenshotStat = fs.lstatSync(this.screenshotDir);
    if (screenshotStat.isSymbolicLink() || !screenshotStat.isDirectory()) {
      throw new Error("The screenshot state path must be a real directory, not a symlink.");
    }
    fs.chmodSync(this.screenshotDir, 0o700);
    this.screenshotDir = fs.realpathSync.native(this.screenshotDir);
    const helper = findNativeHelper(config);
    this.nativeHelperPath = helper.path;
    this.nativeHelperCandidates = helper.candidates;
    this.nativeInvoke = typeof options.nativeInvoke === "function" ? options.nativeInvoke : null;
    this.queue = Promise.resolve();
    this.lastScreenshot = null;
    this.latestInspection = null;
  }

  enqueue(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  nativeUnavailable() {
    return computerError(
      "COMPUTER_NATIVE_HELPER_UNAVAILABLE",
      `The native macOS accessibility helper is unavailable. Run scripts/install-runtime.command to compile it. Checked: ${this.nativeHelperCandidates.join(", ")}`,
    );
  }

  async callNative(command, args = []) {
    assertMac();
    if (this.nativeInvoke) {
      const response = await this.nativeInvoke(command, args);
      if (!response || typeof response !== "object" || response.ok !== true) {
        throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", `Injected native helper returned an invalid ${command} response.`);
      }
      return response;
    }
    if (!this.nativeHelperPath) throw this.nativeUnavailable();
    try {
      const result = await run(this.nativeHelperPath, [command, ...args], {
        timeoutMs: command === "inspect-ui" ? 20_000 : PROCESS_TIMEOUT_MS,
        maxOutputBytes: 2_000_000,
      });
      return parseNativeJson(result, command);
    } catch (error) {
      throw nativeFailure(error);
    }
  }

  async activeAppInfo() {
    try {
      const result = await this.callNative("active-app");
      if (!result.app || typeof result.app.name !== "string" || !Number.isInteger(result.app.pid)) {
        throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", "Native helper did not return a valid frontmost application.");
      }
      return { ...result.app, backend: "native-ax" };
    } catch (nativeError) {
      try {
        const name = await osascript('tell application "System Events" to get name of first application process whose frontmost is true');
        return {
          name,
          bundleIdentifier: null,
          pid: null,
          backend: "system-events-fallback",
          degradedReason: nativeError instanceof Error ? nativeError.message : String(nativeError),
        };
      } catch {
        throw nativeError;
      }
    }
  }

  async activeAppName() {
    return (await this.activeAppInfo()).name;
  }

  async pruneScreenshots(currentPath) {
    try {
      const entries = await fs.promises.readdir(this.screenshotDir, { withFileTypes: true });
      const screenshots = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^screen-\d+-[0-9a-f-]+\.png$/i.test(entry.name)) continue;
        const filePath = path.join(this.screenshotDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        screenshots.push({ filePath, modified: stat.mtimeMs });
      }
      screenshots.sort((left, right) => right.modified - left.modified);
      for (const old of screenshots.slice(MAX_SCREENSHOTS)) {
        if (old.filePath !== currentPath) await fs.promises.unlink(old.filePath).catch(() => {});
      }
    } catch {
      // Screenshot capture remains useful even when retention cleanup fails.
    }
  }

  async screenshot() {
    return await this.enqueue(async () => {
      assertMac();
      const capturedAt = new Date().toISOString();
      const filePath = path.join(this.screenshotDir, `screen-${Date.now()}-${crypto.randomUUID()}.png`);
      try {
        await run("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", filePath], {
          timeoutMs: SCREENSHOT_TIMEOUT_MS,
          maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
        });
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size === 0) throw computerError("COMPUTER_EMPTY_SCREENSHOT", "macOS produced an empty screenshot.");
        if (stat.size > MAX_SCREENSHOT_BYTES) {
          throw computerError("COMPUTER_SCREENSHOT_TOO_LARGE", `Screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes.`);
        }
        await fs.promises.chmod(filePath, 0o600);
        const data = await fs.promises.readFile(filePath);
        const display = await this.callNative("display-info");
        const imageWidth = data.readUInt32BE(16);
        const imageHeight = data.readUInt32BE(20);
        const coordinates = {
          ...display,
          imageWidth,
          imageHeight,
          pixelsPerPointX: imageWidth / display.mainDisplay.width,
          pixelsPerPointY: imageHeight / display.mainDisplay.height,
          mapping: "globalX = mainDisplay.x + imageX / pixelsPerPointX; globalY = mainDisplay.y + imageY / pixelsPerPointY",
        };
        const activeApp = await this.activeAppName().catch(() => null);
        this.lastScreenshot = { capturedAtMs: Date.now(), activeApp };
        await this.pruneScreenshots(filePath);
        return {
          path: filePath,
          data: data.toString("base64"),
          mimeType: "image/png",
          bytes: data.length,
          sha256: crypto.createHash("sha256").update(data).digest("hex"),
          capturedAt,
          activeApp,
          coordinates,
        };
      } catch (error) {
        await fs.promises.unlink(filePath).catch(() => {});
        throw error;
      }
    });
  }

  async activeApp() {
    return await this.enqueue(async () => {
      const app = await this.activeAppInfo();
      return {
        activeApp: app.name,
        app,
        inspectedAt: new Date().toISOString(),
      };
    });
  }

  async inspectUi(args = {}) {
    const options = normalizeInspectOptions(args);
    return await this.enqueue(async () => {
      const inspectedAtMs = Date.now();
      const result = await this.callNative("inspect-ui", [
        "--max-elements", String(options.maxElements),
        "--max-depth", String(options.maxDepth),
        "--max-value-length", String(options.maxValueLength),
      ]);
      if (!result.app || !Number.isInteger(result.app.pid) || typeof result.app.name !== "string" || !Array.isArray(result.elements)) {
        throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", "Native helper returned malformed UI inspection data.");
      }
      if (result.elements.length > options.maxElements) {
        throw computerError("COMPUTER_NATIVE_LIMIT_VIOLATION", "Native helper exceeded the requested UI element limit.");
      }

      const seen = new Set();
      const elements = result.elements.map((element) => {
        if (!element || typeof element !== "object") {
          throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", "Native helper returned a malformed UI element.");
        }
        const elementPath = element.path;
        if (typeof elementPath !== "string" || (elementPath !== "root" && !/^\d+(?:\.\d+){0,10}$/.test(elementPath))) {
          throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", "Native helper returned an invalid UI element path.");
        }
        if (seen.has(elementPath)) throw computerError("COMPUTER_NATIVE_INVALID_RESPONSE", `Duplicate UI element path: ${elementPath}`);
        seen.add(elementPath);
        const role = typeof element.role === "string" ? element.role.slice(0, 256) : "";
        const title = typeof element.title === "string" ? element.title.replaceAll("\0", "").slice(0, 1_000) : "";
        const actions = Array.isArray(element.actions)
          ? element.actions.filter((action) => typeof action === "string").slice(0, 32)
          : [];
        return {
          path: elementPath,
          depth: Number.isInteger(element.depth) ? element.depth : elementPath === "root" ? 0 : elementPath.split(".").length,
          role,
          subrole: typeof element.subrole === "string" ? element.subrole.slice(0, 256) : "",
          title,
          description: typeof element.description === "string" ? element.description.slice(0, 1_000) : "",
          value: ["string", "number", "boolean"].includes(typeof element.value) || element.value === null ? element.value : null,
          valueRedacted: element.valueRedacted === true,
          bounds: element.bounds && typeof element.bounds === "object" ? element.bounds : null,
          actions,
          enabled: typeof element.enabled === "boolean" ? element.enabled : null,
          focused: typeof element.focused === "boolean" ? element.focused : null,
          pressable: actions.includes("AXPress"),
        };
      });

      const snapshotId = crypto.randomUUID();
      this.latestInspection = {
        snapshotId,
        inspectedAtMs,
        pid: result.app.pid,
        appName: result.app.name,
        elements: new Map(elements.map((element) => [element.path, {
          role: element.role,
          title: element.title,
          pressable: element.pressable,
        }])),
      };
      return {
        ok: true,
        snapshotId,
        expiresInSeconds: Math.floor(INSPECTION_TTL_MS / 1_000),
        inspectedAt: new Date(inspectedAtMs).toISOString(),
        app: result.app,
        elements,
        count: elements.length,
        truncated: result.truncated === true,
        limits: options,
        backend: "native-ax",
      };
    });
  }

  async pressElement(args) {
    const request = normalizePressRequest(args);
    return await this.enqueue(async () => {
      const snapshot = this.latestInspection;
      if (!snapshot || snapshot.snapshotId !== request.snapshotId) {
        throw computerError("COMPUTER_INSPECTION_REQUIRED", "Run computer_inspect_ui again and use its latest snapshotId.");
      }
      const ageMs = Date.now() - snapshot.inspectedAtMs;
      if (ageMs > INSPECTION_TTL_MS) {
        this.latestInspection = null;
        throw computerError("COMPUTER_INSPECTION_STALE", "The UI inspection is stale; inspect the current UI again before pressing an element.");
      }
      const element = snapshot.elements.get(request.elementPath);
      if (!element) throw computerError("COMPUTER_ELEMENT_NOT_FOUND", "elementPath was not present in the latest UI inspection.");
      if (!element.pressable) throw computerError("COMPUTER_ELEMENT_NOT_PRESSABLE", "The inspected element does not advertise the AXPress action.");

      const nativeArgs = [
        "--pid", String(snapshot.pid),
        "--path", request.elementPath,
        "--expected-role", element.role,
      ];
      if (element.title) nativeArgs.push("--expected-title", element.title);
      const result = await this.callNative("press-element", nativeArgs);
      this.latestInspection = null;
      this.lastScreenshot = null;
      return {
        ok: true,
        action: "AXPress",
        snapshotId: request.snapshotId,
        elementPath: request.elementPath,
        app: result.app || { pid: snapshot.pid, name: snapshot.appName },
        role: result.element?.role || result.role || element.role,
        title: result.element?.title || result.title || element.title,
        elapsedSinceInspectionMs: ageMs,
        backend: "native-ax",
        verificationRecommended: true,
      };
    });
  }

  assertFreshScreenshot(activeApp) {
    if (!this.lastScreenshot) {
      throw computerError("COMPUTER_SCREENSHOT_REQUIRED", "Take computer_screenshot immediately before a coordinate click.");
    }
    const ageMs = Date.now() - this.lastScreenshot.capturedAtMs;
    if (ageMs > FRESH_SCREENSHOT_MS) {
      throw computerError("COMPUTER_SCREENSHOT_STALE", "The last screenshot is stale; take a fresh screenshot before clicking.");
    }
    if (this.lastScreenshot.activeApp && activeApp && this.lastScreenshot.activeApp !== activeApp) {
      throw computerError(
        "COMPUTER_APP_CHANGED",
        `The frontmost app changed from ${this.lastScreenshot.activeApp} to ${activeApp}; take a fresh screenshot before clicking.`,
      );
    }
    return ageMs;
  }

  async action(args) {
    const normalized = normalizeComputerAction(args);
    return await this.enqueue(async () => {
      assertMac();
      const startedAt = Date.now();
      const action = normalized.action;

      if (action.startsWith("mouse_")) {
        const activeApp = await this.activeAppName();
        const screenshotAgeMs = this.assertFreshScreenshot(activeApp);
        try {
          const result = await this.callNative("mouse", [JSON.stringify(normalized)]);
          return { ...result, elapsedMs: Date.now() - startedAt, screenshotAgeMs, verificationRecommended: true };
        } finally {
          this.lastScreenshot = null;
          this.latestInspection = null;
        }
      }

      if (action === "click") {
        const activeApp = await this.activeAppName();
        const screenshotAgeMs = this.assertFreshScreenshot(activeApp);
        await osascript(
          'on run argv\ntell application "System Events" to click at {(item 1 of argv) as integer, (item 2 of argv) as integer}\nend run',
          [String(normalized.x), String(normalized.y)],
        );
        this.lastScreenshot = null;
        this.latestInspection = null;
        return {
          ok: true,
          action,
          x: normalized.x,
          y: normalized.y,
          activeApp,
          screenshotAgeMs,
          elapsedMs: Date.now() - startedAt,
          verificationRecommended: true,
        };
      }

      if (action === "type") {
        const activeApp = await this.activeAppName();
        const script = 'on run argv\nset previousClipboard to missing value\nset hasPreviousClipboard to false\ntry\nset previousClipboard to the clipboard\nset hasPreviousClipboard to true\nend try\nset the clipboard to item 1 of argv\ntry\ntell application "System Events" to keystroke "v" using command down\ndelay 0.2\non error errorMessage number errorNumber\nif hasPreviousClipboard then set the clipboard to previousClipboard\nerror errorMessage number errorNumber\nend try\nif hasPreviousClipboard then set the clipboard to previousClipboard\nend run';
        await osascript(script, [normalized.text], { timeoutMs: 30_000 });
        this.lastScreenshot = null;
        this.latestInspection = null;
        return {
          ok: true,
          action,
          characters: [...normalized.text].length,
          bytes: normalized.bytes,
          activeApp,
          elapsedMs: Date.now() - startedAt,
          verificationRecommended: true,
        };
      }

      if (action === "key") {
        const activeApp = await this.activeAppName();
        const using = modifiersClause(normalized.modifiers);
        if (Object.hasOwn(KEY_CODES, normalized.key)) {
          await osascript(`tell application "System Events" to key code ${KEY_CODES[normalized.key]}${using}`);
        } else {
          await osascript(
            `on run argv\ntell application "System Events" to keystroke (item 1 of argv)${using}\nend run`,
            [normalized.character],
          );
        }
        this.lastScreenshot = null;
        this.latestInspection = null;
        return {
          ok: true,
          action,
          key: normalized.key,
          modifiers: normalized.modifiers,
          activeApp,
          elapsedMs: Date.now() - startedAt,
          verificationRecommended: true,
        };
      }

      if (action === "scroll") {
        if (normalized.amount === 0) {
          return { ok: true, action, amount: 0, elapsedMs: Date.now() - startedAt, verificationRecommended: false };
        }
        const activeApp = await this.activeAppName();
        const keyCode = normalized.amount > 0 ? KEY_CODES.pagedown : KEY_CODES.pageup;
        await osascript(
          'on run argv\nset requestedKeyCode to (item 1 of argv) as integer\nset repeatCount to (item 2 of argv) as integer\nrepeat repeatCount times\ntell application "System Events" to key code requestedKeyCode\nend repeat\nend run',
          [String(keyCode), String(Math.abs(normalized.amount))],
        );
        this.lastScreenshot = null;
        this.latestInspection = null;
        return {
          ok: true,
          action,
          amount: normalized.amount,
          mode: "page",
          activeApp,
          elapsedMs: Date.now() - startedAt,
          verificationRecommended: true,
        };
      }

      if (action === "open_app") {
        await run("/usr/bin/open", ["-a", normalized.app], { timeoutMs: 20_000 });
        this.lastScreenshot = null;
        this.latestInspection = null;
        return {
          ok: true,
          action,
          app: normalized.app,
          elapsedMs: Date.now() - startedAt,
          verificationRecommended: true,
        };
      }

      await run("/usr/bin/open", [normalized.url], { timeoutMs: 20_000 });
      this.lastScreenshot = null;
      this.latestInspection = null;
      return {
        ok: true,
        action,
        url: reportableUrl(normalized.url),
        elapsedMs: Date.now() - startedAt,
        verificationRecommended: true,
      };
    });
  }
}
