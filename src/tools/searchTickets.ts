import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreshdeskClient } from "../freshdesk/client.js";
import {
  PRIORITY_NAMES,
  priorityCode,
  STATUS_NAMES,
  statusCode,
  ticketSummary,
  UNTRUSTED_NOTE,
  type PriorityName,
  type RawTicket,
  type StatusName,
} from "../freshdesk/mappers.js";
import { fail, isoDate, ok, safe } from "./util.js";

// Fixed by Freshdesk's search API: 30 results per page, pages 1 to 10.
const PER_PAGE = 30;
const MAX_PAGE = 10;

// Allowlist, not escaping: these characters can never close the quotes around
// the tag in the query string, so a tag value can't add its own conditions.
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

interface Filters {
  status?: StatusName;
  priority?: PriorityName;
  tag?: string;
  created_after?: string;
}

interface SearchResponse {
  total: number;
  results: RawTicket[];
}

export function registerSearchTickets(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "freshdesk_search_tickets",
    {
      title: "Freshdesk: search tickets",
      description:
        "Finds tickets by status, priority, tag and/or creation date. Give at least one filter; all given filters combine with AND. " +
        "Returns short summaries (no message text), 30 per page, at most 10 pages (300 tickets), with the total match count. " +
        "Newly created or updated tickets can take a few minutes to appear in search; use freshdesk_list_tickets for the very latest. " +
        "Use freshdesk_get_ticket to read one ticket's conversation.",
      inputSchema: {
        status: z.enum(STATUS_NAMES).optional().describe("Ticket status."),
        priority: z.enum(PRIORITY_NAMES).optional().describe("Ticket priority."),
        tag: z
          .string()
          .regex(TAG_PATTERN, "A tag is 1 to 40 letters, digits, hyphens or underscores, e.g. duplicate-charge. No spaces or quotes.")
          .optional()
          .describe("One tag the ticket must have, e.g. payments."),
        created_after: isoDate.optional().describe("Only tickets created on or after this date, YYYY-MM-DD."),
        page: z.number().int().min(1).max(MAX_PAGE).default(1).describe("Page 1 to 10. Use next_page from the previous result."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ page, ...filters }) => {
      const query = buildQuery(filters);
      if (!query) {
        return fail("Give at least one filter: status, priority, tag or created_after. To see recent tickets without filters, use freshdesk_list_tickets.");
      }

      const { data } = await client.request<SearchResponse>("/search/tickets", { query: { query, page } });
      const hasMore = page < MAX_PAGE && page * PER_PAGE < data.total;
      return ok({
        note: UNTRUSTED_NOTE,
        filters,
        total: data.total,
        page,
        next_page: hasMore ? page + 1 : null,
        tickets: data.results.map(ticketSummary),
      });
    })
  );
}

// Builds e.g. "status:2 AND tag:'payments'". Every value is either a number we
// computed or a string that already passed TAG_PATTERN / isoDate, so nothing
// the model sends is copied into the query unchecked.
function buildQuery(filters: Filters): string | null {
  const parts: string[] = [];
  if (filters.status) parts.push(`status:${statusCode(filters.status)}`);
  if (filters.priority) parts.push(`priority:${priorityCode(filters.priority)}`);
  if (filters.tag) parts.push(`tag:'${filters.tag}'`);
  if (filters.created_after) parts.push(`created_at:>'${filters.created_after}'`);
  return parts.length > 0 ? `"${parts.join(" AND ")}"` : null;
}
