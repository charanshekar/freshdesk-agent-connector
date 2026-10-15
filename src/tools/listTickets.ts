import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nextPageFrom, type FreshdeskClient } from "../freshdesk/client.js";
import { ticketSummary, UNTRUSTED_NOTE, type RawTicket } from "../freshdesk/mappers.js";
import { ok, safe } from "./util.js";

const PER_PAGE = 20;

export function registerListTickets(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "freshdesk_list_tickets",
    {
      title: "Freshdesk: list recent tickets",
      description:
        "Lists tickets newest first, 20 per page, as short summaries (no message text). " +
        "Without updated_since, Freshdesk only returns tickets created in the last 30 days. " +
        "To filter by status, priority, tag or creation date, use freshdesk_search_tickets instead. " +
        "To read one ticket's description and conversation, use freshdesk_get_ticket. " +
        "If next_page is not null, call again with page set to it for more.",
      inputSchema: {
        order_by: z
          .enum(["created_at", "updated_at", "due_by"])
          .default("created_at")
          .describe("Field to sort by, newest first."),
        updated_since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD, e.g. 2026-10-01.")
          .optional()
          .describe("Only tickets updated on or after this date, YYYY-MM-DD."),
        page: z.number().int().min(1).default(1).describe("Page number. Use next_page from the previous result."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ order_by, updated_since, page }) => {
      const { data, headers } = await client.request<RawTicket[]>("/tickets", {
        query: { order_by, order_type: "desc", updated_since, page, per_page: PER_PAGE },
      });
      return ok({
        note: UNTRUSTED_NOTE,
        page,
        next_page: nextPageFrom(headers, page),
        tickets: data.map(ticketSummary),
      });
    })
  );
}
