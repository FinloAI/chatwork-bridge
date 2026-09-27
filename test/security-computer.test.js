import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComputerTools, normalizeComputerAction, normalizeInspectOptions, normalizePressRequest } from "../src/computer.js";
import { isProtectedInternalPath, isSensitiveReadPath, isWithin, redact, resolveAllowedPath, sha256File, validateArgv } from "../src/security.js";

function pathFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chatwork-security-test-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const canonicalRoot = fs.realpathSync(root);
  return {
    base,
    root,
    outside,
    config: {
      roots: [{ path: root, realPath: canonicalRoot }],
      readRoots: [{ path: root, realPath: canonicalRoot }],
      writeRoots: [{ path: root, realPath: canonicalRoot }],
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("path helpers fail closed on invalid access, forged roots, and dangling symlinks", () => {
  const item = pathFixture();
  try {
    assert.equal(isWithin(item.root, item.root), true);
    assert.equal(isWithin(item.root, path.join(item.root, "child")), true);
    assert.equal(isWithin(item.root, item.outside), false);
    assert.throws(() => resolveAllowedPath(".", item.config, { access: "execute" }), /either "read" or "write"/);
    assert.throws(() => resolveAllowedPath(42, item.config), /Path must be a string/);

    const forged = { roots: [{ path: item.root, realPath: path.parse(item.root).root }] };
    assert.throws(() => resolveAllowedPath(".", forged), /root is unavailable/);

    fs.symlinkSync(path.join(item.outside, "missing-target"), path.join(item.root, "dangling"));
    assert.throws(
      () => resolveAllowedPath("dangling/new.txt", item.config, { mustExist: false }),
      /outside the configured write roots or does not exist/,
    );
    assert.equal(
      resolveAllowedPath("new/sub/file.txt", item.config, { mustExist: false }),
      path.join(fs.realpathSync(item.root), "new/sub/file.txt"),
    );
  } finally {
    item.cleanup();
  }
});

test("sha256File streams an exact digest", async () => {
  const item = pathFixture();
  try {
    const filePath = path.join(item.root, "digest.txt");
    fs.writeFileSync(filePath, "abc");
    assert.equal(await sha256File(filePath), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    item.cleanup();
  }
});

test("relative reads start at the project root and internal bridge state is denied", () => {
  const item = pathFixture();
  try {
    const stateDir = path.join(item.root, ".chatwork-bridge");
    fs.mkdirSync(stateDir);
    const controlKey = path.join(stateDir, "control-plane.key");
    const auditLog = path.join(stateDir, "audit.jsonl");
    fs.writeFileSync(controlKey, "do-not-read");
    fs.writeFileSync(auditLog, "private audit");
    const config = {
      ...item.config,
      stateDir,
      readRoots: [{ path: item.base, realPath: fs.realpathSync(item.base) }],
    };
    assert.equal(resolveAllowedPath(".", config, { access: "read", expectDirectory: true }), fs.realpathSync(item.root));
    assert.equal(isSensitiveReadPath(controlKey, config), true);
    assert.equal(isSensitiveReadPath(auditLog, config), true);
    assert.equal(isProtectedInternalPath(path.join(stateDir, "jobs/example.log"), config), true);
    assert.throws(() => resolveAllowedPath(controlKey, config, { access: "read" }), /outside the configured read roots/);
    assert.throws(() => resolveAllowedPath(auditLog, config, { access: "read" }), /outside the configured read roots/);
    assert.throws(() => resolveAllowedPath(path.join(stateDir, "jobs/example.log"), config, { mustExist: false }), /outside the configured write roots/);
    assert.equal(isSensitiveReadPath(path.join(os.homedir(), ".ssh", "id_ed25519"), config), true);
    assert.equal(isSensitiveReadPath(path.join(os.homedir(), ".aws", "credentials"), config), true);
    assert.equal(isSensitiveReadPath(path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"), config), true);
    assert.equal(isSensitiveReadPath(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Login Data"), config), true);
    assert.equal(isSensitiveReadPath(path.join(item.root, "src", "ordinary.js"), config), false);

    const customState = path.join(item.root, "custom-state");
    const customStateLink = path.join(item.base, "state-link");
    fs.mkdirSync(customState);
    fs.symlinkSync(customState, customStateLink);
    assert.equal(isProtectedInternalPath(path.join(customState, "private.json"), { stateDir: customStateLink }), true);
  } finally {
    item.cleanup();
  }
});

test("audit redaction removes payloads, CLI credentials, URLs, binary data, and cycles", () => {
  const value = {
    content: "private file body",
    text: "typed secret",
    patch: "*** Begin Patch\n+entire source edit\n*** End Patch",
    imageData: "aW1hZ2UtYnl0ZXM=",
    argv: ["tool", "--token", "token-value", "--api-key=key-value"],
    url: "https://example.test/path?access_token=url-value&safe=yes",
    header: "Authorization: Basic basic-value",
    cookieHeader: "Cookie: session=cookie-value; tracking=also-secret",
    binary: Buffer.from("binary-secret"),
  };
  value.self = value;
  const result = redact(value);
  const serialized = JSON.stringify(result);
  assert.match(result.content, /^\[REDACTED_CONTENT:/);
  assert.match(result.text, /^\[REDACTED_CONTENT:/);
  assert.match(result.patch, /^\[REDACTED_CONTENT:/);
  assert.match(result.imageData, /^\[REDACTED_CONTENT:/);
  assert.equal(result.argv[2], "[REDACTED]");
  assert.equal(result.argv[3], "--api-key=[REDACTED]");
  assert.equal(result.binary, "[REDACTED_BINARY:13 BYTES]");
  assert.equal(result.self, "[CIRCULAR]");
  for (const secret of ["private file body", "typed secret", "entire source edit", "aW1hZ2UtYnl0ZXM=", "token-value", "key-value", "url-value", "basic-value", "cookie-value", "also-secret", "binary-secret"]) {
    assert.equal(serialized.includes(secret), false, `redaction leaked ${secret}`);
  }
});

test("argv validation enforces executable and aggregate input bounds", () => {
  assert.deepEqual(validateArgv(["node", "--version"]), ["node", "--version"]);
  assert.throws(() => validateArgv([]), /must contain an executable/);
  assert.throws(() => validateArgv(["   "]), /valid executable/);
  assert.throws(() => validateArgv(["bad\nname"]), /control characters/);
  assert.throws(() => validateArgv(["node", "x".repeat(32_001)]), /under 32,000 bytes/);
  assert.throws(() => validateArgv(new Array(201).fill("x")), /too long/);
});

test("computer actions are normalized without executing macOS UI operations", () => {
  assert.deepEqual(normalizeComputerAction({ action: "mouse_move", x: 10.6, y: -2.4 }), { action: "mouse_move", x: 11, y: -2 });
  assert.equal(normalizeComputerAction({ action: "mouse_click", x: 1, y: 2, button: "right", clickCount: 2 }).clickCount, 2);
  assert.equal(normalizeComputerAction({ action: "mouse_drag", x: 1, y: 2, toX: 3, toY: 4 }).durationMs, 500);
  assert.equal(normalizeComputerAction({ action: "mouse_scroll", x: 1, y: 2, deltaY: 300 }).deltaY, 300);
  assert.throws(() => normalizeComputerAction({ action: "mouse_click", x: 1, y: 2, button: "invalid" }), /mouse button/);
  assert.throws(() => normalizeComputerAction({ action: "mouse_drag", x: 1, y: 2, toX: 3, toY: 4, durationMs: 10000 }), /durationMs/);
  assert.throws(() => normalizeComputerAction({ action: "mouse_scroll", x: 1, y: 2, deltaY: Infinity }), /integer/);
  assert.deepEqual(normalizeComputerAction({ action: "click", x: 10.6, y: -2.4 }), { action: "click", x: 11, y: -2 });
  assert.deepEqual(normalizeComputerAction({ action: "key", key: "ArrowLeft", modifiers: ["shift", "shift"] }), {
    action: "key",
    key: "left",
    character: "",
    modifiers: ["shift"],
  });
  assert.deepEqual(normalizeComputerAction({ action: "scroll", amount: -3 }), { action: "scroll", amount: -3 });
  assert.equal(normalizeComputerAction({ action: "open_url", url: "https://example.test/a b" }).url, "https://example.test/a%20b");
  assert.throws(() => normalizeComputerAction({ action: "click", x: Number.NaN, y: 1 }), /finite number/);
  assert.throws(() => normalizeComputerAction({ action: "scroll", amount: 1.5 }), /must be an integer/);
  assert.throws(() => normalizeComputerAction({ action: "key", key: "volume_up" }), /supported named/);
  assert.throws(() => normalizeComputerAction({ action: "key", key: "a", modifiers: ["hyper"] }), /Unsupported modifier/);
  assert.throws(() => normalizeComputerAction({ action: "open_app", app: "-W" }), /non-empty application name/);
  assert.throws(() => normalizeComputerAction({ action: "open_url", url: "file:///tmp/a" }), /HTTP and HTTPS/);
  assert.throws(() => normalizeComputerAction({ action: "open_url", url: "https://user:pass@example.test/" }), /embedded credentials/);
});

test("native UI snapshots are bounded and AXPress is tied to the latest inspection", async () => {
  const item = pathFixture();
  const stateDir = path.join(item.root, "state");
  const calls = [];
  const nativeInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "active-app") return { ok: true, app: { pid: 42, name: "Example", bundleIdentifier: "test.example" } };
    if (command === "inspect-ui") {
      return {
        ok: true,
        app: { pid: 42, name: "Example", bundleIdentifier: "test.example" },
        elements: [
          { path: "root", depth: 0, role: "AXApplication", title: "Example", actions: [] },
          { path: "0.1", depth: 2, role: "AXButton", title: "Continue", value: null, bounds: { x: 10, y: 20, width: 80, height: 24 }, actions: ["AXPress"], enabled: true, focused: false },
        ],
        truncated: false,
      };
    }
    if (command === "press-element") {
      return { ok: true, app: { pid: 42, name: "Example", bundleIdentifier: "test.example" }, role: "AXButton", title: "Continue" };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  try {
    const tools = new ComputerTools({ ...item.config, stateDir }, { nativeInvoke });
    const inspection = await tools.inspectUi({ maxElements: 20, maxDepth: 4, maxValueLength: 64 });
    assert.equal(inspection.count, 2);
    assert.equal(inspection.elements[1].pressable, true);
    assert.match(inspection.snapshotId, /^[0-9a-f-]{36}$/);
    await assert.rejects(
      tools.pressElement({ snapshotId: "wrong-snapshot", elementPath: "0.1" }),
      /latest snapshotId/,
    );
    const pressed = await tools.pressElement({ snapshotId: inspection.snapshotId, elementPath: "0.1" });
    assert.equal(pressed.action, "AXPress");
    const nativePress = calls.find((call) => call.command === "press-element");
    assert.deepEqual(nativePress.args, ["--pid", "42", "--path", "0.1", "--expected-role", "AXButton", "--expected-title", "Continue"]);
    await assert.rejects(
      tools.pressElement({ snapshotId: inspection.snapshotId, elementPath: "0.1" }),
      /latest snapshotId/,
    );
  } finally {
    item.cleanup();
  }
});

test("mouse actions require fresh screenshots and invalidate them after delivery", async () => {
  const item = pathFixture();
  const calls = [];
  try {
    const tools = new ComputerTools({ ...item.config, stateDir: path.join(item.root, "state") }, { nativeInvoke: async (command, args) => {
      if (command === "active-app") return { ok: true, app: { name: "Example", pid: 42 } };
      calls.push(JSON.parse(args[0]));
      return { ok: true, action: "mouse_drag", backend: "native-cgevent" };
    } });
    const request = { action: "mouse_drag", x: 10, y: 20, toX: 30, toY: 40, button: "right", modifiers: ["shift"] };
    await assert.rejects(tools.action(request), /screenshot/i);
    assert.equal(calls.length, 0);
    tools.lastScreenshot = { capturedAtMs: Date.now(), activeApp: "Other" };
    await assert.rejects(tools.action(request), /changed/i);
    tools.lastScreenshot = { capturedAtMs: Date.now(), activeApp: "Example" };
    await tools.action(request);
    assert.equal(calls[0].button, "right");
    assert.deepEqual(calls[0].modifiers, ["shift"]);
    assert.equal(tools.lastScreenshot, null);
    await assert.rejects(tools.action(request), /screenshot/i);
  } finally { item.cleanup(); }
});

test("native inspect and press arguments reject unbounded or stale-looking input", () => {
  assert.deepEqual(normalizeInspectOptions({}), { maxElements: 200, maxDepth: 6, maxValueLength: 256 });
  assert.throws(() => normalizeInspectOptions({ maxElements: 501 }), /between 1 and 500/);
  assert.deepEqual(normalizePressRequest({ snapshotId: "snapshot-123", elementPath: "0.2.1" }), {
    snapshotId: "snapshot-123",
    elementPath: "0.2.1",
  });
  assert.throws(() => normalizePressRequest({ snapshotId: "short", elementPath: "0.2" }), /latest computer_inspect_ui/);
  assert.throws(() => normalizePressRequest({ snapshotId: "snapshot-123", elementPath: "0/2" }), /numeric path/);
});
