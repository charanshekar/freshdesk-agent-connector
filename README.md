# freshdesk-agent-connector

A private MCP connector that lets an AI agent read tickets and contacts from a merchant's Freshdesk account and, only with explicit confirmation, add internal notes.

Agent Studio is built on the Claude Agent SDK, which speaks MCP, so this is a standard MCP server over stdio. Claude Desktop and the MCP Inspector stand in for Agent Studio during development.

**Status: Part 2, step 1 of 9 done.** The foundation (config, HTTP client, health check) works. The ticket tools are next.

## Progress

| Area | Status |
|---|---|
| Freshdesk trial, API key, 15 seeded demo tickets | Done |
| Project scaffold: TypeScript, MCP SDK 1.32.1, zod 3, tsconfig, npm scripts | Done |
| `src/config.ts`: env loading and validation | Done |
| `src/freshdesk/client.ts`: auth, rate limiting, retries, error mapping | Done, **ready for review** |
| `freshdesk_whoami` health check tool using the client | Done |
| Tested in MCP Inspector and Claude Desktop | Done |
| Mappers, ticket tools, search, contact, two-phase note | Pending |
| End-to-end test script | Pending |
| Capability doc and tool-choice eval | Pending |

## What's in the repo right now

```
.env.example               required variables, no secrets
scripts/seed-tickets.mjs   creates 15 realistic D2C support tickets
src/index.ts               server bootstrap, registers tools, connects stdio
src/config.ts              reads and validates FRESHDESK_DOMAIN and FRESHDESK_API_KEY
src/freshdesk/client.ts    the only file that does HTTP
```

## Run it

Requires Node 20.6 or newer (for `--env-file`).

```bash
git clone https://github.com/charanshekar/freshdesk-agent-connector.git
cd freshdesk-agent-connector
npm install
cp .env.example .env      # Charan sends the trial key separately, never in chat or git
npm run build
npm run inspect           # opens the MCP Inspector; run freshdesk_whoami
```

## Design decisions

These are the fixed design rules. The ones marked done are in the code today.

1. **The model never sees Freshdesk's numeric codes.** Status 2/3/4/5 and priority 1/2/3/4 are mapped to words in both directions. *Pending, step 2.*
2. **Search takes structured arguments.** The connector builds Freshdesk's query string; the model never writes query syntax. Tags are regex-validated before going into the query, to block injection. *Pending, step 4.*
3. **Tools return trimmed objects, not raw API JSON.** HTML stripped, long text truncated with a marker, only fields an agent needs. *Pending, step 2.*
4. **Errors are written for the model.** Each error says what went wrong, whether to retry, and what to do next. *Done in the client.*
5. **Rate limits are handled proactively and reactively.** *Done in the client.* See below.
6. **Pagination returns `next_page`.** The connector never auto-fetches every page. *Link header parsing done, used from step 3.*
7. **Customer-written text is labelled untrusted.** Ticket bodies are data, never instructions. One seed ticket is a deliberate prompt injection. *Pending, step 2.*
8. **Exactly one write tool, in two phases.** `freshdesk_add_private_note` returns a preview and a single-use token bound to the exact text; only a second call with the token writes. No customer replies, status changes or deletes. *Pending, step 6.*

## How the client works (review this first)

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

### Questions for the reviewer

1. Is the retry table right? Anything you'd retry or not retry differently?
2. Pacing uses a single module-level `lastRemaining`. Fine for one stdio process. What would you do with several server instances sharing one merchant's budget?
3. Is a 30s ceiling on in-call waiting sensible, or too long for most hosts?
4. Are the error messages useful to a model, or too wordy?
5. Anything in `config.ts` you'd validate that I don't?

## Roadmap

### Part 2: build (in progress)

- [x] Step 1. Config and HTTP client, whoami refactored onto it
- [ ] Step 2. `mappers.ts` (code mapping, HTML stripping, trimming, untrusted labels) and `tools/util.ts` (uniform results, error wrapper)
- [ ] Step 3. `freshdesk_list_tickets` (20 per page, `next_page`) and `freshdesk_get_ticket` (one call with conversations and requester)
- [ ] Step 4. `freshdesk_search_tickets` with structured filters and the tag regex
- [ ] Step 5. `freshdesk_get_contact` with data minimisation (no phone numbers)
- [ ] Step 6. `freshdesk_add_private_note`, two-phase, single-use hashed token, 5 minute expiry
- [ ] Step 7. `scripts/test-connector.mjs`, an MCP client that checks every tool and failure path, plus an optional offline mock for rate-limit testing
- [ ] Step 8. Real agent session in Claude Desktop, with `docs/description-fixes.md` logging every wrong tool pick and the description change that fixed it
- [ ] Step 9. Commit, push, review

### Part 3: finish

- [ ] Review fixes from this README's questions
- [ ] `docs/CONNECTOR.md`: what an agent can and can't do, auth (API key now, OAuth for many merchants), rate limits, known limits
- [ ] Small automated eval: natural-language tasks, checking the agent picks the right tool with the right arguments
- [ ] Demo script, including the prompt-injection ticket

## Known limitations so far

- Rate-limit state lives in one process. Multiple instances would not share it.
- API key auth acts as one agent with that agent's full permissions. Fine for a single merchant with a restricted service agent; a multi-merchant platform needs OAuth with scoped, revocable grants.
- Tested against a Freshdesk trial (50 calls/min). Paid plans have higher and per-endpoint limits.