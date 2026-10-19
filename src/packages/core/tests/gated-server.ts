// A Downstream Server for tests that need to act while an Apply is sending a
// write: `node gated-server.ts <dir>`. Its Write Tool send({ n }) notes
// `started-<n>` in <dir>, holds the write until a file `release-<n>` appears
// there, then notes `sent-<n>`.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const dir = process.argv[2]!;
const server = new McpServer({ name: "gated", version: "0.0.0" });
server.registerTool(
  "send",
  {
    description: "A write held until released",
    inputSchema: z.object({ n: z.number() }),
  },
  async ({ n }) => {
    writeFileSync(join(dir, `started-${n}`), "");
    while (!existsSync(join(dir, `release-${n}`))) await sleep(10);
    writeFileSync(join(dir, `sent-${n}`), "");
    return { content: [{ type: "text", text: JSON.stringify({ n }) }] };
  }
);
await server.connect(new StdioServerTransport());
