import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  formatOutcome,
  formatProposal,
  formatRepairTasks,
  formatWorkflowRun,
  formatWorkflows,
  listWorkflows,
  opsGuide,
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
      if (!result.ok) {
        return failure(result.error);
      }
      return reply(formatOutcome(result));
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
      return reply(text);
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
      if (!result.ok) {
        return failure(`${result.error}\nFailed check: ${result.check}`);
      }
      const { workflow } = result;
      return reply(
        `Saved Workflow ${workflow.name} as .workflows/${workflow.name}.ts.\n\n${formatWorkflows([workflow])}`
      );
    }
  );

  server.registerTool(
    "run_workflow",
    {
      description: [
        "Run a saved Workflow with an input, without writing code: list_workflows shows each one's inputs.",
        "The run is a Plan, then an Apply. Its writes are sent unattended unless Approval is required: the developer has not approved writes of the Workflow's code as it is now, a Response Adapter it reads through changed, or its Write Plan exceeds its Write Budget. Then the run pauses, nothing is sent, and the result shows the Write Plan for the developer to approve in a terminal.",
        "The Workflow is checked before it runs, since the developer may have edited it; a run refused by a check says why.",
      ].join("\n"),
      inputSchema: z.object({
        name: z.string().describe("The Workflow's name"),
        input: z
          .unknown()
          .optional()
          .describe(
            "The argument passed to the Workflow's main; an empty object when left out"
          ),
      }),
    },
    async ({ name, input }) => {
      const result = await core.runWorkflow({ name, input: input ?? {} });
      if (!result.ok) {
        return failure(result.error);
      }
      return reply(formatWorkflowRun(result));
    }
  );

  server.registerTool(
    "list_workflows",
    {
      description:
        "List the saved Workflows with their inputs, the Tools they call, their last run and their status.",
      inputSchema: z.object({}),
    },
    async () => {
      const pending = await core.pendingDrift();
      const text = [formatWorkflows(await listWorkflows(options.root))];
      if (pending.length > 0) {
        text.push(
          [
            "Pending Drift, which stops the runs of the Workflows it affects; propose_repair shows it and can repair it:",
            ...pending.map(
              ({ tool, workflow }) => `  ${tool}, found by ${workflow}`
            ),
          ].join("\n")
        );
      }
      return reply(text.join("\n\n"));
    }
  );

  server.registerTool(
    "propose_repair",
    {
      description: [
        "Repair Drift that pinfold could not repair by itself: a Downstream Server changed a Tool's responses, and the Workflows that read the changed fields stop before they make a Write Plan.",
        "Call it with no ops to see each Tool's pending Drift: the fields that no longer fit, the Baseline shape Workflows expect, a live response and the field values in the Fixtures.",
        "Then call it with the Tool and the ops to add after its Response Adapter's ops, which map a live response back to the Baseline. Workflow code is never changed.",
        ...opsGuide,
        "pinfold checks the ops as it checks its own Repairs: through them, the live responses must fit the Baseline wherever a saved Workflow reads them. Ops that do not are rejected with the reason.",
        "Ops that pass become the Tool's next Adapter version, which the developer must approve in a terminal on the next run of each affected Workflow; you cannot approve it.",
      ].join("\n"),
      inputSchema: z.object({
        tool: z
          .string()
          .optional()
          .describe("The drifted Tool, as server.tool; needed with ops"),
        ops: z
          .array(z.unknown())
          .optional()
          .describe(
            "The ops to add to the Tool's Response Adapter; leave out to see the pending Drift"
          ),
      }),
    },
    async ({ tool, ops }) => {
      if (ops === undefined) {
        const tasks = await core.repairTasks();
        const shown =
          tool === undefined
            ? tasks
            : tasks.filter((task) => task.tool === tool);
        return reply(formatRepairTasks(shown));
      }
      if (tool === undefined) {
        return failure("Name the Tool the ops repair, as server.tool.");
      }
      const result = await core.proposeRepair({ tool, ops });
      if (!result.ok) {
        return failure(result.error);
      }
      return reply(formatProposal(result));
    }
  );

  return server;
}

// A tool's result: its text, or its text as an error.
function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
  return { ...reply(text), isError: true };
}
