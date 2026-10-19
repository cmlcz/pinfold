import { randomInt, randomUUID } from "node:crypto";
import {
  Placeholder,
  PlaceholderError,
  quickJsSandbox,
  type Clock,
  type Sdk,
} from "../sandbox/index.ts";
import { openBaselines } from "./lib/baselines.ts";
import {
  resolveLimits,
  type PinfoldConfig,
  type ToolKind,
} from "./lib/config.ts";
import { connectDownstream, type DownstreamTool } from "./lib/downstream.ts";
import {
  canonicalize,
  containsPlaceholder,
  shortHash,
  writePlan,
  type PlannedWrite,
  type WritePlan,
} from "./lib/plan.ts";
import { declarations, searchTools, type SdkTool } from "./lib/sdk.ts";
import { ApplyStopped, resolvePlaceholders, sendWrites } from "./lib/apply.ts";
import { openJournal } from "./lib/journal.ts";
import { openPlanStore, type PlanRecord } from "./lib/plans.ts";
import {
  writeCount,
  type ExploreResult,
  type Failed,
  type PlanOutcome,
  type ResumeResult,
  type WorkflowRunResult,
} from "./lib/outcome.ts";
import {
  checkInput,
  loadWorkflow,
  recordRun,
  runHistory,
  saveWorkflow,
  type Exploration,
  type RecordedCall,
  type SaveResult,
} from "./lib/workflows.ts";

export {
  classifyTools,
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
  type ToolKind,
} from "./lib/config.ts";
export type { PlannedWrite, WritePlan } from "./lib/plan.ts";
export {
  openPlans,
  type PlanRecord,
  type Plans,
  type PlanStatus,
} from "./lib/plans.ts";
export {
  formatOutcome,
  formatPlan,
  formatResume,
  formatWorkflowRun,
  type ExploreResult,
  type ResumeResult,
  type WorkflowRunResult,
} from "./lib/outcome.ts";
export {
  formatWorkflows,
  inputFromFlags,
  listWorkflows,
  type SaveCheck,
  type SaveResult,
  type WorkflowSummary,
} from "./lib/workflows.ts";
export type { Placeholder } from "../sandbox/index.ts";

const writeToolNote =
  "Write Tool: a run records this call in its Write Plan instead of sending it, and gets a Placeholder back.";

/** How a Tool is treated, and what its server's annotations suggest. */
export type ToolClassification = {
  server: string;
  tool: string;
  kind: ToolKind;
  suggestion: ToolKind;
  /** False for a Tool the developer has not classified yet. */
  classified: boolean;
};

export type Core = {
  /** Every Tool of every Downstream Server, with its classification. */
  toolClassifications(): ToolClassification[];
  /** The TypeScript signatures of the Tools that match a keyword query. */
  searchSdk(query: string): string[];
  /** Runs the agent's program as an Exploration Run, which is a Plan. */
  explore(request: { code: string; input?: unknown }): Promise<ExploreResult>;
  /** Sends the writes a stopped run's Apply did not send, and no others. */
  resume(run: string): Promise<ResumeResult>;
  /**
   * Saves a successful Exploration Run of this session as a Workflow, once
   * the developer has confirmed its result.
   */
  saveWorkflow(request: {
    run: string;
    name: string;
    confirmed: boolean;
  }): Promise<SaveResult>;
  /**
   * Runs a saved Workflow, with no LLM: a Plan, then an Apply that runs
   * unattended unless Approval is required. Each run is kept in the run
   * history.
   */
  runWorkflow(request: {
    name: string;
    input: unknown;
  }): Promise<WorkflowRunResult>;
  close(): Promise<void>;
};

/** Opens a core on a project; `root` is the directory that holds `.workflows/`. */
export async function openCore(
  config: PinfoldConfig,
  options: { root: string }
): Promise<Core> {
  const baselines = await openBaselines(options.root);
  const downstream = await connectDownstream(config.servers);
  const classificationOf = (tool: DownstreamTool) => {
    const servers = config.classification ?? {};
    const tools = Object.hasOwn(servers, tool.server)
      ? servers[tool.server]!
      : {};
    return Object.hasOwn(tools, tool.tool) ? tools[tool.tool] : undefined;
  };
  const isRead = (tool: DownstreamTool) => classificationOf(tool) === "read";

  // During a Plan, Read Tools run live and Write Tool calls are recorded.
  // Read Tool calls are kept with their responses, as Fixtures.
  function planSdk(writes: PlannedWrite[], calls: RecordedCall[]): Sdk {
    // No prototype, so a server named like an Object member is just a name.
    const sdk: Sdk = Object.create(null);
    for (const tool of downstream.tools) {
      const name = `${tool.server}.${tool.tool}`;
      if (!Object.hasOwn(sdk, tool.server))
        sdk[tool.server] = Object.create(null);
      sdk[tool.server]![tool.tool] = isRead(tool)
        ? async (args) => {
            if (containsPlaceholder(args)) {
              throw new PlaceholderError(
                `a Placeholder cannot be passed to the Read Tool ${name}`
              );
            }
            const value = await tool.call(args);
            calls.push({ tool: name, arguments: args, response: value });
            await baselines.record(tool, value);
            return value;
          }
        : async (args) => {
            writes.push({ tool: name, arguments: canonicalize(args) });
            return new Placeholder(writes.length);
          };
    }
    return sdk;
  }

  // A pinned Tool is described by its Baseline alone, never its live listing.
  // Write Tools say so, since a run only records their calls.
  const sdkTools = (): SdkTool[] =>
    downstream.tools.map((tool) => {
      const known = baselines.get(tool.server, tool.tool) ?? tool;
      if (isRead(tool)) return known;
      const parts = [known.description, writeToolNote].filter(Boolean);
      return { ...known, description: parts.join(" ") };
    });
  const plans = openPlanStore(options.root);
  const toolsByName = new Map(
    downstream.tools.map((tool) => [`${tool.server}.${tool.tool}`, tool])
  );
  function toolOf(write: PlannedWrite): DownstreamTool {
    const tool = toolsByName.get(write.tool);
    if (tool === undefined) throw new Error(`${write.tool} is not offered`);
    return tool;
  }

  const journal = openJournal(options.root);

  // Sends the writes of the run's Write Plan that the Apply Journal does not
  // hold yet. Returns the results of all its writes, and how many were sent
  // before.
  async function sendRest(
    record: PlanRecord
  ): Promise<{ results: unknown[]; before: number }> {
    const run = journal.run(record.record);
    const before = run.sent().length;
    let results: unknown[];
    try {
      results = await sendWrites(record.writes, run, (write, args) =>
        toolOf(write).call(args)
      );
    } catch (error) {
      // Any other error stopped this Apply before it took a write, so the
      // status is left to the Apply that holds it.
      if (error instanceof ApplyStopped) await plans.finish(record, "failed");
      throw error;
    }
    await plans.finish(record, "applied");
    return { results, before };
  }

  async function pinResults(
    writes: PlannedWrite[],
    results: unknown[],
    from: number
  ) {
    for (let index = from; index < writes.length; index++) {
      await baselines.record(toolOf(writes[index]!), results[index]);
    }
  }

  // The plan was rebuilt by this very run, so its reads are fresh.
  async function apply(
    record: PlanRecord,
    plan: WritePlan,
    value: unknown
  ): Promise<PlanOutcome | Failed> {
    if (!(await plans.claim(record))) return busy(plan, record);
    let results: unknown[];
    try {
      results = (await sendRest(record)).results;
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    try {
      await pinResults(plan.writes, results, 0);
      return {
        ok: true,
        status: "applied",
        value: resolvePlaceholders(value, results),
        plan,
      };
    } catch (error) {
      return {
        ok: false,
        error: `Applied Write Plan ${plan.id}: ${writeCount(plan)} sent. Its result could not be built: ${(error as Error).message}`,
      };
    }
  }

  // The latest successful Exploration Runs, which save_workflow can save.
  // Kept in memory only, so no unredacted response reaches the disk.
  const explorations = new Map<string, Exploration>();
  const maxExplorations = 20;
  function remember(exploration: Exploration) {
    explorations.set(exploration.run, exploration);
    for (const run of explorations.keys()) {
      if (explorations.size <= maxExplorations) break;
      explorations.delete(run);
    }
  }

  // What becomes of a run's Write Plan, given the plan approved for the same
  // code and input, if any. A new plan waits for Approval unless the run
  // needs none, in which case it is applied now.
  async function planOutcome(
    plan: WritePlan,
    value: unknown,
    run: {
      key: string;
      clock: Clock;
      approved: PlanRecord | undefined;
      needsApproval: boolean;
    }
  ): Promise<PlanOutcome | Failed> {
    if (plan.writes.length === 0)
      return { ok: true, status: "complete", value, plan };
    const record = await plans.latest(plan.id);
    switch (record?.status) {
      case "declined":
        return { ok: true, status: "declined", value, plan };
      case "approved":
        return apply(record, plan, value);
      case "applying":
        return busy(plan, record);
      case "failed":
        return {
          ok: false,
          error: `Write Plan ${plan.id} stopped after a failed write and is never sent again by a run; nothing was sent. \`pinfold resume ${record.record}\` sends the writes not sent.`,
        };
      case "pending":
        break;
      default: {
        // New, or applied before: the developer approves this run afresh.
        const status = run.needsApproval ? "pending" : "approved";
        const added = await plans.add(plan, run.key, run.clock, status);
        if (status === "approved") {
          if (added === undefined) {
            return {
              ok: false,
              error: `Another run added Write Plan ${plan.id} at the same time; nothing was sent.`,
            };
          }
          return apply(added, plan, value);
        }
      }
    }
    return run.approved === undefined
      ? { ok: true, status: "pending", value, plan }
      : { ok: true, status: "changed", value, plan, approved: run.approved };
  }

  // Runs code as a Plan. A run after Approval sees the clock the approved
  // run saw, so a plan built from the time or Math.random is rebuilt as it
  // was approved.
  async function planRun(code: string, input: unknown) {
    const key = runKey(code, input);
    const approved = await plans.approvedFor(key);
    const clock = approved?.clock ?? {
      now: Date.now(),
      seed: randomInt(2 ** 32),
    };
    const writes: PlannedWrite[] = [];
    const calls: RecordedCall[] = [];
    const result = await quickJsSandbox.run({
      source: code,
      declarations: declarations(sdkTools()),
      input,
      sdk: planSdk(writes, calls),
      limits,
      clock,
    });
    return { key, approved, clock, writes, calls, result };
  }

  // A Workflow Run: the Workflow's checks, then a Plan that needs Approval if
  // the Workflow was never applied or its Write Plan exceeds its Write
  // Budget, and otherwise is applied unattended.
  async function runWorkflow(
    name: string,
    input: unknown
  ): Promise<WorkflowRunResult> {
    const loaded = await loadWorkflow(options.root, name, {
      declarations: declarations(sdkTools()),
      tools: new Set(toolsByName.keys()),
      outputSchema: (tool) => {
        const offered = toolsByName.get(tool);
        return (
          offered && baselines.get(offered.server, offered.tool)?.outputSchema
        );
      },
    });
    if (!loaded.ok) return loaded;
    const { workflow } = loaded;
    const checked = checkInput(workflow.input, input);
    if (!checked.ok)
      return { ok: false, error: `Workflow ${name} not run. ${checked.error}` };

    const { key, approved, clock, writes, result } = await planRun(
      workflow.source,
      input
    );
    if (!result.ok) return result;
    const plan = writePlan(writes);
    const history = await runHistory(options.root);
    const appliedBefore = history.some(
      (entry) => entry.workflow === name && entry.status === "applied"
    );
    let approvalReason: string | undefined;
    if (!appliedBefore) {
      approvalReason = `Workflow ${name} has never been applied`;
    } else if (plan.writes.length > workflow.writeBudget) {
      approvalReason = `the Write Plan has ${writeCount(plan)}, over the Write Budget of ${workflow.writeBudget}`;
    }
    const outcome = await planOutcome(plan, result.value, {
      key,
      clock,
      approved,
      needsApproval: approvalReason !== undefined,
    });
    if (!outcome.ok) return outcome;
    const paused = outcome.status === "pending" || outcome.status === "changed";
    return paused && approvalReason !== undefined
      ? { ...outcome, workflow: name, approvalReason }
      : { ...outcome, workflow: name };
  }

  const limits = resolveLimits(config);
  return {
    toolClassifications: () =>
      downstream.tools.map((tool) => ({
        server: tool.server,
        tool: tool.tool,
        kind: isRead(tool) ? "read" : "write",
        suggestion: tool.readOnlyHint ? "read" : "write",
        classified: classificationOf(tool) !== undefined,
      })),
    searchSdk: (query) => searchTools(sdkTools(), query),
    async explore({ code, input = {} }) {
      const { key, approved, clock, writes, calls, result } = await planRun(
        code,
        input
      );
      if (!result.ok) return result;
      const plan = writePlan(writes);
      const outcome = await planOutcome(plan, result.value, {
        key,
        clock,
        approved,
        needsApproval: true,
      });
      if (!outcome.ok) return outcome;
      const run = randomUUID().slice(0, 8);
      remember({
        run,
        code,
        input,
        calls,
        tools: [...new Set([...calls, ...writes].map((call) => call.tool))],
        reads: result.reads,
      });
      return { ...outcome, exploration: run };
    },
    async runWorkflow({ name, input }) {
      const result = await runWorkflow(name, input);
      await recordRun(options.root, {
        workflow: name,
        at: new Date().toISOString(),
        status: result.ok ? result.status : "failed",
        ...(result.ok ? { plan: result.plan.id } : { error: result.error }),
      });
      return result;
    },
    async resume(run) {
      const record = await plans.get(run);
      if (record === undefined) throw new Error(`no run ${run}`);
      const plan = { id: record.id, writes: record.writes };
      switch (record.status) {
        case "applied":
          return { run, plan, sent: [] };
        // An Apply still running is safe to resume too: the journal lets
        // only one Apply take each write, and only after the one before it.
        case "failed":
        case "applying":
          break;
        default:
          throw new Error(
            `Write Plan ${plan.id} is ${record.status}; there is nothing to resume.`
          );
      }
      const { results, before } = await sendRest(record);
      await pinResults(plan.writes, results, before);
      const sent = [...results.keys()].slice(before).map((index) => index + 1);
      return { run, plan, sent };
    },
    saveWorkflow: ({ run, name, confirmed }) =>
      saveWorkflow(options.root, {
        name,
        run,
        exploration: explorations.get(run),
        confirmed,
        declarations: declarations(sdkTools()),
        redact: config.redact ?? {},
      }),
    async close() {
      journal.close();
      await downstream.close();
    },
  };
}

// The same code and input give the same run key.
function runKey(code: string, input: unknown): string {
  return shortHash(JSON.stringify([code, input]));
}

function busy(plan: WritePlan, record: PlanRecord): Failed {
  return {
    ok: false,
    error: `Write Plan ${plan.id} is being applied by another run, or a run applying it stopped; nothing was sent. If no run is applying it, \`pinfold resume ${record.record}\` sends the writes not sent, or \`pinfold decline ${plan.id}\` gives it up.`,
  };
}
