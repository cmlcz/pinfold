// A Workflow Run: the Workflow's checks, then a Plan that is applied
// unattended unless Approval is required. Drift that stops the Plan is
// repaired deterministically where it can be, and the run tried again.
import { planOutcome } from "./apply.ts";
import {
  adapterApprovalPlan,
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
    ...(result.ok ? { plan: result.plan.id } : { error: result.error }),
  });
  return result;
}

/**
 * Which save of the Workflow ran and the Response Adapters its Tools went
 * through, for the run history.
 */
type Ran = { saved?: string; adapters?: Record<string, string> };

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
  ran.saved = workflow.saved;
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
    digests,
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
 * the Workflow was never applied, an Adapter changed since the developer
 * last saw its results, or the plan exceeds the Write Budget.
 */
function approvalFor(
  workflow: LoadedWorkflow,
  history: RunEntry[],
  /** The digests of the Adapters this run went through. */
  digests: Record<string, string>,
  writes: PlannedWrite[]
): { plan: WritePlan; reason?: string; changedAdapters: string[] } {
  const { name } = workflow;
  // Runs of this very save: a Workflow saved again under the name of a
  // deleted one is approved afresh.
  const ofThisSave = (entry: RunEntry) =>
    entry.workflow === name && entry.saved === workflow.saved;
  const lastApplied = history.findLast(
    (entry) => ofThisSave(entry) && entry.status === "applied"
  );
  // The developer last saw the Workflow's results through the Adapters of
  // its last finished run, or else of the run it was saved from.
  const lastFinished = history.findLast(
    (entry) =>
      ofThisSave(entry) &&
      (entry.status === "applied" || entry.status === "complete")
  );
  const seen =
    lastFinished === undefined
      ? workflow.adapters
      : (lastFinished.adapters ?? {});
  // An Adapter added, changed or removed since then.
  const changedAdapters = workflow.tools.filter(
    (tool) => seen[tool] !== digests[tool]
  );
  // Even a run without writes waits for changed Adapters to be approved.
  const plan =
    writes.length === 0 && changedAdapters.length > 0
      ? adapterApprovalPlan(digests)
      : writePlan(writes);
  if (plan.writes.length > 0 && lastApplied === undefined) {
    return {
      plan,
      reason: `Workflow ${name} has never been applied`,
      changedAdapters,
    };
  }
  if (changedAdapters.length > 0) {
    const since =
      lastFinished === undefined
        ? `Workflow ${name} was saved`
        : `the last finished run of Workflow ${name}`;
    return {
      plan,
      reason: `the Response Adapter of ${changedAdapters.join(", ")} changed since ${since}`,
      changedAdapters,
    };
  }
  if (plan.writes.length > workflow.writeBudget) {
    return {
      plan,
      reason: `the Write Plan has ${writeCount(plan)}, over the Write Budget of ${workflow.writeBudget}`,
      changedAdapters,
    };
  }
  return { plan, changedAdapters };
}
