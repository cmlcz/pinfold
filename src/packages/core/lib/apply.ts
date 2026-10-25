// Apply: send an approved Write Plan's writes in order, giving each write the
// real results of the earlier writes its Placeholders stand for. Before
// that, what becomes of a run's Write Plan: applied now, or left to wait
// for Approval.
import { Placeholder, type Clock } from "../../sandbox/index.ts";
import { resolveHint, type RunJournal } from "./journal.ts";
import {
  span,
  writeCount,
  type Failed,
  type PlanOutcome,
  type ResumeResult,
} from "./outcome.ts";
import type { PlannedWrite, WritePlan } from "./plan.ts";
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
  const record = await plans.latest(plan.id);
  switch (record?.status) {
    case "declined":
      return { ok: true, status: "declined", value, plan };
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
        return apply(project, added, plan, value);
      }
    }
  }
  return run.approved === undefined
    ? { ok: true, status: "pending", value, plan }
    : { ok: true, status: "changed", value, plan, approved: run.approved };
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
  const run = project.journal.run(record.record);
  const before = run.sent().length;
  let results: unknown[];
  try {
    results = await sendWrites(record.writes, run, (write, args) =>
      project.toolOf(write).call(args)
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
    const stopped = (error: unknown, inDoubt: boolean) =>
      new ApplyStopped(
        `Apply stopped at write ${position} of ${writes.length} (${write.tool}): ${(error as Error).message}. ` +
          `Sent: ${span(1, index)}.` +
          (inDoubt
            ? ` May have been sent: write ${position}. Not sent: ${span(position + 1, writes.length)}. ` +
              `Then ${resolveHint(journal.run, position)}; after that, \`pinfold resume ${journal.run}\` sends the writes not sent.`
            : ` Not sent: ${span(position, writes.length)}. ` +
              `\`pinfold resume ${journal.run}\` sends the writes not sent.`),
        { cause: error }
      );
    let args: unknown;
    try {
      args = resolvePlaceholders(write.arguments, results);
    } catch (error) {
      throw stopped(error, false);
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
      throw stopped(error, true);
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
