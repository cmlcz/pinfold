// Repair as a run and the agent meet it: deterministic Repair of the Drift
// that stopped a Workflow Run, the report of that Drift, and Repair through
// the agent of Drift that stays pending. The search and the checks are in
// repair.ts.
import {
  loadAdapters,
  parseOps,
  writeAdapter,
  type Adapters,
  type Op,
} from "./adapters.ts";
import { toolName } from "./baselines.ts";
import type { DownstreamTool } from "./downstream.ts";
import { describeMismatch, mayBeOptional, touchesContract } from "./drift.ts";
import type { ProposalResult } from "./outcome.ts";
import type { Drift } from "./plan-run.ts";
import type { Project } from "./project.ts";
import {
  checkRepair,
  redactUnlisted,
  repairTask,
  searchRepair,
  type RepairRecord,
  type RepairSearch,
  type RepairTask,
} from "./repair.ts";
import {
  fixtureCalls,
  redactCall,
  redactionRules,
  savedContracts,
} from "./workflows.ts";

/** What deterministic Repair made of the Drift that stopped a run. */
export type RepairOutcome =
  | { kind: "repaired"; record: RepairRecord }
  | Exclude<RepairSearch, { kind: "repaired" }>;

/**
 * Deterministic Repair of the Drift that stopped a run of a Workflow. The
 * Adapter version it finds is written, and kept with its evidence for the
 * Approval view; Drift it cannot settle is kept as pending.
 */
export async function repairDrift(
  project: Project,
  workflow: string,
  drift: Drift,
  adapters: Adapters
): Promise<RepairOutcome> {
  const input = await repairInput(
    project,
    drift.offered,
    adapters,
    drift.reads
  );
  const found = searchRepair({
    ...input,
    baseline: drift.baseline,
    responses: drift.responses,
  });
  if (found.kind === "pending") {
    // Kept on disk, so redacted like Fixtures. Where a Tool has rules, a
    // value the Drift moved out of their reach is redacted too.
    const rules = project.config.redact ?? {};
    const guarded = redactionRules(rules, drift.tool).length > 0;
    await project.repairs.pend({
      tool: drift.tool,
      workflow,
      at: new Date().toISOString(),
      mismatches: drift.mismatches,
      reads: drift.reads,
      reason: found.reason,
      responses: drift.responses.map((call) => {
        const { arguments: args, response } = redactCall(
          { tool: drift.tool, ...call },
          rules
        );
        return {
          arguments: args,
          response: guarded
            ? redactUnlisted(drift.baseline, response)
            : response,
        };
      }),
    });
  }
  if (found.kind !== "repaired") return found;
  const added = found.ops.slice(input.ops.length);
  const record = await writeRepair(project, drift.offered, adapters, added, {
    by: "pinfold",
    evidence: found.evidence,
  });
  return { kind: "repaired", record };
}

/**
 * What a run stopped by Drift reports: the Tool, its fields, every Workflow
 * the Drift affects, and what Repair made of it.
 */
export async function driftReport(
  project: Project,
  workflow: string,
  drift: Drift,
  found: Exclude<RepairOutcome, { kind: "repaired" }> | undefined
): Promise<string> {
  const affected = (await savedContracts(project.root))
    .filter(({ contract }) =>
      touchesContract(drift.mismatches, contract, drift.tool)
    )
    .map(({ name }) => name);
  // The run's own reads touched the Drift, whatever its saved Contract says.
  if (!affected.includes(workflow)) affected.unshift(workflow);
  const lines = [
    `Workflow ${workflow} not run: the responses of ${drift.tool} drifted from its Baseline, so the run stopped before it made a Write Plan; nothing was sent.`,
    ...drift.mismatches.map((mismatch) => `  ${describeMismatch(mismatch)}`),
    `Affected Workflows: ${affected.join(", ")}.`,
  ];
  if (found?.kind === "manual") {
    return [...lines, `It needs a manual fix: ${found.reason}.`].join("\n");
  }
  // One response cannot show that a field is optional, so the Baseline may
  // require one the server leaves out at times.
  for (const { path } of drift.mismatches.filter(mayBeOptional)) {
    lines.push(
      `If the server leaves out ${path} at times, rather than having dropped it, \`pinfold baseline optional ${drift.tool} ${path}\` makes it optional in the Baseline.`
    );
  }
  if (found?.kind === "pending") {
    lines.push(
      `pinfold found no Repair to propose: ${found.reason}. The Drift is recorded as pending: the agent can see it and propose a Response Adapter with propose_repair, which the developer then approves.`
    );
  }
  lines.push(
    `A Response Adapter for ${drift.tool} in .workflows/adapters/ that maps its responses back to the Baseline repairs every affected Workflow.`
  );
  return lines.join("\n");
}

/** The pending Drift, by Tool, with what an agent needs to repair it. */
export async function repairTasks(project: Project): Promise<RepairTask[]> {
  const adapters = await loadAdapters(project.root);
  const tasks: RepairTask[] = [];
  for (const pending of await project.repairs.pending()) {
    const tool = project.tools.get(pending.tool);
    const input =
      tool && (await repairInput(project, tool, adapters, pending.reads));
    // A Tool no longer offered, or never pinned, has no Baseline to repair
    // against.
    if (input?.baseline === undefined) continue;
    tasks.push(repairTask(pending, { ...input, baseline: input.baseline }));
  }
  return tasks;
}

/**
 * Checks ops an agent proposes to add to a Tool's Response Adapter for its
 * pending Drift, as deterministic Repair checks its own, and writes the new
 * Adapter version if they repair it.
 */
export async function proposeRepair(
  project: Project,
  { tool: name, ops }: { tool: string; ops: unknown }
): Promise<ProposalResult> {
  const refuse = (error: string) => ({
    ok: false as const,
    error: `Repair of ${name} not proposed: ${error}.`,
  });
  const pending = (await project.repairs.pending()).find(
    (drift) => drift.tool === name
  );
  const tool = project.tools.get(name);
  if (pending === undefined || tool === undefined) {
    return refuse(
      "it has no pending Drift; propose_repair with no ops lists the Tools that have"
    );
  }
  const parsed = parseOps(ops);
  if (!parsed.ok) {
    return refuse(`the ops are not of the closed set:\n${parsed.error}`);
  }
  if (parsed.ops.length === 0) return refuse("it adds no ops");
  if (pending.responses.length === 0) {
    return refuse(
      "its pending Drift holds no live response to check the ops against; run an affected Workflow again to record one"
    );
  }
  let adapters: Adapters;
  try {
    adapters = await loadAdapters(project.root);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const input = await repairInput(project, tool, adapters, pending.reads);
  if (input.baseline === undefined) return refuse("it has no Baseline");
  const drift = {
    ...input,
    baseline: input.baseline,
    responses: pending.responses,
  };
  // The live responses on disk are redacted.
  const recorded = { redactedFits: true };
  if (checkRepair(drift, [], recorded).ok) {
    return refuse(
      "its live responses fit its Baseline through its Response Adapter as it is now; run an affected Workflow again"
    );
  }
  const checked = checkRepair(drift, parsed.ops, recorded);
  if (!checked.ok) {
    return refuse(
      [
        "through its Response Adapter and these ops, its live responses still do not fit the Baseline where a saved Workflow reads them:",
        ...checked.drifted.map((mismatch) => `  ${describeMismatch(mismatch)}`),
      ].join("\n")
    );
  }
  const record = await writeRepair(project, tool, adapters, parsed.ops, {
    by: "agent",
    evidence: checked.evidence,
  });
  const affected = (await savedContracts(project.root))
    .filter(({ contract }) => Object.hasOwn(contract, name))
    .map(({ name }) => name);
  return { ok: true, repair: record, affected };
}

// Writes the next version of a Tool's Adapter, its ops followed by those a
// Repair added, and keeps the Repair for the Approval view. That settles the
// Tool's pending Drift.
async function writeRepair(
  project: Project,
  tool: DownstreamTool,
  adapters: Adapters,
  added: Op[],
  found: Pick<RepairRecord, "by" | "evidence">
): Promise<RepairRecord> {
  const name = toolName(tool);
  const current = adapters.get(name);
  const kept = current?.ops ?? [];
  const version = (current?.version ?? 0) + 1;
  const digest = await writeAdapter(
    project.root,
    {
      server: tool.server,
      tool: tool.tool,
      version,
      ops: [...kept, ...added],
    },
    current?.path
  );
  const record: RepairRecord = {
    tool: name,
    ...found,
    digest,
    version,
    diff: [
      ...kept.map((op) => `  ${JSON.stringify(op)}`),
      ...added.map((op) => `+ ${JSON.stringify(op)}`),
    ],
  };
  await project.repairs.record(record);
  return record;
}

// What Repair works from for a Tool: its Baseline, its Adapter's ops, the
// field paths each saved Workflow reads of it, and the run that drifted
// read, and its Fixture calls, redacted by the rules as they are now.
async function repairInput(
  project: Project,
  tool: DownstreamTool,
  adapters: Adapters,
  reads: string[]
) {
  const name = toolName(tool);
  const fixtures = await fixtureCalls(project.root, name);
  const rules = project.config.redact ?? {};
  return {
    baseline: project.baselines.get(tool.server, tool.tool)?.outputSchema,
    ops: adapters.get(name)?.ops ?? [],
    contracts: [
      ...(await savedContracts(project.root)).flatMap(({ contract }) =>
        Object.hasOwn(contract, name) ? [contract[name]!] : []
      ),
      reads,
    ],
    fixtures: fixtures.map((call) => redactCall(call, rules)),
  };
}
