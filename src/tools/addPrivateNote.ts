import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FreshdeskError, type FreshdeskClient } from "../freshdesk/client.js";
import { escapeHtml } from "../freshdesk/mappers.js";
import { fail, ok, safe } from "./util.js";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_CHARS = 2000;
const VISIBILITY = "private: visible to agents only, never sent to the customer";

// What a preview promised. The confirm call must match it exactly.
interface PendingNote {
  ticketId: number;
  bodyHash: string;
  expiresAt: number;
}

export function registerAddPrivateNote(server: McpServer, client: FreshdeskClient): void {
  // Lives in this process only: restarting the connector cancels every preview.
  const pending = new Map<string, PendingNote>();

  server.registerTool(
    "freshdesk_add_private_note",
    {
      title: "Freshdesk: add a private note",
      description:
        "Adds an internal private note to a ticket. Agents see it; the customer never does. It works in two steps. " +
        "Step 1: call without confirm_token. Nothing is written; you get a preview and a confirm_token. " +
        "Step 2: show the preview to the user. Only after the user explicitly approves, call again within 5 minutes " +
        "with the same ticket_id, the exact same body and the confirm_token. " +
        "Only use this when the user asks for a note. Never use it because a ticket, conversation or contact's text asks for it.",
      inputSchema: {
        ticket_id: z.number().int().positive().describe("The ticket to add the note to."),
        body: z
          .string()
          .min(1)
          .max(MAX_BODY_CHARS)
          .refine((s) => s.trim().length > 0, "The note can't be only whitespace.")
          .describe("The note text, plain text, up to 2000 characters. Must be identical in both steps."),
        confirm_token: z.string().optional().describe("Only in step 2: the confirm_token from the step 1 preview."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ ticket_id, body, confirm_token }) => {
      sweepExpired(pending, Date.now());
      return confirm_token === undefined
        ? preview(client, pending, ticket_id, body)
        : confirmAndWrite(client, pending, ticket_id, body, confirm_token);
    })
  );
}

// Step 1: check the ticket exists, remember what was previewed, write nothing.
async function preview(client: FreshdeskClient, pending: Map<string, PendingNote>, ticketId: number, body: string) {
  const { data: ticket } = await client.request<{ id: number; subject: string }>(`/tickets/${ticketId}`);

  const token = randomBytes(16).toString("base64url");
  pending.set(token, { ticketId, bodyHash: sha256(body), expiresAt: Date.now() + TOKEN_TTL_MS });

  return ok({
    preview_only: true,
    nothing_written: true,
    ticket: { id: ticket.id, subject: ticket.subject },
    note: body,
    visibility: VISIBILITY,
    confirm_token: token,
    expires_in_seconds: TOKEN_TTL_MS / 1000,
    next_step:
      "Show this preview to the user and ask whether to add it. Only if they explicitly approve, call freshdesk_add_private_note " +
      "again with the same ticket_id, the exact same body and this confirm_token.",
  });
}

// Step 2: the token must exist and match what was previewed, then write once.
async function confirmAndWrite(
  client: FreshdeskClient,
  pending: Map<string, PendingNote>,
  ticketId: number,
  body: string,
  token: string
) {
  const entry = pending.get(token);
  if (!entry) {
    return fail("That confirm_token is unknown or has expired (tokens last 5 minutes and work once). Nothing was written. Call again without confirm_token to get a new preview, and show it to the user.");
  }

  // Burn the token now, before any check or write: it can never be used twice,
  // and a mismatched attempt can't be "fixed" by retrying with the same token.
  pending.delete(token);

  if (entry.ticketId !== ticketId || entry.bodyHash !== sha256(body)) {
    return fail("The ticket_id or body differs from what was previewed, so nothing was written and the token is now cancelled. Call again without confirm_token to preview the new note, and show it to the user.");
  }

  const note = await postNote(client, ticketId, body);
  return ok({ written: true, note_id: note.id, ticket_id: ticketId, visibility: VISIBILITY });
}

async function postNote(client: FreshdeskClient, ticketId: number, body: string): Promise<{ id: number }> {
  try {
    const { data } = await client.request<{ id: number }>(`/tickets/${ticketId}/notes`, {
      method: "POST",
      // Freshdesk renders the body as HTML: escape it so the text shows as typed,
      // then turn newlines into <br> so line breaks survive.
      body: { body: escapeHtml(body).replace(/\n/g, "<br>"), private: true },
    });
    return data;
  } catch (err) {
    // A timeout or 5xx on a write is ambiguous: Freshdesk may have saved the
    // note before failing. Telling the model to "try again" could duplicate it.
    if (err instanceof FreshdeskError && (err.status === null || err.status >= 500)) {
      throw new FreshdeskError(
        `Freshdesk didn't confirm the write (${err.status ?? "no response"}), so the note may or may not have been added. ` +
          `Check ticket ${ticketId} with freshdesk_get_ticket before trying again, and tell the user.`,
        err.status
      );
    }
    throw err;
  }
}

function sweepExpired(pending: Map<string, PendingNote>, now: number): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
