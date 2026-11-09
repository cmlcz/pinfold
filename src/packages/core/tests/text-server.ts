// A Downstream Server for tests whose Read Tool answers in plain text, as
// servers that format their answers for people do: `node text-server.ts`.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const server = new McpServer({ name: "text", version: "0.0.0" });
server.registerTool(
  "report",
  { description: "Reports in prose", inputSchema: z.object({}) },
  async () => ({
    content: [{ type: "text", text: "2 unresolved issues in web" }],
  })
);
await server.connect(new StdioServerTransport());
