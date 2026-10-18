import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { formatOutcome, type Core } from "../core/index.ts";

/** The MCP server the agent connects to. It holds no logic of its own. */
export function createGateway(core: Core): McpServer {
  const server = new McpServer({ name: "pinfold", version: "0.0.0" });

  server.registerTool(
    "run_sandbox",
    {
      description: [
        "Run a TypeScript program in an isolated sandbox and get back only its return value.",
        "The program must `export async function main(input)`; `input` is passed through.",
        "Call a Downstream Server's Tool with `await sdk.<server>.<tool>(args)`; find signatures with search_sdk.",
        "The program is type-checked against the SDK before it runs.",
        "Each run is a Plan: Read Tools run live, but calls to Write Tools are only recorded into a Write Plan and return a Placeholder. Pass a Placeholder to other Write Tools or return it; reading, comparing, formatting or calling it fails the run. A Placeholder is always truthy, so never branch on one. The result lists the Write Plan; nothing is sent.",
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
                text: formatOutcome(result.value, result.plan),
              },
            ],
          }
        : { content: [{ type: "text", text: result.error }], isError: true };
    }
  );

  server.registerTool(
    "search_sdk",
    {
      description:
        "Search the sdk available to run_sandbox programs by keywords. Returns the TypeScript signatures of the matching Tools only.",
      inputSchema: z.object({
        query: z.string().describe("Keywords describing the task"),
      }),
    },
    async ({ query }) => {
      const signatures = core.searchSdk(query);
      const text =
        signatures.length > 0
          ? signatures.join("\n\n")
          : `No Tools match ${JSON.stringify(query)}.`;
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}
