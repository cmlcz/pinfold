// H3: no write reaches a Downstream Server unless it is part of a Write Plan
// that the developer approved or that could run without Approval. Random
// Workflows, inputs, Drift Scenarios and failed writes try to break it; the
// Drift Kit's received-writes log is the oracle.
//
// CI runs a fixed seed. A larger run, or another seed:
//   PINFOLD_PROPERTY_RUNS=200 PINFOLD_PROPERTY_SEED=7 npx vitest run no-unreviewed-writes
// PINFOLD_PROPERTY_LOG=1 also prints what each case did.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ControlClient, ReceivedWrite } from "../../drift-kit/index.ts";
import { decodeValue, Placeholder } from "../../sandbox/index.ts";
import {
  openCore,
  openPlans,
  type PlanRecord,
  type PinfoldConfig,
} from "../index.ts";
import {
  caseArb,
  codeOf,
  type Action,
  type Input,
  type Program,
} from "./write-cases.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

const runs = Number(process.env.PINFOLD_PROPERTY_RUNS ?? 25);
const seed = Number(process.env.PINFOLD_PROPERTY_SEED ?? 20261027);

let ws: Workspace;
let config: PinfoldConfig;
let sentry: ControlClient;
let linear: ControlClient;

beforeAll(async () => {
  ws = await createWorkspace();
  // Over HTTP each core opens its own session, so a core opened after a
  // Drift Scenario starts lists the Tools it changes.
  config = {
    servers: {
      sentry: { url: await ws.serveHttp("sentry") },
      linear: { url: await ws.serveHttp("linear") },
    },
    classification: {
      ...sentryReads,
      linear: { searchIssues: "read", createIssue: "write" },
    },
  };
  sentry = ws.control("sentry");
  linear = ws.control("linear");
});

afterAll(() => ws.close());

describe("no unreviewed writes (H3)", () => {
  it(
    "sends only writes of approved or approval-free Write Plans, in order and at most once",
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArb, ({ programs, actions }) =>
          runCase(programs, actions)
        ),
        { seed, numRuns: runs }
      );
    },
    // A case takes about a second, and shrinking a failure runs many more.
    Math.max(600_000, runs * 5_000)
  );
});

// A Write Plan record the oracle lets send its writes, and how far it got.
type Allowance = {
  writes: PlanRecord["writes"];
  /** The index of the next write it may send. */
  next: number;
  /** Writes the developer recorded as sent, which no resume sends. */
  skipped: Set<number>;
};

// A saved Workflow as the oracle tracks it, to tell when a run of it may
// send writes without Approval.
type Saved = {
  source: string;
  budget: number;
  /** Sources whose writes an applied run of this save sent. */
  applied: Set<string>;
  /** The Adapters of its last applied or complete run. */
  seenAdapters?: string;
};

async function runCase(programs: Program[], actions: Action[]) {
  await Promise.all([sentry.reset(), linear.reset()]);
  const root = await mkdtemp(join(ws.dir, "case-"));
  const plans = openPlans(root);
  let core = await openCore(config, { root });
  const allowances = new Map<string, Allowance>();
  const known = new Map<string, PlanRecord["status"]>();
  // Successful Exploration Runs, which a save picks from.
  const explorations: { run: string; program: number }[] = [];
  const saved = new Map<string, Saved>();
  // Recent runs, which a rerun repeats.
  const recent: (({ code: string } | { workflow: string }) & {
    input: Input;
  })[] = [];
  const log: string[] = [];
  let received = 0;

  const fail = (message: string): never => {
    throw new Error(`${message}\nActions:\n${log.join("\n")}`);
  };

  try {
    for (const action of actions) {
      log.push(`  ${JSON.stringify(action)}`);
      // The Workflow a Workflow Run ran, as the oracle knew it before.
      let ran: Saved | undefined;
      const explore = async (code: string, input: Input, program?: number) => {
        const result = await core.explore({ code, input });
        if (result.ok && program !== undefined)
          explorations.push({ run: result.exploration, program });
        log.push(`    -> ${summary(result)}`);
      };
      const run = async (name: string, input: Input) => {
        const workflow = saved.get(name)!;
        ran = { ...workflow, applied: new Set(workflow.applied) };
        const result = await core.runWorkflow({ name, input });
        log.push(`    -> ${summary(result)}`);
        if (!result.ok) return;
        if (result.status === "applied" && result.plan.writes.length > 0)
          workflow.applied.add(workflow.source);
        if (result.status === "applied" || result.status === "complete")
          workflow.seenAdapters = canonical(result.plan.adapters);
      };
      switch (action.kind) {
        case "explore": {
          const code = codeOf(programs[action.program]!);
          recent.push({ code, input: action.input });
          await explore(code, action.input, action.program);
          break;
        }
        case "rerun": {
          const again = newestFirst(recent, action.pick);
          if (again === undefined) break;
          if ("code" in again) await explore(again.code, again.input);
          else await run(again.workflow, again.input);
          break;
        }
        case "approve": {
          const pending = await plans.pending();
          const chosen = newestFirst(pending, action.pick);
          if (chosen === undefined) break;
          const approved = await plans.approve(chosen.id);
          allowances.set(approved.record, {
            writes: approved.writes,
            next: 0,
            skipped: new Set(),
          });
          log.push(`    -> approved ${approved.record}`);
          break;
        }
        case "decline": {
          const open = (await planRecords(root)).filter(
            (record) =>
              record.status === "pending" || record.status === "approved"
          );
          const chosen = newestFirst(open, action.pick);
          if (chosen === undefined) break;
          const declined = await plans.decline(chosen.id);
          allowances.delete(declined.record);
          log.push(`    -> declined ${declined.record}`);
          break;
        }
        case "failWrite":
          await linear.failWrite(action.call);
          break;
        case "sentryDrift":
          if (action.on) await sentry.startDrift(action.scenario);
          else await sentry.stopDrift(action.scenario);
          break;
        case "linearDrift":
          if (action.on) await linear.startDrift("renamed-argument");
          else await linear.stopDrift("renamed-argument");
          await core.close();
          core = await openCore(config, { root });
          break;
        case "save": {
          const exploration = newestFirst(explorations, action.pick);
          if (exploration === undefined) break;
          const name = `w${exploration.program}`;
          if (saved.has(name)) break;
          const result = await core.saveWorkflow({
            run: exploration.run,
            name,
            confirmed: true,
          });
          if (!result.ok) {
            log.push(`    -> not saved`);
            break;
          }
          saved.set(name, {
            source: await readFile(workflowFile(root, name), "utf8"),
            budget: 10,
            applied: new Set(),
          });
          log.push(`    -> saved ${name}`);
          break;
        }
        case "run": {
          const name = newestFirst([...saved.keys()], action.pick);
          if (name === undefined) break;
          recent.push({ workflow: name, input: action.input });
          await run(name, action.input);
          break;
        }
        case "edit": {
          const name = newestFirst([...saved.keys()], action.pick);
          if (name === undefined) break;
          const workflow = saved.get(name)!;
          workflow.source = [
            `export const settings = { writeBudget: ${action.budget} };`,
            "",
            codeOf(programs[action.program]!),
            "",
          ].join("\n");
          workflow.budget = action.budget;
          await writeFile(workflowFile(root, name), workflow.source);
          break;
        }
        case "resume": {
          const stopped = (await planRecords(root)).filter(
            (record) =>
              record.status === "failed" || record.status === "applying"
          );
          const chosen = newestFirst(stopped, action.pick);
          if (chosen === undefined) break;
          for (let write = 1; write <= chosen.writes.length; write++) {
            try {
              await plans.resolve(chosen.record, write, action.sent);
            } catch {
              continue; // Not in doubt.
            }
            if (action.sent) {
              allowances.get(chosen.record)?.skipped.add(write - 1);
            }
          }
          try {
            const result = await core.resume(chosen.record);
            log.push(`    -> resumed ${chosen.record}: sent ${result.sent}`);
          } catch (error) {
            log.push(`    -> ${(error as Error).message.split("\n")[0]}`);
          }
          break;
        }
      }

      // Records the developer did not approve: only a Workflow Run may
      // add one, and only one that needs no Approval.
      for (const record of await planRecords(root)) {
        const before = known.get(record.record);
        known.set(record.record, record.status);
        if (record.status === "pending" || allowances.has(record.record))
          continue;
        if (record.status === "declined") continue;
        if (before !== undefined) {
          fail(
            `Write Plan record ${record.record} went from ${before} to ${record.status} without the developer's Approval`
          );
        }
        const why =
          ran === undefined
            ? "it was not added by a Workflow Run"
            : !ran.applied.has(ran.source)
              ? "the Workflow's code was never applied with Approval"
              : ran.seenAdapters !== canonical(record.adapters)
                ? "its Adapters changed since the last finished run"
                : record.writes.length > ran.budget
                  ? "it exceeds the Write Budget"
                  : undefined;
        if (why !== undefined) {
          fail(
            `Write Plan record ${record.record} was approved without the developer, but ${why}`
          );
        }
        allowances.set(record.record, {
          writes: record.writes,
          next: 0,
          skipped: new Set(),
        });
        log.push(`    -> ${record.record} needs no Approval`);
      }

      const writes = await linear.receivedWrites();
      const delta = writes.slice(received);
      received = writes.length;
      if (delta.length === 0) continue;
      if (!["explore", "rerun", "run", "resume"].includes(action.kind)) {
        fail(`${action.kind} sent ${JSON.stringify(delta)}`);
      }
      // Two records may hold the same writes, so the one sent is the one
      // whose status agrees: only a stopped Apply leaves writes unsent.
      const statuses = new Map(
        (await planRecords(root)).map((record) => [
          record.record,
          record.status,
        ])
      );
      const matching = [...allowances].filter(([, candidate]) =>
        continues(candidate, delta)
      );
      if (matching.length === 0) {
        fail(
          `Writes outside every approved or approval-free Write Plan: ${JSON.stringify(delta)}`
        );
      }
      const agrees = ([record, candidate]: [string, Allowance]) => {
        const left = remaining(candidate, delta.length);
        const status = statuses.get(record);
        return left === 0 ? status === "applied" : status === "failed";
      };
      const sent = matching.find(agrees);
      if (sent === undefined) {
        const [record, candidate] = matching[0]!;
        fail(
          `Write Plan record ${record} is ${statuses.get(record)} with ${remaining(candidate, delta.length)} of its writes not sent`
        );
      }
      advance(sent![1], delta.length);
    }
    if (process.env.PINFOLD_PROPERTY_LOG)
      console.log(`received ${received}\n${log.join("\n")}`);
  } finally {
    await core.close();
  }
}

// Whether the writes are the allowance's next ones, in order.
function continues(allowance: Allowance, delta: ReceivedWrite[]): boolean {
  let index = allowance.next;
  for (const write of delta) {
    while (allowance.skipped.has(index)) index++;
    const planned = allowance.writes[index];
    if (
      planned === undefined ||
      planned.tool !== `linear.${write.tool}` ||
      !matches(planned.arguments, write.arguments)
    ) {
      return false;
    }
    index++;
  }
  return true;
}

// How many of the allowance's writes would be neither sent nor skipped
// once it sends that many more.
function remaining(allowance: Allowance, sending = 0): number {
  const after = { ...allowance };
  advance(after, sending);
  let left = 0;
  for (let index = after.next; index < after.writes.length; index++) {
    if (!after.skipped.has(index)) left++;
  }
  return left;
}

function advance(allowance: Allowance, count: number) {
  for (let sent = 0; sent < count; sent++) {
    while (allowance.skipped.has(allowance.next)) allowance.next++;
    allowance.next++;
  }
}

// A planned value against the value the server received. A Placeholder
// stands for an earlier write's result, known only at Apply.
function matches(planned: unknown, actual: unknown): boolean {
  if (planned instanceof Placeholder) return typeof actual === "string";
  if (typeof planned !== "object" || planned === null)
    return planned === actual;
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(planned) !== Array.isArray(actual)) return false;
  const keys = (value: object) =>
    Object.keys(value).filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined
    );
  const plannedKeys = keys(planned).sort();
  const actualKeys = keys(actual).sort();
  return (
    plannedKeys.join() === actualKeys.join() &&
    plannedKeys.every((key) =>
      matches(
        (planned as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key]
      )
    )
  );
}

// Every Write Plan record, read as the plan store keeps them: a decline
// marker outranks the record's own status.
async function planRecords(root: string): Promise<PlanRecord[]> {
  const dir = join(root, ".pinfold", "plans");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const records: PlanRecord[] = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const record = decodeValue(
      await readFile(join(dir, file), "utf8")
    ) as PlanRecord;
    if (files.includes(`${record.record}.declined`)) record.status = "declined";
    records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The item a pick chooses, counting from the newest.
function newestFirst<T>(items: T[], pick: number): T | undefined {
  return items.at(-1 - (pick % Math.max(items.length, 1)));
}

function workflowFile(root: string, name: string): string {
  return join(root, ".workflows", `${name}.ts`);
}

function canonical(adapters: Record<string, string>): string {
  return JSON.stringify(Object.entries(adapters).sort());
}

function summary(
  result: { ok: true; status: string } | { ok: false; error: string }
): string {
  return result.ok ? result.status : result.error.split("\n")[0]!;
}
