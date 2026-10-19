import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  formatOutcome,
  formatWorkflows,
  listWorkflows,
  type Core,
} from "../core/index.ts";

/**
 * The MCP server the agent connects to. It holds no logic of its own; `root`
 * is the project directory that holds `.workflows/`.
 */
export function createGateway(
  core: Core,
  options: { root: string }
): McpServer {
  const server = new McpServer({ name: "pinfold", version: "0.0.0" });

  server.registerTool(
    "run_sandbox",
    {
      description: [
        "Run a TypeScript program in an isolated sandbox and get back only its return value.",
        "The program must `export async function main(input)`; `input` is passed through.",
        "Call a Downstream Server's Tool with `await sdk.<server>.<tool>(args)`; find signatures with search_sdk.",
        "The program is type-checked against the SDK before it runs.",
        "Each run is a Plan: Read Tools run live, but calls to Write Tools are only recorded into a Write Plan and return a Placeholder. Pass a Placeholder to other Write Tools or return it; reading, comparing, formatting or calling it fails the run. A Placeholder is always truthy, so never branch on one. The result lists the Write Plan and nothing is sent until the developer approves it in a terminal; then running the same code again applies it and returns real values.",
        "The sandbox has no filesystem, network, environment, timers or imports, and each run has time, memory and Tool-call limits. Within a run, Date stands still and Math.random is seeded.",
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
                text: formatOutcome(result),
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

  server.registerTool(
    "save_workflow",
    {
      description: [
        "Save a successful Exploration Run of run_sandbox as a Workflow: an ordinary TypeScript file in .workflows/ that the developer owns and that runs again without an LLM.",
        "Show the developer the run's result first, and save only once they confirm it is right.",
        "The code must export a typed main(input) and type-check against the SDK. If any check fails, nothing is saved and the failed check is named.",
      ].join("\n"),
      inputSchema: z.object({
        run: z
          .string()
          .describe("The Exploration Run, as run_sandbox's result names it"),
        name: z
          .string()
          .describe(
            "The Workflow's name: lower case letters, digits and _, such as triage_sentry"
          ),
        confirmed: z
          .boolean()
          .describe(
            "True only if the developer has seen the run's result and confirmed it"
          ),
      }),
    },
    async (request) => {
      const result = await core.saveWorkflow(request);
      return result.ok
        ? {
            content: [
              {
                type: "text",
                text: `Saved Workflow ${result.workflow.name} as .workflows/${result.workflow.name}.ts.\n\n${formatWorkflows([result.workflow])}`,
              },
            ],
          }
        : {
            content: [
              {
                type: "text",
                text: `${result.error}\nFailed check: ${result.check}`,
              },
            ],
            isError: true,
          };
    }
  );

  server.registerTool(
    "list_workflows",
    {
      description:
        "List the saved Workflows with their inputs, the Tools they call, their last run and their status.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: formatWorkflows(await listWorkflows(options.root)),
        },
      ],
    })
  );

  return server;
}
