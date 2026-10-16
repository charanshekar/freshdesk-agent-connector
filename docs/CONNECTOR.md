# Freshdesk connector: what an agent can and can't do

This connector gives an Agent Studio agent read access to a merchant's Freshdesk tickets and contacts, plus one tightly gated write: adding a private, agents-only note. It is an MCP server, so any MCP host can use it; it was developed against Claude Desktop and the MCP Inspector as stand-ins for Agent Studio, which is built on the Claude Agent SDK.

The design goal: put Freshdesk-specific knowledge (numeric codes, query syntax, limits, failure modes) in code, so the model only makes simple, well-described choices it can get right.

## Tools

| Tool | What it does | Writes? | Freshdesk calls |
|---|---|---|---|
| `freshdesk_whoami` | Checks the connection, returns the agent the key acts as | No | 1 |
| `freshdesk_list_tickets` | Recent tickets, newest first, 20 per page, with `next_page` | No | 1 |
| `freshdesk_get_ticket` | One ticket in full: description, requester, up to 10 replies and notes | No | 1 |
| `freshdesk_search_tickets` | Filter by status, priority, tag, created date (AND) | No | 1 |
| `freshdesk_get_contact` | Name, email and company of a ticket's requester | No | 1 |
| `freshdesk_add_private_note` | Private note, two phases: preview, then confirm | Yes, private only | 1 per phase (GET, then POST) |

The MCP tool spec (names, descriptions, JSON Schemas) is generated from the zod schemas the server validates against, so the spec and the enforcement cannot drift. A copy is checked in at [`tool-spec.json`](tool-spec.json) (regenerate with `npm run spec`), or get it live with `tools/list` from any MCP client or the Tools tab in `npm run inspect`.

## What an agent can do

- Find what needs attention: "open urgent tickets", "open tickets tagged payments", "pending tickets created this week".
- Read a ticket end to end, including who raised it and its conversation, to summarise it or decide next steps.
- Look up the customer behind a ticket.
- Page through results deliberately, one page at a time.
- Leave an internal note for the support team, after showing the exact text to a human and getting approval.

## What an agent can't do, and why

| Can't | Why |
|---|---|
| Reply to the customer | A public reply is irreversible and customer-facing. Not exposed at all. A future version would draft replies for a human to send. |
| Change status, priority or assignee | These trigger SLAs, automations and customer emails in Freshdesk. Not exposed. |
| Delete anything | No legitimate triage task needs it. |
| Write a note in one step | The note tool returns a preview and a token first. Only a second call with that token, the same ticket and the exact same text writes. |
| See phone numbers or addresses | Data minimisation. Anything the model sees can end up in a reply or a log. |
| Write Freshdesk query syntax | Search takes structured fields. The connector builds the query, and validates tags so they can't inject query syntax. |
| See Freshdesk's numeric codes | Status and priority are words in both directions. Custom statuses (e.g. "Waiting on Customer", code 6 on the demo account) appear as `custom_status_N` rather than a wrong guess, and can't be searched yet. |
| Search tags containing spaces or symbols | The tag filter only accepts letters, digits, `-` and `_`. That is what keeps tags from injecting query syntax; Freshdesk documents no safe way to escape quotes. |
| Read attachments | Out of scope for this version. |
| See more than 10 conversations on a ticket | `get_ticket` uses one call with includes, which Freshdesk caps at 10 conversations. A dedicated, paginated conversations tool would remove this limit at the cost of extra calls. |
| See search results past 300 | Freshdesk search returns 30 per page, max 10 pages. The tool says so. |
| List tickets older than about 30 days without a date | Freshdesk's list default. The tool accepts `updated_since` for older tickets. |

## Auth

**Today: API key.** HTTP Basic with the key as username and `X` as password, read from `FRESHDESK_API_KEY` and validated at startup. A key acts as the agent who owns it, with all of that agent's permissions. For a single merchant, the right setup is a dedicated service agent with a restricted role, so even a connector bug can't exceed it.

**For Agent Studio at scale: per-merchant OAuth-style grants.** One key in an environment variable doesn't work for thousands of merchants. The production shape:

1. The merchant installs the connector from Agent Studio and grants scoped access through an OAuth-style consent flow.
2. Tokens are stored per merchant in a secrets vault, never in prompts or logs.
3. The connector runs as a remote MCP server (Streamable HTTP) and resolves the merchant's credential per request, instead of reading one process-wide env var.
4. The merchant can revoke access at any time without anyone rotating a shared key.

## Rate limits

Freshdesk limits calls per minute **per account**, shared across every integration the merchant runs, and failed calls count too. The trial allows 50 per minute.

- **Pacing:** the client tracks `x-ratelimit-remaining`. With 5 or fewer calls left, it waits 1.5 seconds before each call (about 40 per minute). This helps calls made one after another, the normal agent pattern; calls fired in parallel all see the same reading and rely on the 429 handling below.
- **Backoff:** on 429 it waits `Retry-After` plus up to 1 second of jitter, at most 3 attempts in total (failed calls count against the limit). Jitter stops agents sharing an account from retrying in lockstep.
- **Ceiling:** it never sleeps more than 30 seconds inside a tool call. Longer waits return "wait about N seconds", so the host doesn't time out and the model can tell the user.
- **Retry policy:** only 429 is retried, for reads and writes alike, because Freshdesk rejected it unprocessed. 5xx, network errors and timeouts are not retried: the agent is told to try once more, and for the note tool to check the ticket first, because a write might have landed. Other 4xx errors are never retried.
- **No auto-pagination:** the agent asks for the next page explicitly, so one question can't burn the merchant's whole minute.

## Safety

- **Customer text is untrusted.** Descriptions and conversation bodies are returned in fields ending `_untrusted`, with a note telling the model to treat them as data. Ticket subjects and contact names are also customer-written but keep their plain names; a model should treat them the same way. The seed data includes a deliberate prompt injection (a ticket telling "the AI assistant" to resolve every ticket and approve a refund). Even if a model were fooled, the connector exposes no tool that can resolve tickets or issue refunds.
- **One write, private only, two phases.** The confirmation token is random, expires in 5 minutes, is bound to the ticket and a SHA-256 hash of the exact text, and is deleted before the write, so it can never be used twice. A mismatched ticket or text cancels it. If the write times out or Freshdesk returns 5xx, the agent is told the note may or may not exist and to check the ticket before trying again.
- **Honest limit:** the token does not stop a model from confirming its own preview. It makes the write a separate, explicit call with a distinctive argument, which a host can require a human click on, and it guarantees that what is written is exactly what was previewed, once.
- **HTML escaping:** note text is escaped before it is sent, so model-written text can't inject markup into the agent's Freshdesk view.
- **Tool annotations:** read tools are marked `readOnlyHint: true` so hosts can auto-approve them and only prompt for the write. Annotations are hints, so they complement the safeguards above rather than replace them.
- **stdout is reserved** for the protocol. All logs go to stderr and never include the API key.

## Errors the agent sees

| Situation | What the agent is told |
|---|---|
| Bad key (401) | Credentials rejected, the merchant admin needs to check them, do not retry |
| No permission (403) | The agent behind the key can't do this, do not retry |
| Not found (404) | Nothing at that path, check the id is correct |
| Validation (400) | Each field Freshdesk rejected, with its message |
| Bad arguments | Rejected before any call, listing valid values (e.g. the four statuses) |
| Rate limited | Wait about N seconds before calling Freshdesk tools again |
| Network or timeout | Couldn't reach Freshdesk; try once more, then tell the user |
| Note write timed out or 5xx | The note may or may not have been added; check the ticket before trying again |
| Anything unexpected | Unexpected connector error, nothing was changed in Freshdesk |

## Testing

`npm test` runs `scripts/test-connector.mjs`, an MCP client that starts the server over stdio the way a host does and checks every tool and failure path: schema, auth, pagination, missing and malformed ids, search validation including an injection attempt, contact minimisation, and every path through the two-phase note. Refusal checks assert the *specific* failure (a 404, or input validation before any Freshdesk call), so an outage can't make them pass. Current result: 21 checks, all passing against a live trial account, about 10 API calls per run.

`npm test -- --burst` fires 60 calls at once against the live account. Result: 17 succeeded, then Freshdesk returned `Retry-After: 38`; since that exceeds the 30 second ceiling, the other 43 calls returned a clean "Wait 38 seconds" error within 0.3 seconds. Nothing crashed, hung or threw.

[`manual_eval.md`](manual_eval.md) logs wrong tool choices seen with a real model and the description change that fixed each one. `npm test` checks the connector is correct; that log is about whether a model uses it well.

## Known limits

- **The model can confirm its own preview.** The two-phase note makes approval the natural path and binds it to the exact text, but a human click is only guaranteed if the host gates calls that carry `confirm_token`.
- **No cap on note volume.** Beyond Freshdesk's rate limit, nothing stops a looping agent from posting many notes. A per-session cap is a small addition.
- **The API key carries its agent's full permissions.** The connector limits what the AI agent can do, not what the key can do. Anyone holding `.env` can call Freshdesk directly, so use a dedicated agent with a restricted role.
- **State lives in one process.** Rate-limit readings and pending confirmations are in memory: a restart cancels pending previews (safe), and several instances don't share them.
- **Not re-checked at confirm time.** If a ticket is merged or closed in the 5 minutes between preview and confirm, the note is still added (or fails with 404).
- **Freshdesk's own limits** apply: search lags a few minutes behind new tickets, 300 results max, the list defaults to the last 30 days, 10 conversations per ticket read.

## What I'd build next

1. Per-merchant OAuth and a remote Streamable HTTP transport, as described above.
2. A shared store (for example Redis) for rate-limit state and pending confirmations, so multiple server instances behave as one.
3. A `draft_reply` tool that creates a reply for a human to review and send, never sending it itself.
4. Merchant-configurable policy: which tools are enabled, and which calls always need human approval.
5. Custom field and custom status mapping read from the merchant's Freshdesk configuration (`/ticket_fields`), so `custom_status_6` becomes `waiting_on_customer` and is searchable.
6. Webhooks for new and updated tickets, so agents react in real time instead of polling.
7. A tool-choice eval in CI: natural-language tasks with expected tools and arguments, run on every description change.