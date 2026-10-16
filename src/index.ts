import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createFreshdeskClient } from "./freshdesk/client.js";
import { registerAddPrivateNote } from "./tools/addPrivateNote.js";
import { registerGetContact } from "./tools/getContact.js";
import { registerGetTicket } from "./tools/getTicket.js";
import { registerListTickets } from "./tools/listTickets.js";
import { registerSearchTickets } from "./tools/searchTickets.js";
import { registerWhoami } from "./tools/whoami.js";

async function main() {
  const config = loadConfig();
  const client = createFreshdeskClient(config);

  const server = new McpServer({ name: "freshdesk-connector", version: "0.1.0" });
  registerWhoami(server, client);
  registerListTickets(server, client);
  registerGetTicket(server, client);
  registerSearchTickets(server, client);
  registerGetContact(server, client);
  registerAddPrivateNote(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`freshdesk-connector running on stdio for ${config.domain}`);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`Configuration error:\n${err.message}`);
  } else {
    console.error("Fatal:", err);
  }
  process.exit(1);
});
