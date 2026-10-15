import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshdeskClient } from "../freshdesk/client.js";
import { ok, safe } from "./util.js";

// Only the fields we read from GET /api/v2/agents/me.
interface AgentMe {
  id: number;
  contact?: { name?: string; email?: string };
}

export function registerWhoami(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "freshdesk_whoami",
    {
      title: "Freshdesk: who am I",
      description:
        "Checks the Freshdesk connection and returns the agent this API key belongs to. Call this first if any other Freshdesk tool fails with an auth error.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { data } = await client.request<AgentMe>("/agents/me");
      return ok({
        agent_id: data.id,
        name: data.contact?.name ?? null,
        email: data.contact?.email ?? null,
        rate_limit_remaining: client.rateLimitRemaining(),
      });
    })
  );
}
