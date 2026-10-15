import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FreshdeskError } from "../freshdesk/client.js";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

// Freshdesk errors already carry a model-readable message. Anything else is a
// bug in the connector: log the details to stderr, give the model a short message.
export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof FreshdeskError
      ? err.message
      : "The connector hit an unexpected internal error. Tell the user; retrying is unlikely to help.";
  if (!(err instanceof FreshdeskError)) console.error("Unexpected tool error:", err);
  return { isError: true, content: [{ type: "text", text: message }] };
}
