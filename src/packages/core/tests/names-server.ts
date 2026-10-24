// A Downstream Server for tests whose Read Tool has a name no file system
// takes as it is: 100 CJK characters, 900 bytes once URL-encoded.
// `node names-server.ts`.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const longName = "問".repeat(100);

// The server warns about a name outside the spec's characters on stderr.
console.warn = () => {};

const server = new McpServer({ name: "names", version: "0.0.0" });
server.registerTool(
  longName,
  { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) },
  async () => ({ content: [], structuredContent: { ok: true } })
);
await server.connect(new StdioServerTransport());
