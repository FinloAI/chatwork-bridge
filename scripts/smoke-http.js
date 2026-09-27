#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.argv[2] || "http://127.0.0.1:7337/mcp");
const client = new Client({ name: "chatwork-smoke-test", version: "1.0.0" }, { capabilities: {} });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const tools = await client.listTools();
  const info = await client.callTool({ name: "bridge_info", arguments: {} });
  console.log(JSON.stringify({ endpoint: endpoint.toString(), toolCount: tools.tools.length, tools: tools.tools.map((tool) => tool.name), bridgeInfo: info.structuredContent }, null, 2));
} finally {
  await client.close().catch(() => {});
}
