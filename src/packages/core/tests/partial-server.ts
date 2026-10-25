// A Downstream Server for tests whose Write Tool makes its change, then
// answers in a shape its own output schema does not allow, so the reference
// MCP server SDK turns the answer into an error result:
// `node partial-server.ts <file>`. Each call to create({ title }) appends the
// title to <file>.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const file = process.argv[2]!;
const server = new McpServer({ name: "partial", version: "0.0.0" });
server.registerTool(
  "create",
  {
    description: "Creates a record",
    inputSchema: z.object({ title: z.string() }),
    outputSchema: z.object({ id: z.string() }),
  },
  async ({ title }) => {
    appendFileSync(file, `${title}\n`);
    // A numeric id, where the output schema says text.
    const output = { id: 7 } as unknown as { id: string };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
);
await server.connect(new StdioServerTransport());
