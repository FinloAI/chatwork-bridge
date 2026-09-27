import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { FileTools } from "../src/files.js";
import { GitTools } from "../src/git.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatwork-worktools-"));
  const config = loadConfig({
    CHATWORK_ROOTS: root,
    CHATWORK_READ_ROOTS: root,
    CHATWORK_STATE_DIR: path.join(root, ".state"),
    CHATWORK_IO_TIMEOUT_MS: "2000",
  }, root);
  return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("batch reads return per-file errors and atomic writes preserve executable mode", async () => {
  const item = fixture();
  try {
    const tools = new FileTools(item.config);
    const script = path.join(item.root, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho old\n", { mode: 0o755 });
    await tools.writeFile({ path: script, content: "#!/bin/sh\necho new\n" });
    assert.equal(fs.statSync(script).mode & 0o777, 0o755);
    const result = await tools.readFiles({ paths: [script, path.join(item.root, "missing.txt")], startLine: 1, endLine: 3 });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.match(result.files[0].content, /echo new/);
    assert.match(result.files[1].error, /outside the configured read roots or does not exist/);
  } finally {
    item.cleanup();
  }
});

test("recursive read tools never enter bridge state", async () => {
  const item = fixture();
  try {
    const stateDir = path.join(item.root, ".chatwork-bridge");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "control-plane.key"), "sensitive-canary");
    fs.writeFileSync(path.join(item.root, "ordinary.txt"), "sensitive-canary");
    const tools = new FileTools({ ...item.config, stateDir });

    const listing = await tools.listDirectory({ path: item.root, depth: 4, includeHidden: true });
    assert.equal(listing.entries.some((entry) => entry.path.includes(".chatwork-bridge")), false);

    const found = await tools.findFiles({ path: item.root, pattern: "*", includeHidden: true });
    assert.equal(found.files.some((filePath) => filePath.includes(".chatwork-bridge")), false);

    const search = await tools.searchText({ path: item.root, query: "sensitive-canary", includeHidden: true });
    assert.deepEqual(search.matches.map((match) => path.basename(match.path)), ["ordinary.txt"]);
    assert.ok(search.skipped.some((entry) => entry.reason === "SENSITIVE_PATH"));
  } finally {
    item.cleanup();
  }
});

test("file discovery uses conventional glob boundaries and reports scan truncation", async () => {
  const item = fixture();
  try {
    fs.mkdirSync(path.join(item.root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(item.root, "src", "top.js"), "top");
    fs.writeFileSync(path.join(item.root, "src", "nested", "deep.js"), "deep");
    fs.writeFileSync(path.join(item.root, "src", "nested", "note.txt"), "note");
    const tools = new FileTools(item.config);
    const shallow = await tools.findFiles({ path: item.root, pattern: "src/*.js", maxResults: 20 });
    assert.deepEqual(shallow.files.map((filePath) => path.basename(filePath)), ["top.js"]);
    const recursive = await tools.findFiles({ path: item.root, pattern: "**/*.js", maxResults: 20 });
    assert.deepEqual(recursive.files.map((filePath) => path.basename(filePath)).sort(), ["deep.js", "top.js"]);
    const limited = await tools.listDirectory({ path: item.root, depth: 8, maxEntries: 1 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.truncationReasons, ["entry_limit"]);
    assert.equal(limited.scan.scannedEntries, 1);
  } finally {
    item.cleanup();
  }
});

test("sparse file discovery separates result limits from scan limits", async () => {
  const item = fixture();
  try {
    const sparse = path.join(item.root, "sparse");
    fs.mkdirSync(sparse);
    for (let index = 0; index < 450; index += 1) {
      fs.writeFileSync(path.join(sparse, `${String(index).padStart(4, "0")}.txt`), "not-python");
    }
    fs.writeFileSync(path.join(sparse, "zzz.py"), "print('found')\n");

    const tools = new FileTools(item.config);
    const complete = await tools.findFiles({ path: sparse, pattern: "*.py", maxResults: 20 });
    assert.deepEqual(complete.files.map((filePath) => path.basename(filePath)), ["zzz.py"]);
    assert.equal(complete.truncated, false);
    assert.deepEqual(complete.truncationReasons, []);
    assert.equal(complete.scan.complete, true);
    assert.equal(complete.scan.scannedEntries, 451);

    const tightScan = await new FileTools({ ...item.config, maxScanEntries: 100 })
      .findFiles({ path: sparse, pattern: "*.py", maxResults: 20 });
    assert.deepEqual(tightScan.files, []);
    assert.equal(tightScan.truncated, true);
    assert.deepEqual(tightScan.truncationReasons, ["scan_entry_limit"]);

    const matches = path.join(item.root, "matches");
    fs.mkdirSync(matches);
    for (const name of ["a.py", "b.py", "c.py"]) fs.writeFileSync(path.join(matches, name), name);
    const limitedResults = await tools.findFiles({ path: matches, pattern: "*.py", maxResults: 2 });
    assert.equal(limitedResults.files.length, 2);
    assert.equal(limitedResults.truncated, true);
    assert.deepEqual(limitedResults.truncationReasons, ["result_limit"]);

    const exact = await tools.findFiles({ path: matches, pattern: "*.py", maxResults: 3 });
    assert.equal(exact.files.length, 3);
    assert.equal(exact.truncated, false);
    assert.deepEqual(exact.truncationReasons, []);
  } finally {
    item.cleanup();
  }
});

test("writes are bounded and unsafe regular expressions are rejected", async () => {
  const item = fixture();
  try {
    const tools = new FileTools({ ...item.config, maxWriteBytes: 8 });
    await assert.rejects(tools.writeFile({ path: "large.txt", content: "123456789" }), /exceeds 8 bytes/);
    fs.writeFileSync(path.join(item.root, "input.txt"), `${"a".repeat(100)}!`);
    await assert.rejects(
      tools.searchText({ path: item.root, query: "^(a+)+$", regex: true }),
      /Potentially exponential/,
    );
  } finally {
    item.cleanup();
  }
});

test("image reads return MCP-ready metadata and base64", async () => {
  const item = fixture();
  try {
    const tools = new FileTools(item.config);
    const imagePath = path.join(item.root, "pixel.png");
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    fs.writeFileSync(imagePath, bytes);
    const image = await tools.readImage({ path: imagePath });
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").toString("hex"), bytes.toString("hex"));
  } finally {
    item.cleanup();
  }
});

test("unified patches apply inside cwd and reject traversal", async () => {
  const item = fixture();
  try {
    const tools = new FileTools(item.config);
    fs.writeFileSync(path.join(item.root, "note.txt"), "alpha\nbeta\n");
    const patch = [
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+gamma",
      "",
    ].join("\n");
    const result = await tools.applyPatch({ cwd: item.root, patch, strip: 1 });
    assert.equal(fs.readFileSync(path.join(item.root, "note.txt"), "utf8"), "alpha\ngamma\n");
    assert.equal(result.files[0].exists, true);
    const unsafe = "--- a/../escape.txt\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+no\n";
    await assert.rejects(tools.applyPatch({ cwd: item.root, patch: unsafe, strip: 1 }), /Unsafe patch path/);
  } finally {
    item.cleanup();
  }
});

test("fixed Git tools return structured repository state", { skip: !fs.existsSync("/usr/bin/git") }, async () => {
  const item = fixture();
  try {
    const git = (args) => {
      const result = spawnSync("/usr/bin/git", args, { cwd: item.root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "bridge@example.invalid"]);
    git(["config", "user.name", "Bridge Test"]);
    fs.writeFileSync(path.join(item.root, "tracked.txt"), "one\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-qm", "initial"]);
    fs.writeFileSync(path.join(item.root, "tracked.txt"), "two\n");

    const tools = new GitTools(item.config);
    const status = await tools.status({ path: item.root });
    assert.equal(status.clean, false);
    assert.equal(status.branch.head.length > 0, true);
    const diff = await tools.diff({ path: item.root });
    assert.match(diff.diff, /-one/);
    assert.match(diff.diff, /\+two/);
    const log = await tools.log({ path: item.root, limit: 5 });
    assert.equal(log.commits[0].subject, "initial");
  } finally {
    item.cleanup();
  }
});

test("Git status preserves spaces and rename paths", { skip: !fs.existsSync("/usr/bin/git") }, async () => {
  const item = fixture();
  try {
    const git = (args) => {
      const result = spawnSync("/usr/bin/git", args, { cwd: item.root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "bridge@example.invalid"]);
    git(["config", "user.name", "Bridge Test"]);
    fs.writeFileSync(path.join(item.root, "old name.txt"), "one\n");
    git(["add", "old name.txt"]);
    git(["commit", "-qm", "initial"]);
    git(["mv", "old name.txt", "new name.txt"]);
    fs.writeFileSync(path.join(item.root, "untracked file.txt"), "two\n");

    const status = await new GitTools(item.config).status({ path: item.root });
    assert.ok(status.changes.some((change) => change.kind === "renamed" && change.path === "new name.txt" && change.originalPath === "old name.txt"));
    assert.ok(status.changes.some((change) => change.kind === "untracked" && change.path === "untracked file.txt"));
  } finally {
    item.cleanup();
  }
});
