import { randomInt, randomUUID } from "node:crypto";
import {
  Placeholder,
  PlaceholderError,
  quickJsSandbox,
  type Clock,
  type Sdk,
  type SandboxResult,
} from "../sandbox/index.ts";
import { loadAdapters, type Adapters } from "./lib/adapters.ts";
import { openBaselines } from "./lib/baselines.ts";
import {
  resolveLimits,
  type PinfoldConfig,
  type ToolKind,
} from "./lib/config.ts";
import { connectDownstream, type DownstreamTool } from "./lib/downstream.ts";
import {
  describeMismatch,
  mismatches,
  touchesContract,
  type Mismatch,
} from "./lib/drift.ts";
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
  inputFromCommandLine,
  loadWorkflow,
  recordRun,
  runHistory,
  savedContracts,
  saveWorkflow,
  type CommandLineInput,
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
  listWorkflows,
  type SaveCheck,
  type CommandLineInput,
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
  runWorkflow(
    request: { name: string } & (
      | { input: unknown }
      /** Read against main's input type as the code is now. */
      | { commandLine: CommandLineInput }
    )
  ): Promise<WorkflowRunResult>;
  close(): Promise<void>;
};

/** Opens a core on a project; `root` is the directory that holds `.workflows/`. */
export async function openCore(
  config: PinfoldConfig,
  options: { root: string }
): Promise<Core> {
  const baselines = await openBaselines(options.root);
  const downstream = await connectDownstream(config.servers, options.root);
  const classificationOf = (tool: DownstreamTool) => {
    const servers = config.classification ?? {};
    const tools = Object.hasOwn(servers, tool.server)
      ? servers[tool.server]!
      : {};
    return Object.hasOwn(tools, tool.tool) ? tools[tool.tool] : undefined;
  };
  const isRead = (tool: DownstreamTool) => classificationOf(tool) === "read";

  // During a Plan, Read Tools run live, their responses mapped by their
  // Response Adapters, and Write Tool calls are recorded. Read Tool calls
  // are kept with their adapted responses, as Fixtures. `check` sees each
  // adapted response first, and may stop the call.
  function planSdk(
    writes: PlannedWrite[],
    calls: RecordedCall[],
    adapters: Adapters,
    check?: (tool: DownstreamTool, response: unknown) => void
  ): Sdk {
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
            const value = adapters.adapt(name, await tool.call(args));
            check?.(tool, value);
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
    // Every write's Tool is found first: a Tool no longer offered stops the
    // Apply before it takes a write, so a resume can send it later.
    for (const write of record.writes) {
      if (!toolsByName.has(write.tool)) {
        throw new Error(
          `${write.tool} is not offered, so nothing was sent. Once it is offered again, \`pinfold resume ${record.record}\` sends the writes not sent.`
        );
      }
    }
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
  // was approved. Given a Contract, the run stops at the first response
  // whose Drift touches it, and fails even if the program catches that.
  async function planRun(
    code: string,
    input: unknown,
    contract?: Record<string, string[]>
  ) {
    const key = runKey(code, input);
    const approved = await plans.approvedFor(key);
    const clock = approved?.clock ?? {
      now: Date.now(),
      seed: randomInt(2 ** 32),
    };
    const writes: PlannedWrite[] = [];
    const calls: RecordedCall[] = [];
    const drift: Drift[] = [];
    const check = (tool: DownstreamTool, response: unknown) => {
      const name = `${tool.server}.${tool.tool}`;
      const reads =
        contract && Object.hasOwn(contract, name) ? contract[name]! : [];
      const baseline = baselines.get(tool.server, tool.tool);
      if (reads.length === 0 || baseline === undefined) return;
      const found = mismatches(baseline.outputSchema, response);
      if (!touchesContract(found, reads)) return;
      drift.push({ tool: name, mismatches: found });
      throw new Error(`${name} drifted from its Baseline`);
    };
    const loaded = await loadAdapters(options.root).catch(
      (error: unknown) => error as Error
    );
    const result: SandboxResult =
      loaded instanceof Error
        ? { ok: false, error: loaded.message }
        : await quickJsSandbox.run({
            source: code,
            declarations: declarations(sdkTools()),
            input,
            sdk: planSdk(writes, calls, loaded, check),
            limits,
            clock,
          });
    const adapters = loaded instanceof Error ? undefined : loaded;
    return {
      key,
      approved,
      clock,
      writes,
      calls,
      result,
      adapters,
      drift: drift[0],
    };
  }

  // What a run stopped by Drift reports: the Tool, its fields and every
  // Workflow the Drift affects.
  async function driftReport(workflow: string, drift: Drift): Promise<string> {
    const affected = (await savedContracts(options.root))
      .filter(({ contract }) =>
        touchesContract(
          drift.mismatches,
          Object.hasOwn(contract, drift.tool) ? contract[drift.tool]! : []
        )
      )
      .map(({ name }) => name);
    return [
      `Workflow ${workflow} not run: the responses of ${drift.tool} drifted from its Baseline, so the run stopped before it made a Write Plan; nothing was sent.`,
      ...drift.mismatches.map((mismatch) => `  ${describeMismatch(mismatch)}`),
      `Affected Workflows: ${affected.join(", ")}.`,
      `A Response Adapter for ${drift.tool} in .workflows/adapters/ that maps its responses back to the Baseline repairs every affected Workflow.`,
    ].join("\n");
  }

  // A Workflow Run: the Workflow's checks, then a Plan that needs Approval if
  // the Workflow was never applied or its Write Plan exceeds its Write
  // Budget, and otherwise is applied unattended.
  async function runWorkflow(
    name: string,
    given: { input: unknown } | { commandLine: CommandLineInput },
    /**
     * Receives which save of the Workflow ran and the Response Adapters its
     * Tools went through, for the run history.
     */
    ran: { saved?: string; adapters?: Record<string, string> }
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
    ran.saved = workflow.saved;
    const input =
      "commandLine" in given
        ? inputFromCommandLine(workflow.input, given.commandLine)
        : given.input;
    const checked = checkInput(workflow.input, input);
    if (!checked.ok)
      return { ok: false, error: `Workflow ${name} not run. ${checked.error}` };

    const { key, approved, clock, writes, result, adapters, drift } =
      await planRun(workflow.source, input, workflow.contract);
    if (drift !== undefined) {
      return { ok: false, error: await driftReport(name, drift) };
    }
    if (!result.ok) return result;
    const digests = Object.fromEntries(
      workflow.tools.flatMap((tool) => {
        const adapter = adapters!.get(tool);
        return adapter === undefined ? [] : [[tool, adapter.digest]];
      })
    );
    ran.adapters = digests;
    const plan = writePlan(writes);
    const history = await runHistory(options.root);
    // Applied before means this very save: a Workflow saved again under the
    // name of a deleted one is approved afresh.
    const lastApplied = history.findLast(
      (entry) =>
        entry.workflow === name &&
        entry.saved === workflow.saved &&
        entry.status === "applied"
    );
    // An Adapter added, changed or removed since then.
    const changedAdapters = workflow.tools.filter(
      (tool) => lastApplied?.adapters?.[tool] !== digests[tool]
    );
    let approvalReason: string | undefined;
    if (lastApplied === undefined) {
      approvalReason = `Workflow ${name} has never been applied`;
    } else if (changedAdapters.length > 0) {
      approvalReason = `the Response Adapter of ${changedAdapters.join(", ")} changed since Workflow ${name} was last applied`;
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
    async runWorkflow({ name, ...given }) {
      const ran: { saved?: string; adapters?: Record<string, string> } = {};
      const result = await runWorkflow(name, given, ran);
      await recordRun(options.root, {
        workflow: name,
        ...ran,
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

/** Drift that stopped a Workflow Run: the Tool, and where it drifted. */
type Drift = { tool: string; mismatches: Mismatch[] };

// The same code and input give the same run key, whatever the order of the
// input's fields.
function runKey(code: string, input: unknown): string {
  return shortHash(JSON.stringify([code, canonicalize(input)]));
}

function busy(plan: WritePlan, record: PlanRecord): Failed {
  return {
    ok: false,
    error: `Write Plan ${plan.id} is being applied by another run, or a run applying it stopped; nothing was sent. If no run is applying it, \`pinfold resume ${record.record}\` sends the writes not sent, or \`pinfold decline ${plan.id}\` gives it up.`,
  };
}
