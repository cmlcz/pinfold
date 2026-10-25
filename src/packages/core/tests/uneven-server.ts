// A Downstream Server for tests whose Read Tool declares no output schema and
// whose responses differ in shape: get({ n }) returns an issue that has an
// assignee only when n is above 1, and a null one when n is 0. list({ from,
// to }) returns the issues from n = from to to. Get, a Tool named like get
// but for case, returns something else, and users returns a map keyed by
// email address. `node uneven-server.ts`.
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
  async ({ n }) => ({
    content: [{ type: "text", text: JSON.stringify(issue(n)) }],
  })
);
server.registerTool(
  "list",
  {
    description: "Lists issues",
    inputSchema: z.object({ from: z.number(), to: z.number() }),
    annotations: { readOnlyHint: true },
  },
  async ({ from, to }) => {
    const issues = [];
    for (let n = from; n <= to; n++) issues.push(issue(n));
    return { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
  }
);

function issue(n: number) {
  if (n > 1) return { id: n, title: "t", assignee: "ana" };
  return n === 1
    ? { id: n, title: "t" }
    : { id: n, title: "t", assignee: null };
}
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
server.registerTool(
  "users",
  {
    description: "Lists users by email address",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          byEmail: { "alice@corp.com": { name: "Alice" } },
          headers: { "content-type": "json" },
        }),
      },
    ],
  })
);
await server.connect(new StdioServerTransport());
