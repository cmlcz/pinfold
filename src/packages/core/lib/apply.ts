// Apply: send an approved Write Plan's writes in order, giving each write the
// real results of the earlier writes its Placeholders stand for. Before
// that, what becomes of a run's Write Plan: applied now, or left to wait
// for Approval.
import { Placeholder, type Clock } from "../../sandbox/index.ts";
import { loadAdapters } from "./adapters.ts";
import { describeMismatch, mismatches } from "./drift.ts";
import { resolveHint, type RunJournal } from "./journal.ts";
import {
  span,
  writeCount,
  type Failed,
  type PlanOutcome,
  type ResumeResult,
} from "./outcome.ts";
import {
  canonicalize,
  containsPlaceholder,
  type PlannedWrite,
  type WritePlan,
} from "./plan.ts";
import { valuesAt } from "./paths.ts";
import type { PlanRecord } from "./plans.ts";
import type { Project } from "./project.ts";

/**
 * What becomes of a run's Write Plan, given the plan approved for the same
 * code and input, if any. A new plan waits for Approval unless the run
 * needs none, in which case it is applied now.
 */
export async function planOutcome(
  project: Project,
  plan: WritePlan,
  value: unknown,
  run: {
    key: string;
    clock: Clock;
    approved: PlanRecord | undefined;
    needsApproval: boolean;
  }
): Promise<PlanOutcome | Failed> {
  const { plans } = project;
  if (plan.writes.length === 0 && !run.needsApproval)
    return { ok: true, status: "complete", value, plan };
  const refused = inputDrift(project, plan);
  if (refused !== undefined) return refused;
  const record = await plans.latest(plan.id);
  switch (record?.status) {
    case "approved":
      return apply(project, record, plan, value);
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
      // New, or applied or declined before: the developer approves this run
      // afresh. A decline answered one request, not every run to come, but
      // a plan declined last waits for the developer again, even in a run
      // that needs no Approval otherwise.
      const status =
        run.needsApproval || record?.status === "declined"
          ? "pending"
          : "approved";
      const added = await plans.add(plan, run.key, run.clock, status, record);
      if (status === "approved") {
        if (added === undefined) {
          return {
            ok: false,
            error: `Another run added Write Plan ${plan.id} at the same time; nothing was sent.`,
          };
        }
        return apply(project, added, plan, value);
      }
    }
  }
  if (run.approved !== undefined) {
    return { ok: true, status: "changed", value, plan, approved: run.approved };
  }
  const declined = record?.status === "declined";
  return {
    ok: true,
    status: "pending",
    value,
    plan,
    ...(declined && { declined }),
  };
}

/** Sends the writes a stopped run's Apply did not send, and no others. */
export async function resume(
  project: Project,
  run: string
): Promise<ResumeResult> {
  const record = await project.plans.get(run);
  if (record === undefined) throw new Error(`no run ${run}`);
  const { id, writes, adapters } = record;
  const plan = { id, writes, adapters };
  switch (record.status) {
    case "applied":
      return { run, plan, sent: [] };
    // An Apply still running is safe to resume too: the journal lets only
    // one Apply take each write, and only after the one before it.
    case "failed":
    case "applying":
      break;
    default:
      throw new Error(
        `Write Plan ${plan.id} is ${record.status}; there is nothing to resume.`
      );
  }
  const { results, before } = await sendRest(project, record);
  await pinResults(project, plan.writes, results, before);
  const sent = [...results.keys()].slice(before).map((index) => index + 1);
  return { run, plan, sent };
}

// The plan was rebuilt by this very run, so its reads are fresh.
async function apply(
  project: Project,
  record: PlanRecord,
  plan: WritePlan,
  value: unknown
): Promise<PlanOutcome | Failed> {
  if (!(await project.plans.claim(record))) return busy(plan, record);
  let results: unknown[];
  try {
    results = (await sendRest(project, record)).results;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  try {
    await pinResults(project, plan.writes, results, 0);
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

// Sends the writes of the run's Write Plan that the Apply Journal does not
// hold yet. Returns the results of all its writes, and how many were sent
// before.
async function sendRest(
  project: Project,
  record: PlanRecord
): Promise<{ results: unknown[]; before: number }> {
  const { plans } = project;
  // Every write's Tool is found first: a Tool no longer offered stops the
  // Apply before it takes a write, so a resume can send it later.
  for (const write of record.writes) {
    if (!project.tools.has(write.tool)) {
      throw new Error(
        `${write.tool} is not offered, so nothing was sent. Once it is offered again, \`pinfold resume ${record.record}\` sends the writes not sent.`
      );
    }
  }
  // A write's result reaches later writes through its Tool's Response
  // Adapter, as a read's response reaches the program.
  const adapters = await loadAdapters(project.root).catch((error: unknown) => {
    throw new Error(
      `${(error as Error).message}\nNothing was sent. Once it is fixed, \`pinfold resume ${record.record}\` sends the writes not sent.`
    );
  });
  const run = project.journal.run(record.record);
  const before = run.sent().length;
  let results: unknown[];
  try {
    results = await sendWrites(record.writes, run, async (write, args) =>
      adapters.adapt(write.tool, await project.toolOf(write).call(args))
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

// Pins the Baselines of the Write Tools from the results of the writes sent
// from this one on.
async function pinResults(
  project: Project,
  writes: PlannedWrite[],
  results: unknown[],
  from: number
) {
  for (let index = from; index < writes.length; index++) {
    await project.baselines.record(
      project.toolOf(writes[index]!),
      results[index]
    );
  }
}

/**
 * A Write Tool whose listing now asks for other arguments than its Baseline
 * would refuse a planned write in the middle of Apply, after the writes
 * before it were sent. So a plan with a write that no longer fits is
 * refused whole, before Approval and before anything is sent. A field that
 * holds a Placeholder is left out, since its value is known only at Apply.
 */
function inputDrift(project: Project, plan: WritePlan): Failed | undefined {
  for (const [index, write] of plan.writes.entries()) {
    const tool = project.toolOf(write);
    const baseline = project.baselines.get(tool.server, tool.tool);
    if (
      baseline === undefined ||
      sameSchema(baseline.inputSchema, tool.inputSchema)
    ) {
      continue;
    }
    const found = mismatches(tool.inputSchema, write.arguments).filter(
      ({ path }) => !holdsPlaceholder(write.arguments, path)
    );
    if (found.length === 0) continue;
    return {
      ok: false,
      error: `Write Plan ${plan.id} not sent: ${write.tool} now accepts other arguments than its Baseline, and write ${index + 1} no longer fits them: ${found.map(describeMismatch).join("; ")}. Nothing was sent. \`pinfold baseline migrate ${write.tool}\` shows how the Tool changed; then edit the code to send what it accepts now.`,
    };
  }
  return undefined;
}

function sameSchema(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

// Whether the value at a path, or at any field it lies within, holds a
// Placeholder.
function holdsPlaceholder(value: unknown, path: string): boolean {
  const steps = path.split(".");
  return steps.some((_, end) =>
    valuesAt(value, steps.slice(0, end + 1).join(".")).some(containsPlaceholder)
  );
}

function busy(plan: WritePlan, record: PlanRecord): Failed {
  return {
    ok: false,
    error: `Write Plan ${plan.id} is being applied by another run, or a run applying it stopped; nothing was sent. If no run is applying it, \`pinfold resume ${record.record}\` sends the writes not sent, or \`pinfold decline ${plan.id}\` gives it up.`,
  };
}

/** An Apply stopped at a write that failed; the report says what was sent. */
export class ApplyStopped extends Error {}

/**
 * Sends the writes the journal has not recorded as sent and returns the
 * results of all writes. Stops at the first write that fails.
 */
export async function sendWrites(
  writes: PlannedWrite[],
  journal: RunJournal,
  send: (write: PlannedWrite, args: unknown) => Promise<unknown>
): Promise<unknown[]> {
  const results = journal.sent();
  for (let index = results.length; index < writes.length; index++) {
    const write = writes[index]!;
    const position = index + 1;
    const stopped = (error: unknown, next: string) =>
      new ApplyStopped(
        `Apply stopped at write ${position} of ${writes.length} (${write.tool}): ${(error as Error).message}. Sent: ${span(1, index)}. ${next}`,
        { cause: error }
      );
    let args: unknown;
    try {
      args = resolvePlaceholders(write.arguments, results);
    } catch (error) {
      // The results a resume would resolve from are the same, so it would
      // stop here again.
      throw stopped(
        error,
        `Not sent: ${span(position, writes.length)}. The real result of an earlier write lacks what this write needs, as its Tool's response drifted, so no resume can send it. A Response Adapter for that Tool maps its results for later runs.`
      );
    }
    switch (journal.take(index)) {
      case "busy":
        throw new Error(`Write ${position} is being sent by another Apply.`);
      case "declined":
        throw new ApplyStopped(
          `The developer declined this Write Plan, so the Apply stopped before write ${position} of ${writes.length}. Sent: ${span(1, index)}. Not sent: ${span(position, writes.length)}.`
        );
    }
    try {
      results.push(await send(write, args));
    } catch (error) {
      // Even a server that answered with an error may have made the change
      // first: the reference MCP server SDK, for one, checks a Tool's output
      // only after running it. So the write stays taken, in doubt, until the
      // developer resolves it.
      throw stopped(
        error,
        `May have been sent: write ${position}. Not sent: ${span(position + 1, writes.length)}. Then ${resolveHint(journal.run, position)}; after that, \`pinfold resume ${journal.run}\` sends the writes not sent.`
      );
    }
    journal.settle(index, results[index]);
  }
  return results;
}

/** A copy of a value with each Placeholder replaced by the real result. */
export function resolvePlaceholders(
  value: unknown,
  results: unknown[]
): unknown {
  if (value instanceof Placeholder) {
    let resolved: unknown = results[value.write - 1];
    for (const step of value.path) {
      if (
        typeof resolved !== "object" ||
        resolved === null ||
        !Object.hasOwn(resolved, step)
      ) {
        throw new Error(`${value} has no value in the real result`);
      }
      resolved = (resolved as Record<string, unknown>)[step];
    }
    return resolved;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value))
    return value.map((item) => resolvePlaceholders(item, results));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolvePlaceholders(item, results),
    ])
  );
}
