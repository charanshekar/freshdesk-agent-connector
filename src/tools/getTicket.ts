import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreshdeskClient } from "../freshdesk/client.js";
import { ticketDetail, UNTRUSTED_NOTE, type RawTicket } from "../freshdesk/mappers.js";
import { ok, safe } from "./util.js";

export function registerGetTicket(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "freshdesk_get_ticket",
    {
      title: "Freshdesk: get one ticket",
      description:
        "Reads one ticket by ID: status, priority, requester, the customer's description and up to 10 conversation messages " +
        "(oldest first, long text truncated). Use this after list or search when you need what the customer actually wrote.",
      inputSchema: {
        ticket_id: z.number().int().positive().describe("The ticket's numeric ID, e.g. 18."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ ticket_id }) => {
      // One call instead of three. Trade-off: include=conversations returns at
      // most 10 conversations. A longer thread needs GET /tickets/{id}/conversations
      // with pagination, which costs extra rate-limited calls; not worth it yet.
      const { data } = await client.request<RawTicket>(`/tickets/${ticket_id}`, {
        query: { include: "conversations,requester" },
      });
      return ok({ note: UNTRUSTED_NOTE, ticket: ticketDetail(data) });
    })
  );
}
