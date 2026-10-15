import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FreshdeskError } from "../freshdesk/client.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Wraps a tool handler so no exception ever escapes to the MCP layer.
// FreshdeskError messages are already written for the model. Anything else is
// a connector bug: the real error goes to stderr, the model gets a short message.
export function safe<A extends unknown[]>(
  handler: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof FreshdeskError) return fail(err.message);
      console.error("Unexpected tool error:", err);
      return fail("The connector hit an unexpected internal error and nothing was changed in Freshdesk. Tell the user; retrying is unlikely to help.");
    }
  };
}
