import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
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
  type ExploreResult,
  type ExposedWorkflow,
  type WorkflowRunResult,
} from "../core/index.ts";

/**
 * The MCP server the agent connects to. It holds no logic of its own; `root`
 * is the project directory that holds `.workflows/`, and `workflows` are the
 * saved Workflows that appear as their own tools. `skipped` says why any of
 * them could not.
 */
export function createGateway(
  core: Core,
  options: { root: string; workflows?: ExposedWorkflow[] }
): { server: McpServer; skipped: string[] } {
  // The plan an Approval dialog shows comes back from the client with the
  // answer, sealed so that no client can swap in another plan. One process
  // serves every round of a call, so a key of its own does. A developer may
  // read a plan for a while, so the seal and a round last an hour.
  const sealed = createRequestStateCodec<string>({
    key: randomBytes(32),
    ttlSeconds: 3600,
  });
  const server = new McpServer(
    { name: "pinfold", version: "0.0.0" },
    { inputRequired: { roundTimeoutMs: 3_600_000 } }
  );

  // Whether the client can show a form dialog: an elicitation capability
  // that names no mode means form (2025-11-25). The per-request envelope
  // the SDK suggests instead of this deprecated accessor is untyped, and
  // the accessor is filled per request on either protocol era.
  function canAsk(): boolean {
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    if (elicitation === undefined) return false;
    return elicitation.form !== undefined || elicitation.url === undefined;
  }

  // The plan the dialog showed, or undefined if its seal does not hold, say
  // because it expired: the answer then counts for nothing.
  async function shownPlan(ctx: ServerContext): Promise<string | undefined> {
    const state = ctx.mcpReq.requestState<string>();
    if (state === undefined) return undefined;
    return sealed.verify(state, ctx).catch(() => undefined);
  }

  // A run paused for Approval asks the developer in a dialog of the client
  // when it can show one, and otherwise points to `pinfold approve`.
  // Approving runs the same request again, which sends the plan only if it
  // rebuilds the same one; if it builds another, the dialog asks again.
  async function withApproval<R extends ExploreResult | WorkflowRunResult>(
    ctx: ServerContext,
    run: () => Promise<R>,
    format: (result: Extract<R, { ok: true }>) => string
  ) {
    const answer = inputResponse(ctx.mcpReq.inputResponses, "approval");
    if (answer.kind !== "elicit") return settle(await run());
    const shown = await shownPlan(ctx);
    if (shown === undefined) return settle(await run(), { ask: false });
    const answered = await core.answerApproval(shown, answers[answer.action]);
    if (!answered.ok) return failure(answered.error);
    if (!answered.approved) return reply(answered.text);
    return settle(await run(), { approved: shown });

    // `approved` is the plan just approved in a dialog, never asked again.
    async function settle(
      result: R,
      { ask = canAsk(), approved }: { ask?: boolean; approved?: string } = {}
    ) {
      if (!result.ok) return failure(result.error);
      const ran = result as Extract<R, { ok: true }>;
      const paused = ran.status === "pending" || ran.status === "changed";
      if (!paused || !ask || ran.plan.id === approved) {
        return reply(format(ran));
      }
      return inputRequired({
        inputRequests: {
          approval: inputRequired.elicit({
            message: await core.approvalRequest(ran),
            requestedSchema: { type: "object", properties: {} },
          }),
        },
        requestState: await sealed.mint(ran.plan.id),
      });
    }
  }

  server.registerTool(
    "run_sandbox",
    {
      description: [
        "Run a TypeScript program in an isolated sandbox and get back only its return value.",
        "The program must `export async function main(input)`; `input` is passed through.",
        "Call a Downstream Server's Tool with `await sdk.<server>.<tool>(args)`; find signatures with search_sdk.",
        "The program is type-checked against the SDK before it runs.",
        "Each run is a Plan: Read Tools run live, but calls to Write Tools are only recorded into a Write Plan and return a Placeholder. Pass a Placeholder to other Write Tools or return it; reading, comparing, formatting or calling it fails the run. Code that branches on a Placeholder, compares it or takes its typeof fails the type check, since its value is known only after Apply. Nothing is sent until the developer approves the Write Plan: in a dialog of the client when it can show one, after which the plan is applied and real values return; otherwise the result lists the plan for the developer to approve in a terminal, and running the same code again applies it.",
        "The sandbox has no filesystem, network, environment, timers or imports, and each run has time, memory and Tool-call limits. Within a run, Date stands still and Math.random is seeded.",
        "main's return value must be JSON-serializable.",
      ].join("\n"),
      inputSchema: z.object({
        code: z.string().describe("TypeScript source that exports main(input)"),
        input: z.unknown().optional().describe("The argument passed to main"),
      }),
    },
    ({ code, input }, ctx) =>
      withApproval(ctx, () => core.explore({ code, input }), formatOutcome)
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
        "The run is a Plan, then an Apply. Its writes are sent unattended unless Approval is required: the developer has not approved writes of the Workflow's code as it is now, a Response Adapter it reads through changed, or its Write Plan exceeds its Write Budget. Then the run pauses and nothing is sent until the developer approves the Write Plan, in a dialog of the client when it can show one, or else in a terminal.",
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
    ({ name, input }, ctx) =>
      withApproval(
        ctx,
        () => core.runWorkflow({ name, input: input ?? {} }),
        formatWorkflowRun
      )
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

  const skipped: string[] = [];
  for (const { name, description, input } of options.workflows ?? []) {
    try {
      server.registerTool(
        name,
        {
          description,
          inputSchema: fromJsonSchema<Record<string, unknown>>(input),
        },
        (args, ctx) =>
          withApproval(
            ctx,
            () => core.runWorkflow({ name, input: args }),
            formatWorkflowRun
          )
      );
    } catch (error) {
      // Such as a name one of the tools above has.
      skipped.push(
        `Workflow ${name} not exposed as an MCP tool: ${(error as Error).message}.`
      );
    }
  }

  return { server, skipped };
}

const answers = {
  accept: "approve",
  decline: "decline",
  cancel: "dismiss",
} as const;

// A tool's result: its text, or its text as an error.
function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
  return { ...reply(text), isError: true };
}
