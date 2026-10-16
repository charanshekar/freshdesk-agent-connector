// End-to-end test: starts the built connector over stdio, exactly as Agent
// Studio would, and checks every tool and failure case against the real
// Freshdesk account in .env.
//
//   npm run build && npm test             normal run (~20 API calls, writes ONE private note)
//   npm test -- --burst                   also fires 60 list calls at once to exercise rate limiting
//
// Prints PASS/FAIL per check and exits 1 if anything failed. Never prints the
// API key or customer emails.

import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BURST = process.argv.includes("--burst");
const BURST_CALLS = 60;
const EXPECTED_TOOLS = 6;
const MIN_DESCRIPTION_CHARS = 40;
const STATUS_WORD = /^(open|pending|resolved|closed|custom_status_\d+)$/;

let failures = 0;

function check(name, passed, detail = "") {
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${!passed && detail ? `\n      ${detail}` : ""}`);
}

// Returns { isError, text, json }. A thrown error from callTool (protocol error,
// timeout) counts as an error result too, so a check can't pass by crashing.
async function call(client, name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    return { isError: result.isError === true, text, json: parseJson(text) };
  } catch (err) {
    return { isError: true, text: `thrown: ${err.message}`, json: null };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Input validation errors come from zod in the MCP SDK, before any Freshdesk
// call. Checking for them proves the request was stopped by our schema, not by
// Freshdesk being down.
function isValidationError(r) {
  return r.isError && /validation/i.test(r.text);
}

function short(text) {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// ---------- Checks, one function per tool ----------

async function checkToolList(client) {
  const { tools } = await client.listTools();
  check(`exactly ${EXPECTED_TOOLS} tools`, tools.length === EXPECTED_TOOLS, `got ${tools.map((t) => t.name).join(", ")}`);
  const thin = tools.filter((t) => (t.description ?? "").length <= MIN_DESCRIPTION_CHARS).map((t) => t.name);
  check(`every description over ${MIN_DESCRIPTION_CHARS} characters`, thin.length === 0, `too short: ${thin.join(", ")}`);
}

async function checkWhoami(client) {
  const r = await call(client, "freshdesk_whoami");
  check("whoami succeeds", !r.isError && typeof r.json?.agent_id === "number", short(r.text));
}

// Returns a ticket and its requester_id for the later checks.
async function checkListTickets(client) {
  const r = await call(client, "freshdesk_list_tickets");
  const tickets = r.json?.tickets ?? [];
  check("list returns tickets", !r.isError && tickets.length > 0, short(r.text));
  const badStatus = tickets.filter((t) => !STATUS_WORD.test(String(t.status)));
  check("list statuses are words, not codes", tickets.length > 0 && badStatus.length === 0, `bad: ${badStatus.map((t) => t.status).join(", ")}`);

  if (r.json?.next_page) {
    const next = await call(client, "freshdesk_list_tickets", { page: r.json.next_page });
    check("list next_page returns the next page", !next.isError && next.json?.page === r.json.next_page && next.json.tickets.length > 0, short(next.text));
  } else {
    console.log("SKIP  list next_page (only one page of tickets)");
  }
  return tickets[0];
}

async function checkGetTicket(client, ticketId) {
  const r = await call(client, "freshdesk_get_ticket", { ticket_id: ticketId });
  check("get_ticket returns detail with description_untrusted", !r.isError && typeof r.json?.ticket?.description_untrusted === "string", short(r.text));
  check("get_ticket output includes the untrusted note", typeof r.json?.note === "string" && r.json.note.includes("_untrusted"));

  const missing = await call(client, "freshdesk_get_ticket", { ticket_id: 999999999 });
  check("get_ticket with a missing id is a 404 error", missing.isError && missing.text.includes("404"), short(missing.text));

  const stringId = await call(client, "freshdesk_get_ticket", { ticket_id: "11" });
  check("get_ticket with a string id is rejected by validation", isValidationError(stringId), short(stringId.text));
}

async function checkSearch(client) {
  const r = await call(client, "freshdesk_search_tickets", { status: "open", priority: "urgent" });
  const tickets = r.json?.tickets ?? [];
  const allMatch = tickets.every((t) => t.status === "open" && t.priority === "urgent");
  check("search open + urgent returns only matching tickets", !r.isError && tickets.length > 0 && allMatch, short(r.text));

  const noFilters = await call(client, "freshdesk_search_tickets", {});
  check("search with no filters is an error", noFilters.isError, short(noFilters.text));

  const injection = await call(client, "freshdesk_search_tickets", { tag: "x' OR status:2" });
  check("search rejects tag injection before calling Freshdesk", isValidationError(injection), short(injection.text));

  const badStatus = await call(client, "freshdesk_search_tickets", { status: "done" });
  check('search rejects status "done" before calling Freshdesk', isValidationError(badStatus), short(badStatus.text));
}

async function checkGetContact(client, contactId) {
  const r = await call(client, "freshdesk_get_contact", { contact_id: contactId });
  check("get_contact succeeds", !r.isError && r.json?.id === contactId, short(r.text.replace(/"email": "[^"]*"/, '"email": "<hidden>"')));
  const leaked = ["phone", "mobile"].filter((field) => r.json && field in r.json);
  check("get_contact has no phone or mobile fields", r.json !== null && leaked.length === 0, `found: ${leaked.join(", ")}`);
}

async function checkPrivateNote(client, ticketId) {
  const body = `Automated connector test note, ${new Date().toISOString()}. Safe to delete.`;

  const preview = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body });
  const token = preview.json?.confirm_token;
  check("note preview returns a token and writes nothing", !preview.isError && typeof token === "string" && preview.json.nothing_written === true, short(preview.text));

  const wrongToken = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body, confirm_token: "not-a-real-token" });
  check("note with a wrong token is refused", wrongToken.isError, short(wrongToken.text));

  const changedBody = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body: `${body} (edited)`, confirm_token: token });
  check("note with a changed body and a real token is refused", changedBody.isError, short(changedBody.text));

  const fresh = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body });
  const freshToken = fresh.json?.confirm_token;
  const confirm = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body, confirm_token: freshToken });
  check("note fresh preview + confirm writes", !confirm.isError && confirm.json?.written === true && typeof confirm.json.note_id === "number", short(confirm.text));

  const reuse = await call(client, "freshdesk_add_private_note", { ticket_id: ticketId, body, confirm_token: freshToken });
  check("note token cannot be reused", reuse.isError, short(reuse.text));
}

// Fires all calls at once, like a misbehaving agent. Not PASS/FAIL on its own:
// with a 50/min limit some calls are expected to fail, the point is that each
// failure is a clean, model-readable error and nothing crashes or hangs.
async function burst(client) {
  console.log(`\nBurst: ${BURST_CALLS} list calls at once…`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: BURST_CALLS }, () => call(client, "freshdesk_list_tickets")));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const errors = results.filter((r) => r.isError);
  const messages = new Map();
  for (const r of errors) messages.set(r.text, (messages.get(r.text) ?? 0) + 1);

  console.log(`      ${results.length - errors.length} succeeded, ${errors.length} errors, ${seconds}s`);
  for (const [text, count] of messages) console.log(`      ${count}× ${short(text)}`);
  check("burst: every error is a clean tool error, nothing thrown", errors.every((r) => !r.text.startsWith("thrown:")));
}

// ---------- Run ----------

async function main() {
  if (!existsSync("build/index.js")) {
    console.error("build/index.js not found. Run `npm run build` first.");
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["--env-file=.env", "build/index.js"],
    stderr: "ignore",
  });
  const client = new Client({ name: "test-connector", version: "1.0.0" });
  await client.connect(transport);

  try {
    await checkToolList(client);
    await checkWhoami(client);
    const ticket = await checkListTickets(client);
    if (ticket) {
      await checkGetTicket(client, ticket.id);
      await checkSearch(client);
      await checkGetContact(client, ticket.requester_id);
      await checkPrivateNote(client, ticket.id);
    } else {
      check("tickets available for the remaining checks", false, "list returned no tickets; seed data first");
    }
    if (BURST) await burst(client);
  } finally {
    await client.close();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
