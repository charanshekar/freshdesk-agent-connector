# freshdesk-agent-connector

A private MCP connector that lets an AI agent read tickets and contacts from a merchant's Freshdesk account and, only with explicit confirmation, add internal notes.

Built for Razorpay's Forward Deployed Engineer take-home, option 3: "Ship a private connector for a merchant tool". Agent Studio is built on the Claude Agent SDK, which speaks MCP, so this is a standard MCP server over stdio. Claude Desktop and the MCP Inspector stand in for Agent Studio during development.

**Status: complete.** Six tools, an end-to-end test script, and a capability doc. Start with [`docs/CONNECTOR.md`](docs/CONNECTOR.md) for what an agent can and can't do.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `freshdesk_whoami` | Connection check | No |
| `freshdesk_list_tickets` | Recent tickets, 20 per page, `next_page` | No |
| `freshdesk_get_ticket` | One ticket with requester and latest conversations | No |
| `freshdesk_search_tickets` | Structured filters: status, priority, tag, created_after | No |
| `freshdesk_get_contact` | Requester name, email, company (no phone numbers) | No |
| `freshdesk_add_private_note` | Private note, preview first, confirm with a single-use token | Yes, private only |

## Layout

```
CLAUDE.md                     design rules used during the build
docs/CONNECTOR.md             what an agent can and can't do, auth, rate limits, safety
docs/description-fixes.md     wrong tool picks seen in testing and the description fix for each
scripts/seed-tickets.mjs      15 realistic D2C support tickets, including a prompt injection
scripts/test-connector.mjs    end-to-end tests through the MCP protocol
src/index.ts                  server bootstrap
src/config.ts                 env loading and validation
src/freshdesk/client.ts       the only file that does HTTP: auth, pacing, retries, errors
src/freshdesk/mappers.ts      codes to words, HTML to text, trimming, untrusted labels
src/tools/*.ts                one file per tool
```

## Run it

Requires Node 20.6 or newer (for `--env-file`) and a Freshdesk account. A free trial works.

```bash
git clone https://github.com/charanshekar/freshdesk-agent-connector.git
cd freshdesk-agent-connector
npm install
cp .env.example .env      # Charan sends the trial key separately, never in chat or git
npm run build
node --env-file=.env scripts/seed-tickets.mjs   # optional: demo data
npm test                  # end-to-end tests, about 25 API calls
npm run inspect           # browse and call the tools in the MCP Inspector
```

## Design decisions

Full detail in `docs/CONNECTOR.md`.

1. **The model never sees Freshdesk's numeric codes.** Status 2/3/4/5 and priority 1/2/3/4 are mapped to words in both directions.
2. **Search takes structured arguments.** The connector builds Freshdesk's query string; the model never writes query syntax. Tags are regex-validated before going into the query, to block injection.
3. **Tools return trimmed objects, not raw API JSON.** HTML stripped, long text truncated with a marker, only fields an agent needs.
4. **Errors are written for the model.** Each error says what went wrong, whether to retry, and what to do next.
5. **Rate limits are handled proactively and reactively.** See below.
6. **Pagination returns `next_page`.** The connector never auto-fetches every page. *Link header parsing done, used from step 3.*
7. **Customer-written text is labelled untrusted.** Ticket bodies are data, never instructions. One seed ticket is a deliberate prompt injection.
8. **Exactly one write tool, in two phases.** `freshdesk_add_private_note` returns a preview and a single-use token bound to the exact text; only a second call with the token writes. No customer replies, status changes or deletes.

## How the HTTP client works

`src/freshdesk/client.ts` exposes one function, `freshdesk<T>(path, options)`, that every tool will call.

- **Auth:** HTTP Basic, API key as username, `X` as password. 15 second timeout per request.
- **Pacing (proactive):** remembers `x-ratelimit-remaining` from the last response. When 5 or fewer calls are left in the minute, waits about 1.5s plus jitter before each call. The trial limit is 50 calls per minute per account, shared across every integration, and failed calls count too.
- **Backoff (reactive):** on 429, waits `Retry-After` seconds plus up to 1s jitter, up to 3 attempts. Never sleeps more than 30s inside a tool call; returns "wait about N seconds" instead, because hosts time out long tool calls.
- **Retry policy:**

  | Response | Retried? | Why |
  |---|---|---|
  | 429 | Yes, even for POST | Rejected before processing, so safe |
  | 5xx, network error, timeout | GET only | A POST may have landed; retrying could duplicate a note |
  | 400, 401, 403, 404 | Never | Same request fails the same way and still costs budget |

- **Errors:** throws `FreshdeskError(status, modelMessage)`. 401, 403 and 404 get fixed messages that tell the model whether to retry. 400s list each field error Freshdesk returned.
- **Logging:** every call logs method, path, status, remaining budget and cost to **stderr**. stdout is the MCP protocol channel and must stay clean.
- **Pagination helper:** `nextPageFrom(headers)` reads the page number from the `Link: <...>; rel="next"` header.

## Using it from Claude Desktop

Add to `claude_desktop_config.json` (Settings, Developer, Edit Config), using absolute paths:

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "/absolute/path/to/node",
      "args": ["--env-file=/absolute/path/to/.env", "/absolute/path/to/build/index.js"]
    }
  }
}
```

## Known limits

See the "can't" table and "What I'd build next" in [`docs/CONNECTOR.md`](docs/CONNECTOR.md). In short: API key auth for one merchant today (OAuth-style grants for many), rate-limit and confirmation state live in one process, and `get_ticket` returns the 10 most recent conversations.