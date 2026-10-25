// A Workflow Run: the Workflow's checks, then a Plan that is applied
// unattended unless Approval is required. Drift that stops the Plan is
// repaired deterministically where it can be, and the run tried again.
import { planOutcome } from "./apply.ts";
import {
  shortHash,
  writePlan,
  type PlannedWrite,
  type WritePlan,
} from "./plan.ts";
import { planRun } from "./plan-run.ts";
import { writeCount, type WorkflowRunResult } from "./outcome.ts";
import type { Project } from "./project.ts";
import { driftReport, repairDrift } from "./repair-drift.ts";
import type { RepairRecord } from "./repair.ts";
import { declarations } from "./sdk.ts";
import {
  checkInput,
  inputFromCommandLine,
  loadWorkflow,
  recordRun,
  runHistory,
  type CommandLineInput,
  type LoadedWorkflow,
  type RunEntry,
} from "./workflows.ts";

export type WorkflowRunRequest = { name: string } & (
  | { input: unknown }
  /** Read against main's input type as the code is now. */
  | { commandLine: CommandLineInput }
);

/** Runs a saved Workflow and keeps the run in the run history. */
export async function runWorkflow(
  project: Project,
  { name, ...given }: WorkflowRunRequest
): Promise<WorkflowRunResult> {
  const ran: Ran = {};
  const result = await runOnce(project, name, given, ran);
  await recordRun(project.root, {
    workflow: name,
    ...ran,
    at: new Date().toISOString(),
    status: result.ok ? result.status : "failed",
    ...(result.ok
      ? { plan: result.plan.id, writes: result.plan.writes.length }
      : { error: result.error }),
  });
  return result;
}

/**
 * Which save of the Workflow ran, its code and the Response Adapters its
 * Tools went through, for the run history.
 */
type Ran = Pick<RunEntry, "saved" | "source" | "adapters">;

async function runOnce(
  project: Project,
  name: string,
  given: { input: unknown } | { commandLine: CommandLineInput },
  ran: Ran,
  /** The Repair the run before this one made, which this run shows. */
  repaired?: RepairRecord
): Promise<WorkflowRunResult> {
  const loaded = await loadWorkflow(project.root, name, {
    declarations: declarations(project.sdkTools()),
    tools: new Set(project.tools.keys()),
    outputSchema: (tool) => {
      const offered = project.tools.get(tool);
      return (
        offered &&
        project.baselines.get(offered.server, offered.tool)?.outputSchema
      );
    },
  });
  if (!loaded.ok) return loaded;
  const { workflow } = loaded;
  const source = shortHash(workflow.source);
  ran.saved = workflow.saved;
  ran.source = source;
  const input =
    "commandLine" in given
      ? inputFromCommandLine(workflow.input, given.commandLine)
      : given.input;
  const checked = checkInput(workflow.input, input);
  if (!checked.ok)
    return { ok: false, error: `Workflow ${name} not run. ${checked.error}` };

  const { key, approved, clock, writes, result, adapters, drift, fitting } =
    await planRun(project, workflow.source, input, workflow.contract);
  if (drift !== undefined) {
    // A run that follows a Repair reports any Drift left, and repairs no
    // more.
    const found =
      repaired === undefined
        ? await repairDrift(project, name, drift, adapters!)
        : undefined;
    if (found?.kind === "repaired") {
      return runOnce(project, name, given, ran, found.record);
    }
    return {
      ok: false,
      error: await driftReport(project, name, drift, found),
    };
  }
  if (!result.ok) return result;
  for (const tool of fitting) await project.repairs.settle(tool);
  const digests = adapters!.digests(workflow.tools);
  ran.adapters = digests;
  const { plan, reason, changedAdapters } = approvalFor(
    workflow,
    await runHistory(project.root),
    { source, adapters: digests },
    writes
  );
  const outcome = await planOutcome(project, plan, result.value, {
    key,
    clock,
    approved,
    needsApproval: reason !== undefined,
  });
  if (!outcome.ok) return outcome;
  const paused = outcome.status === "pending" || outcome.status === "changed";
  // The Approval view shows the Repairs behind the Adapters that changed.
  const shown = new Map<string, RepairRecord>();
  if (repaired !== undefined) shown.set(repaired.tool, repaired);
  if (paused) {
    for (const tool of changedAdapters) {
      const digest = digests[tool];
      const record = digest && (await project.repairs.get(tool, digest));
      if (record) shown.set(tool, record);
    }
  }
  return {
    ...outcome,
    workflow: name,
    ...(paused && reason !== undefined && { approvalReason: reason }),
    ...(shown.size > 0 && { repairs: [...shown.values()] }),
  };
}

/**
 * The Write Plan of a Workflow Run and why it needs Approval, if it does:
 * the developer never approved writes of this code, an Adapter changed
 * since the developer last saw its results, or the plan exceeds the Write
 * Budget.
 */
function approvalFor(
  workflow: LoadedWorkflow,
  history: RunEntry[],
  /** The code that ran, and the digests of the Adapters it went through. */
  ran: { source: string; adapters: Record<string, string> },
  writes: PlannedWrite[]
): { plan: WritePlan; reason?: string; changedAdapters: string[] } {
  const { name } = workflow;
  // Runs of this very save: a Workflow saved again under the name of a
  // deleted one is approved afresh.
  const ofThisSave = history.filter(
    (entry) => entry.workflow === name && entry.saved === workflow.saved
  );
  // Applied runs that sent writes, which the developer approved once.
  const appliedWrites = ofThisSave.filter(
    (entry) => entry.status === "applied" && (entry.writes ?? 0) > 0
  );
  // The developer last saw the Workflow's results through the Adapters of
  // its last finished run, or else of the run it was saved from.
  const lastFinished = ofThisSave.findLast(
    (entry) => entry.status === "applied" || entry.status === "complete"
  );
  const seen =
    lastFinished === undefined
      ? workflow.adapters
      : (lastFinished.adapters ?? {});
  // An Adapter added, changed or removed since then.
  const changedAdapters = workflow.tools.filter(
    (tool) => seen[tool] !== ran.adapters[tool]
  );
  const plan = writePlan(writes, ran.adapters);
  const needs = (reason: string) => ({ plan, reason, changedAdapters });
  if (plan.writes.length > 0 && appliedWrites.length === 0) {
    return needs(`Workflow ${name} has never been applied`);
  }
  // Code edited since, by hand or by an agent, is approved afresh.
  if (
    plan.writes.length > 0 &&
    !appliedWrites.some((entry) => entry.source === ran.source)
  ) {
    return needs(
      `the code of Workflow ${name} changed since its writes were last approved`
    );
  }
  if (changedAdapters.length > 0) {
    const since =
      lastFinished === undefined
        ? `Workflow ${name} was saved`
        : `the last finished run of Workflow ${name}`;
    return needs(
      `the Response Adapter of ${changedAdapters.join(", ")} changed since ${since}`
    );
  }
  if (plan.writes.length > workflow.writeBudget) {
    return needs(
      `the Write Plan has ${writeCount(plan)}, over the Write Budget of ${workflow.writeBudget}`
    );
  }
  return { plan, changedAdapters };
}
