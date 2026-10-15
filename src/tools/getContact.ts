import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreshdeskClient } from "../freshdesk/client.js";
import { ok, safe } from "./util.js";

// Only the fields we read from GET /api/v2/contacts/{id}.
interface RawContact {
  id: number;
  name: string;
  email: string | null;
  company_id: number | null;
  created_at: string;
}

export function registerGetContact(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "freshdesk_get_contact",
    {
      title: "Freshdesk: get one contact",
      description:
        "Looks up the customer behind a ticket: name, email, company ID and when the contact was created. " +
        "Pass the requester_id from a ticket. Phone numbers, addresses and other personal details are deliberately not exposed.",
      inputSchema: {
        contact_id: z.number().int().positive().describe("The contact's numeric ID: the requester_id field of a ticket."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ contact_id }) => {
      const { data } = await client.request<RawContact>(`/contacts/${contact_id}`);
      // Data minimisation: Freshdesk returns phone, mobile, address, social IDs,
      // custom fields and more. An agent triaging tickets needs to know who the
      // customer is and how to reach them by email, nothing else. Every extra
      // personal field we return is one more thing that can end up in a model's
      // context, a log or a reply, so we copy out only what's needed.
      return ok({
        id: data.id,
        name: data.name,
        email: data.email,
        company_id: data.company_id,
        created_at: data.created_at,
      });
    })
  );
}
