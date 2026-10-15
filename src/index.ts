import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DOMAIN = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;

if (!DOMAIN || !API_KEY) {
  console.error("Missing FRESHDESK_DOMAIN or FRESHDESK_API_KEY");
  process.exit(1);
}

const server = new McpServer({ name: "freshdesk-connector", version: "0.1.0" });

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Returns a greeting. Use only to check that the connector is reachable.",
    inputSchema: { name: z.string().describe("Who to greet") },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `pong, hello ${name}` }],
  })
);

server.registerTool(
  "freshdesk_whoami",
  {
    title: "Freshdesk: who am I",
    description:
      "Checks the Freshdesk connection and returns the agent this API key belongs to. Call this first if any other Freshdesk tool fails with an auth error.",
    inputSchema: {},
  },
  async () => {
    const auth = Buffer.from(`${API_KEY}:X`).toString("base64");
    const res = await fetch(`https://${DOMAIN}/api/v2/agents/me`, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Freshdesk returned ${res.status}. Check FRESHDESK_DOMAIN and FRESHDESK_API_KEY.` }],
      };
    }
    const me: any = await res.json();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ agent_id: me.id, name: me.contact?.name, email: me.contact?.email, rate_limit_remaining: remaining }, null, 2),
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("freshdesk-connector running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});