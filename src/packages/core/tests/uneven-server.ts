// A Downstream Server for tests whose Read Tool declares no output schema and
// whose responses differ in shape: get({ n }) returns an issue that has an
// assignee only when n is above 1. Get, a Tool named like it but for case,
// returns something else. `node uneven-server.ts`.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const server = new McpServer({ name: "uneven", version: "0.0.0" });
server.registerTool(
  "get",
  {
    description: "Gets an issue",
    inputSchema: z.object({ n: z.number() }),
    annotations: { readOnlyHint: true },
  },
  async ({ n }) => {
    const issue =
      n > 1 ? { id: n, title: "t", assignee: "ana" } : { id: n, title: "t" };
    return { content: [{ type: "text", text: JSON.stringify(issue) }] };
  }
);
server.registerTool(
  "Get",
  {
    description: "Gets a project",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ project: "web" }) }],
  })
);
await server.connect(new StdioServerTransport());
