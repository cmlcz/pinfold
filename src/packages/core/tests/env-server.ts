// A Downstream Server for tests whose Read Tool whoami returns the server's
// working directory and its environment variables TOKEN and PLAIN.
// `node env-server.ts`.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const server = new McpServer({ name: "env", version: "0.0.0" });
server.registerTool(
  "whoami",
  { description: "Describes the server's process", inputSchema: z.object({}) },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          cwd: process.cwd(),
          token: process.env.TOKEN ?? null,
          plain: process.env.PLAIN ?? null,
        }),
      },
    ],
  })
);
await server.connect(new StdioServerTransport());
