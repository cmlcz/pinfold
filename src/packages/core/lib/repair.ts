// Repair: a new version of a drifted Tool's Response Adapter (ADR 0001).
// Deterministic search comes first and needs no model. For each field the
// Drift touches, it tries the ops of the closed set that could map the live
// responses back to the Baseline, keeps those that do, and scores them by
// how alike the field names are and how well the values agree with the
// Fixtures. It proposes a mapping only where one candidate stands out.
// Repairs it writes, and Drift it cannot settle, are kept under .pinfold/.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { applyOps, type Op } from "./adapters.ts";
import { toolFileName } from "./baselines.ts";
import {
  isMissing,
  mismatches,
  touches,
  touching,
  type Mismatch,
} from "./drift.ts";
import {
  childPath,
  formatPath,
  isRecord,
  parsePath,
  redacted,
  valuesAt,
  type Step,
} from "./paths.ts";
import { canonicalize } from "./plan.ts";
import type { JsonSchema } from "./schema.ts";

/** What deterministic search made of a Drift. */
export type RepairSearch =
  | {
      kind: "repaired";
      /** The ops of the new Adapter version: the old ones, then the new. */
      ops: Op[];
      /**
       * One line per field read that the Drift touched: its live values
       * through the new version, next to its values in the Fixtures.
       */
      evidence: string[];
    }
  /** No single mapping stands out; the developer or an agent may find one. */
  | { kind: "pending"; reason: string }
  /** No Response Adapter can express it, such as a pagination change. */
  | { kind: "manual"; reason: string };

type Call = { arguments: unknown; response: unknown };

// A candidate is proposed only if it scores at least this much, out of 1,
// and leads every other candidate for its field by at least this margin.
const minScore = 0.5;
const minLead = 0.25;

/**
 * Searches for ops that, added to a Tool's Adapter, map its live responses
 * back to its Baseline wherever a saved Workflow reads them.
 */
export function searchRepair(drift: {
  baseline: JsonSchema;
  /** The ops of the Tool's Adapter now. */
  ops: Op[];
  /** The live responses of the run, as the server sent them. */
  responses: Call[];
  /** The field paths each saved Workflow reads of the Tool. */
  contracts: string[][];
  /** The Tool's calls in the Fixtures, whose responses fit the Baseline. */
  fixtures: Call[];
}): RepairSearch {
  const { baseline, ops, responses } = drift;
  // A mismatch that touches none of the reads touches no Contract, so
  // responses without such mismatches satisfy every affected Contract.
  const reads = [...new Set(drift.contracts.flat())];
  const driftedWith = (trial: Op[]) =>
    unique(
      responses.flatMap(({ response }) =>
        touching(mismatches(baseline, applyOps(trial, response)), reads)
      )
    );
  const adaptedWith = (trial: Op[]) =>
    responses.map(({ response }) => applyOps(trial, response));
  const history = historyOf(drift.fixtures, responses);

  const targets = driftedWith(ops);
  const chosen: Op[] = [];
  for (const target of targets) {
    const base = [...ops, ...chosen];
    const before = driftedWith(base);
    // An op chosen for another field may have repaired this one too.
    if (!before.some((mismatch) => same(mismatch, target))) continue;
    const live = adaptedWith(base);
    const cursor = pageCursor(baseline, target, live);
    if (cursor !== undefined) {
      return {
        kind: "manual",
        reason: `its responses now come in pages, with ${cursor}, and a Response Adapter maps one response without fetching the others`,
      };
    }
    const scored = candidates(baseline, target, live, history)
      .flatMap(({ op, name }) => {
        const trial = [...base, op];
        // A candidate repairs its field and makes no other one drift.
        const fits = driftedWith(trial).every(
          (mismatch) =>
            mismatch.path !== target.path &&
            before.some((other) => same(other, mismatch))
        );
        if (!fits) return [];
        const adapted = adaptedWith(trial);
        const values = mean(
          reads
            .filter((read) => touches(target.path, read))
            .map((read) =>
              agreement(valuesIn(history, read), valuesIn(adapted, read))
            )
        );
        return [{ op, score: (name + values) / 2 }];
      })
      .sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (best === undefined) {
      return {
        kind: "pending",
        reason: `no op of the closed set maps the live responses back to ${target.path}`,
      };
    }
    if (best.score < minScore) {
      return {
        kind: "pending",
        reason: `${JSON.stringify(best.op)} fits ${target.path}, but its values agree too little with the Fixtures`,
      };
    }
    if (second !== undefined && best.score - second.score < minLead) {
      return {
        kind: "pending",
        reason: `${JSON.stringify(best.op)} and ${JSON.stringify(second.op)} both fit ${target.path}, and neither stands out`,
      };
    }
    chosen.push(best.op);
  }

  const final = [...ops, ...chosen];
  if (driftedWith(final).length > 0) {
    return {
      kind: "pending",
      reason: "the mappings found do not repair every field together",
    };
  }
  const adapted = adaptedWith(final);
  const evidence = reads
    .filter((read) => targets.some((target) => touches(target.path, read)))
    .map(
      (read) =>
        `${read}: now ${summarize(valuesIn(adapted, read))}; in the Fixtures ${summarize(valuesIn(history, read))}`
    );
  return { kind: "repaired", ops: final, evidence };
}

// The ops that might map a drifted field back, each with how alike the
// names it joins are, from 0 to 1.
function candidates(
  baseline: JsonSchema,
  target: Mismatch,
  live: unknown[],
  history: unknown[]
): { op: Op; name: number }[] {
  const steps = parsePath(target.path) ?? [];
  const last = steps.at(-1);
  // Ops name fields, so a drifted array element or whole response has none.
  if (last === undefined || "each" in last) return [];
  if (isMissing(target)) {
    const parentSteps = steps.slice(0, -1);
    const parent = formatPath(parentSteps);
    const fields = newFields(baseline, parentSteps, live);
    const found: { op: Op; name: number }[] = fields.map((field) => ({
      op: { op: "rename", from: childPath(parent, field), to: target.path },
      name: similarity(field, last.key),
    }));
    // wrap and unwrap work on a field or the whole response, not an element.
    const parentLast = parentSteps.at(-1);
    if (parentLast !== undefined && "each" in parentLast) return found;
    const at = parent === "" ? {} : { at: parent };
    for (const field of fields) {
      const values = valuesIn(live, childPath(parent, field));
      if (
        values.some(
          (value) => isRecord(value) && Object.hasOwn(value, last.key)
        )
      ) {
        found.push({ op: { op: "unwrap", ...at, field }, name: 1 });
      }
    }
    // The value now stands where the Baseline has it under its only field.
    const shapes = schemasAt(baseline, parentSteps);
    const only = (schema: JsonSchema) =>
      Object.keys(schema.properties ?? {}).join() === last.key;
    if (shapes.length > 0 && shapes.every(only)) {
      found.push({ op: { op: "wrap", ...at, field: last.key }, name: 1 });
    }
    return found;
  }
  const shapes = schemasAt(baseline, steps);
  if (shapes.some((schema) => Array.isArray(schema.enum))) {
    const values = mapByRank(
      valuesIn(live, target.path),
      valuesIn(history, target.path)
    );
    return values === undefined
      ? []
      : [{ op: { op: "map", path: target.path, values }, name: 1 }];
  }
  const types = shapes.flatMap((schema) => [schema.type ?? []].flat());
  const targets = [
    ...(types.includes("number") || types.includes("integer")
      ? (["number", "epoch-ms"] as const)
      : []),
    ...(types.includes("string") ? (["string", "iso-date"] as const) : []),
  ];
  return targets.map((to) => ({
    op: { op: "convert", path: target.path, to },
    name: 1,
  }));
}

// The fields of the objects at a path that the Baseline does not have there.
// A map's keys are data, so none of them is new.
function newFields(
  baseline: JsonSchema,
  steps: Step[],
  live: unknown[]
): string[] {
  const shapes = schemasAt(baseline, steps);
  if (shapes.some((schema) => schema.properties === undefined)) return [];
  const known = new Set(
    shapes.flatMap((schema) => Object.keys(schema.properties ?? {}))
  );
  const keys = valuesIn(live, formatPath(steps))
    .filter(isRecord)
    .flatMap((value) => Object.keys(value));
  return [...new Set(keys)].filter((key) => !known.has(key));
}

// A new field beside a missing one that looks like a cursor to more pages.
function pageCursor(
  baseline: JsonSchema,
  target: Mismatch,
  live: unknown[]
): string | undefined {
  if (!isMissing(target)) return undefined;
  const steps = (parsePath(target.path) ?? []).slice(0, -1);
  return newFields(baseline, steps, live).find((field) =>
    /cursor|^next|page|offset|^has_?more$/i.test(field)
  );
}

// The schemas a path reaches in a JSON Schema, through unions and arrays.
function schemasAt(schema: JsonSchema | boolean, steps: Step[]): JsonSchema[] {
  if (typeof schema === "boolean") return [];
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.flatMap((option) => schemasAt(option, steps));
  }
  const [step, ...rest] = steps;
  if (step === undefined) return [schema];
  if ("each" in step) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    return [...prefix, schema.items ?? true].flatMap((items) =>
      schemasAt(items, rest)
    );
  }
  const properties = schema.properties ?? {};
  return schemasAt(
    Object.hasOwn(properties, step.key)
      ? properties[step.key]!
      : (schema.additionalProperties ?? true),
    rest
  );
}

// Maps enum values by rank: the live value seen most often to the value the
// Fixtures show most often, and so on. A tie leaves the ranks open, and so
// does a different number of values: then there is no mapping.
function mapByRank(
  now: unknown[],
  before: unknown[]
): Record<string, string | number | boolean> | undefined {
  const liveRanks = ranks(now);
  const fixtureRanks = ranks(before);
  if (
    liveRanks === undefined ||
    fixtureRanks === undefined ||
    liveRanks.length !== fixtureRanks.length
  ) {
    return undefined;
  }
  const values: Record<string, string | number | boolean> = {};
  for (const [index, value] of liveRanks.entries()) {
    const mapped = fixtureRanks[index]!;
    if (value !== mapped) values[String(value)] = mapped;
  }
  return values;
}

function ranks(values: unknown[]): (string | number | boolean)[] | undefined {
  if (values.length === 0 || !values.every(isPrimitive)) return undefined;
  const counts = new Map<string | number | boolean, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const tied = sorted.some(
    ([, count], index) => index > 0 && sorted[index - 1]![1] === count
  );
  return tied ? undefined : sorted.map(([value]) => value);
}

// The Fixture responses to compare with: those of calls with the arguments
// this run sent, when there are any, else all of them.
function historyOf(fixtures: Call[], responses: Call[]): unknown[] {
  const key = (call: Call) => JSON.stringify(canonicalize(call.arguments));
  const asked = new Set(responses.map(key));
  const same = fixtures.filter((call) => asked.has(key(call)));
  return (same.length > 0 ? same : fixtures).map((call) => call.response);
}

function valuesIn(responses: unknown[], path: string): unknown[] {
  return responses
    .flatMap((response) => valuesAt(response, path))
    .filter((value) => value !== redacted);
}

/**
 * How alike two field names are, from 0 to 1: the same, one inside the
 * other, or the share of words they have in common.
 */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.75;
  return overlap(new Set(words(a)), new Set(words(b)));
}

function words(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * How well two samples of a field's values agree, from 0 to 1: for numbers,
 * how far their ranges overlap; otherwise, the share of values they have in
 * common.
 */
function agreement(before: unknown[], now: unknown[]): number {
  if (before.length === 0 || now.length === 0) return 0;
  if (before.every(isNumber) && now.every(isNumber)) {
    const shared =
      Math.min(Math.max(...before), Math.max(...now)) -
      Math.max(Math.min(...before), Math.min(...now));
    if (shared < 0) return 0;
    const span = Math.max(...before, ...now) - Math.min(...before, ...now);
    return span === 0 ? 1 : shared / span;
  }
  const text = (value: unknown) => JSON.stringify(value);
  return overlap(new Set(before.map(text)), new Set(now.map(text)));
}

function overlap<T>(a: Set<T>, b: Set<T>): number {
  const shared = [...a].filter((item) => b.has(item)).length;
  return shared / (a.size + b.size - shared || 1);
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** The values of a field, in a few words: a median and range, or counts. */
function summarize(values: unknown[]): string {
  if (values.length === 0) return "no values";
  if (values.every(isNumber)) {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return `median ${number.format(median)}, range ${number.format(sorted[0]!)}–${number.format(sorted.at(-1)!)}`;
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    const text = JSON.stringify(value);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const shown = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => `${text} ×${count}`);
  const more = counts.size - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function mean(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function unique(found: Mismatch[]): Mismatch[] {
  return found.filter(
    (mismatch, index) =>
      found.findIndex((other) => same(other, mismatch)) === index
  );
}

function same(a: Mismatch, b: Mismatch): boolean {
  return a.path === b.path && a.problem === b.problem;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

/** A Repair pinfold wrote, kept for the Approval view of later runs. */
export type RepairRecord = {
  /** The Tool, as `server.tool`. */
  tool: string;
  /** The digest of the Adapter version it wrote. */
  digest: string;
  version: number;
  /** The new version's ops, each marked `+` if the Repair added it. */
  diff: string[];
  evidence: string[];
};

/** Drift that deterministic search could not settle. */
export type PendingDrift = {
  /** The Tool, as `server.tool`. */
  tool: string;
  /** The Workflow whose run found it. */
  workflow: string;
  at: string;
  mismatches: Mismatch[];
  reason: string;
};

const recordSchema = z.object({
  tool: z.string(),
  digest: z.string(),
  version: z.int(),
  diff: z.array(z.string()),
  evidence: z.array(z.string()),
});

const pendingSchema = z.object({
  tool: z.string(),
  workflow: z.string(),
  at: z.string(),
  mismatches: z.array(z.object({ path: z.string(), problem: z.string() })),
  reason: z.string(),
});

export type Repairs = {
  /** The Repair that wrote this version of a Tool's Adapter, if pinfold did. */
  get(tool: string, digest: string): Promise<RepairRecord | undefined>;
  /** Keeps a Repair, which settles the Tool's pending Drift. */
  record(repair: RepairRecord): Promise<void>;
  /** Keeps Drift as pending, in place of the Tool's earlier pending Drift. */
  pend(drift: PendingDrift): Promise<void>;
  /** Forgets a Tool's pending Drift, as its responses fit again. */
  settle(tool: string): Promise<void>;
  /** Every Tool's pending Drift. */
  pending(): Promise<PendingDrift[]>;
};

/** Repairs and pending Drift, in .pinfold/repairs/ and .pinfold/drift/. */
export function openRepairs(root: string): Repairs {
  const repairs = join(root, ".pinfold", "repairs");
  const drift = join(root, ".pinfold", "drift");
  const file = (dir: string, tool: string) => {
    const [server = "", ...rest] = tool.split(".");
    return join(dir, toolFileName(server, rest.join(".")));
  };
  const write = async (path: string, value: unknown) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    async get(tool, digest) {
      const text = await orNone(readFile(file(repairs, tool), "utf8"));
      const parsed = recordSchema.safeParse(text && safeJson(text));
      return parsed.success && parsed.data.digest === digest
        ? parsed.data
        : undefined;
    },
    async record(repair) {
      await write(file(repairs, repair.tool), repair);
      await rm(file(drift, repair.tool), { force: true });
    },
    pend: (pending) => write(file(drift, pending.tool), pending),
    settle: (tool) => rm(file(drift, tool), { force: true }),
    async pending() {
      const files = (await orNone(readdir(drift))) ?? [];
      const found: PendingDrift[] = [];
      for (const name of files.filter((name) => name.endsWith(".json"))) {
        const text = await readFile(join(drift, name), "utf8");
        const parsed = pendingSchema.safeParse(safeJson(text));
        if (parsed.success) found.push(parsed.data);
      }
      return found.sort((a, b) => a.tool.localeCompare(b.tool));
    },
  };
}

// A file's content, or undefined when it does not exist.
async function orNone<T>(reading: Promise<T>): Promise<T | undefined> {
  try {
    return await reading;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
