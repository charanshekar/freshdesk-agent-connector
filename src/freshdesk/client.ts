import type { Config } from "../config.js";

const MAX_ATTEMPTS = 3; // first try + up to 2 retries; failed calls still count against the limit
const MAX_RETRY_WAIT_SECONDS = 30; // longer than this and we hand the wait back to the model
const DEFAULT_RETRY_AFTER_SECONDS = 10;
const MAX_JITTER_MS = 1000;
const LOW_REMAINING_THRESHOLD = 5;
const LOW_REMAINING_DELAY_MS = 1500; // ~40 calls/min, just under the 50/min trial limit
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL_CHARS = 300;

// Thrown for every failure. `message` is written for the model to read.
export class FreshdeskError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "FreshdeskError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface FreshdeskResponse<T> {
  data: T;
  headers: Headers;
}

export interface FreshdeskClient {
  request<T>(path: string, options?: RequestOptions): Promise<FreshdeskResponse<T>>;
  rateLimitRemaining(): number | null;
}

export function createFreshdeskClient(config: Config): FreshdeskClient {
  const authHeader = "Basic " + Buffer.from(`${config.apiKey}:X`).toString("base64");
  let lastRemaining: number | null = null;

  async function request<T>(path: string, options: RequestOptions = {}): Promise<FreshdeskResponse<T>> {
    const url = buildUrl(config.domain, path, options.query);

    for (let attempt = 1; ; attempt++) {
      if (lastRemaining !== null && lastRemaining <= LOW_REMAINING_THRESHOLD) {
        console.error(`Freshdesk rate limit low (${lastRemaining} left), pausing ${LOW_REMAINING_DELAY_MS}ms`);
        await sleep(LOW_REMAINING_DELAY_MS);
      }

      const res = await send(url, authHeader, options);
      lastRemaining = readRemaining(res.headers) ?? lastRemaining;

      if (res.status === 429) {
        const waitSeconds = readRetryAfter(res.headers);
        if (attempt >= MAX_ATTEMPTS || waitSeconds > MAX_RETRY_WAIT_SECONDS) {
          throw new FreshdeskError(
            `Freshdesk rate limit reached. Wait ${waitSeconds} seconds before calling any Freshdesk tool again.`,
            429
          );
        }
        const waitMs = waitSeconds * 1000 + Math.random() * MAX_JITTER_MS;
        console.error(`Freshdesk 429 on attempt ${attempt}, retrying in ${Math.round(waitMs)}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw await toFreshdeskError(res, path);
      }
      return { data: await parseBody<T>(res), headers: res.headers };
    }
  }

  return { request, rateLimitRemaining: () => lastRemaining };
}

function buildUrl(domain: string, path: string, query: RequestOptions["query"] = {}): URL {
  const url = new URL(`https://${domain}/api/v2${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

// Network failures and timeouts are not retried: for a POST we can't tell
// whether Freshdesk already applied the write.
async function send(url: URL, authHeader: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "the request timed out" : "the network request failed";
    throw new FreshdeskError(
      `Could not reach Freshdesk at ${url.hostname}: ${reason}. Try once more; if it fails again, tell the user Freshdesk is unreachable.`,
      null
    );
  }
}

function readRemaining(headers: Headers): number | null {
  const value = Number(headers.get("x-ratelimit-remaining"));
  return headers.has("x-ratelimit-remaining") && Number.isFinite(value) ? value : null;
}

function readRetryAfter(headers: Headers): number {
  const value = Number(headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETRY_AFTER_SECONDS;
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new FreshdeskError("Freshdesk returned a response that was not valid JSON. Try once more.", res.status);
  }
}

// Turns an HTTP error into one or two sentences that tell the model what went
// wrong and whether retrying (or changing the input) can help.
async function toFreshdeskError(res: Response, path: string): Promise<FreshdeskError> {
  const detail = await readErrorDetail(res);
  const status = res.status;

  switch (true) {
    case status === 400:
      return new FreshdeskError(`Freshdesk rejected the request as invalid: ${detail || "no details given"}. Fix the arguments and retry.`, status);
    case status === 401:
      return new FreshdeskError(
        "Freshdesk rejected the API key (401). This is a configuration problem the user must fix; retrying will not help.",
        status
      );
    case status === 403:
      return new FreshdeskError(
        "The Freshdesk agent behind this API key is not allowed to do this (403), or the account's plan does not include it. Retrying will not help.",
        status
      );
    case status === 404:
      return new FreshdeskError(`Nothing found at ${path} (404). Check that the ID is correct.`, status);
    case status >= 500:
      return new FreshdeskError(
        `Freshdesk had a server error (${status}). Try once more; if it fails again, tell the user Freshdesk is having problems.`,
        status
      );
    default:
      return new FreshdeskError(`Freshdesk returned HTTP ${status}${detail ? `: ${detail}` : ""}.`, status);
  }
}

// Freshdesk error bodies look like { description, errors: [{ field, message }] }.
// We keep only the field names and messages, capped in length.
async function readErrorDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
    const body = JSON.parse(text) as { description?: string; errors?: { field?: string; message?: string }[] };
    const fieldErrors = (body.errors ?? []).map((e) => (e.field ? `${e.field}: ${e.message}` : e.message ?? ""));
    text = fieldErrors.length > 0 ? fieldErrors.join("; ") : body.description ?? "";
  } catch {
    // Not JSON (e.g. an HTML error page). Fall back to nothing rather than dumping HTML at the model.
    text = "";
  }
  return text.slice(0, MAX_ERROR_DETAIL_CHARS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
