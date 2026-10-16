// Writes docs/tool-spec.json: the exact MCP tool spec (names, descriptions,
// input JSON Schemas, annotations) that a host receives from tools/list.
// Generated from the running server, so it can't drift from the code.
//
//   npm run build && npm run spec
//
// Needs no Freshdesk account: listing tools makes no API calls, so the server
// is started with placeholder credentials.

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUTPUT = "docs/tool-spec.json";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: { ...process.env, FRESHDESK_DOMAIN: "example.freshdesk.com", FRESHDESK_API_KEY: "placeholder-not-used" },
  stderr: "ignore",
});
const client = new Client({ name: "dump-tool-spec", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
writeFileSync(OUTPUT, `${JSON.stringify({ tools }, null, 2)}\n`);
console.log(`Wrote ${tools.length} tools to ${OUTPUT}`);

await client.close();
