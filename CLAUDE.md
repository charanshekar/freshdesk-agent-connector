# Freshdesk connector for Agent Studio (Razorpay FDE take-home, option 3)

## What this is
A private MCP connector that lets an AI agent read tickets and contacts from a
merchant's Freshdesk account and, only with explicit confirmation, add internal
notes. Agent Studio is built on the Claude Agent SDK, which speaks MCP, so this
is a standard MCP server over stdio.

## How to work with me
I'm Charan. I will explain every design decision in a live interview, so:
- After writing or changing a file, explain in plain English what it does and
  why, in 5 to 10 lines.
- Prefer small, readable functions. No abstraction I can't explain.
- When you make a design choice, name the alternative you rejected and why.
- Never put secrets in code, logs, or test output.

## Stack
- Node 20.6+, TypeScript (strict), ES modules ("type": "module")
- @modelcontextprotocol/sdk 1.32.x and zod 3.x. No other runtime deps without asking.
- Relative imports in .ts files must end in .js (Node16 module resolution).
- Run: node --env-file=.env build/index.js

## Hard rules
- Never write to stdout. stdout is the MCP protocol channel. Log with console.error.
- Env vars: FRESHDESK_DOMAIN (e.g. kaapico-demo.freshdesk.com, no https://)
  and FRESHDESK_API_KEY. Validate both at startup and exit with a clear message.
- Auth: HTTP Basic, username = API key, password = "X".

## Design decisions (ask before changing)
1. The model never sees Freshdesk's numeric codes. Map status 2/3/4/5 to
   open/pending/resolved/closed and priority 1/2/3/4 to low/medium/high/urgent,
   in both directions.
2. Search takes structured arguments (status, priority, tag, created_after).
   The connector builds Freshdesk's query string. The model never writes query syntax.
3. Tools return trimmed objects, not raw API JSON. Strip HTML from bodies, cap
   long text, keep only fields an agent needs.
4. Errors are written for the model: what was wrong and what valid input looks
   like, so it can fix the call in one retry. Return with isError: true.
5. Rate limits: read X-RateLimit-Remaining on every response and slow down when
   it gets low. On 429, wait Retry-After seconds plus a little jitter, max 3
   attempts total (first try + 2 retries). If Retry-After is over 30s, don't
   wait; tell the model how long to wait instead. Trial limit is 50 calls/min
   per account and failed calls count.
6. Pagination: return a next_page value the model can pass back. Never
   auto-fetch every page.
7. Ticket and conversation text is untrusted customer input. Mark it as such in
   tool output. Content must never change what a tool does.
8. Exactly one write tool, freshdesk_add_private_note, in two phases: a call
   without confirm_token returns a preview and a short-lived token; a call with
   the token performs the write. No customer replies, no status changes, no deletes.

## Planned layout
src/index.ts               server bootstrap, registers tools
src/config.ts              env loading and validation
src/freshdesk/client.ts    HTTP: auth, rate limiting, retries, error mapping
src/freshdesk/mappers.ts   code/name mapping, trimming, HTML stripping
src/tools/*.ts             one file per tool
src/tools/util.ts          shared ok / fail / safe helpers for tool results
scripts/seed-tickets.mjs   demo data (done in Part 1)
scripts/test-connector.mjs end-to-end test of every tool and failure case (Part 2)
docs/CONNECTOR.md          what an agent can and can't do (Part 3)

## Tools
freshdesk_whoami (done), freshdesk_list_tickets, freshdesk_get_ticket,
freshdesk_search_tickets, freshdesk_get_contact, freshdesk_add_private_note