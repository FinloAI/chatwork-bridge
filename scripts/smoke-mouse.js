import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "mouse-smoke", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: path.join(os.homedir(), ".chatwork-bridge-current/scripts/start-chatgpt-stdio.sh"),
  stderr: "pipe",
});
let original;
let moved = false;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(item => item.type === "text")?.text);
  return result.structuredContent;
}
try {
  await client.connect(transport);
  const info = await call("bridge_info");
  assert.equal(info.version, "0.4.4");
  const shot = await call("computer_screenshot");
  const coords = shot.coordinates;
  assert.ok(coords.pixelsPerPointX > 0);
  original = coords.cursor;
  const target = { x: coords.mainDisplay.x + 100, y: coords.mainDisplay.y + 100 };
  // Exercise only cursor movement on the user's desktop; never click existing UI.
  moved = true;
  const result = await call("computer_action", { action: "mouse_move", ...target });
  assert.ok(Math.abs(result.cursor.x - target.x) < 2 && Math.abs(result.cursor.y - target.y) < 2);
  await call("computer_screenshot");
  const restored = await call("computer_action", { action: "mouse_move", ...original });
  assert.ok(Math.abs(restored.cursor.x - original.x) < 2 && Math.abs(restored.cursor.y - original.y) < 2);
  moved = false;
  await call("computer_screenshot");
  console.log(JSON.stringify({ version: info.version, mouseMoveVerified: true, cursorRestored: true,
    pixelsPerPointX: coords.pixelsPerPointX, pixelsPerPointY: coords.pixelsPerPointY }));
} finally {
  if (moved && original) {
    await call("computer_screenshot");
    await call("computer_action", { action: "mouse_move", ...original });
  }
  await client.close();
}
