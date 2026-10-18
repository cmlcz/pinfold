import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Core } from "../core/index.ts";

/** The MCP server the agent connects to. It holds no logic of its own. */
export function createGateway(core: Core): McpServer {
  const server = new McpServer({ name: "pinfold", version: "0.0.0" });

  server.registerTool(
    "run_sandbox",
    {
      description: [
        "Run a TypeScript program in an isolated sandbox and get back only its return value.",
        "The program must `export async function main(input)`; `input` is passed through.",
        "Call a Downstream Server's Tool with `await sdk.<server>.<tool>(args)`.",
        "The sandbox has no filesystem, network, environment, timers or imports, and each run has time, memory and Tool-call limits.",
        "main's return value must be JSON-serializable.",
      ].join("\n"),
      inputSchema: z.object({
        code: z.string().describe("TypeScript source that exports main(input)"),
        input: z.unknown().optional().describe("The argument passed to main"),
      }),
    },
    async ({ code, input }) => {
      const result = await core.explore({ code, input });
      return result.ok
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.value) ?? "undefined",
              },
            ],
          }
        : { content: [{ type: "text", text: result.error }], isError: true };
    }
  );

  return server;
}
