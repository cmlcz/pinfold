// Repair: a new version of a drifted Tool's Response Adapter (ADR 0001).
// Deterministic search comes first and needs no model. For each field the
// Drift touches, it tries the ops of the closed set that could map the live
// responses back to the Baseline, keeps those that do, and scores them by
// how alike the field names are and how well the values agree with the
// Fixtures. It proposes a mapping only where one candidate stands out.
// Repairs it writes, and Drift it cannot settle, are kept under .pinfold/.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { applyOps, type Op } from "./adapters.ts";
import { splitToolName, toolFileName } from "./baselines.ts";
import {
  isMissing,
  mismatches,
  touches,
  touching,
  uniqueMismatches,
  type Mismatch,
} from "./drift.ts";
import {
  childPath,
  formatPath,
  isPrimitive,
  isRecord,
  parsePath,
  redacted,
  valuesAt,
  type Step,
} from "./paths.ts";
import { listJson, prepareState, readOrNone, safeJson } from "./files.ts";
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

/** A drifted Tool, as Repair sees it. */
export type DriftedTool = {
  baseline: JsonSchema;
  /** The ops of the Tool's Adapter now. */
  ops: Op[];
  /** The live responses of the run, as the server sent them. */
  responses: Call[];
  /**
   * The field paths each saved Workflow reads of the Tool, and those the run
   * that drifted read.
   */
  contracts: string[][];
  /** The Tool's calls in the Fixtures, whose responses fit the Baseline. */
  fixtures: Call[];
};

/**
 * Searches for ops that, added to a Tool's Adapter, map its live responses
 * back to its Baseline wherever a saved Workflow reads them.
 */
export function searchRepair(drift: DriftedTool): RepairSearch {
  const { baseline, ops, responses } = drift;
  const reads = [...new Set(drift.contracts.flat())];
  const driftedWith = drifting(drift);
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

  const checked = checkRepair(drift, chosen);
  if (!checked.ok) {
    return {
      kind: "pending",
      reason: "the mappings found do not repair every field together",
    };
  }
  return {
    kind: "repaired",
    ops: [...ops, ...chosen],
    evidence: checked.evidence,
  };
}

/**
 * Checks ops added to a drifted Tool's Adapter, as every Repair is checked,
 * whoever found it: through the Adapter's ops and these, the live responses
 * fit the Baseline wherever a saved Workflow reads them. Returns the value
 * evidence for the Approval view, or the mismatches left. With
 * `redactedFits`, the responses are recorded ones, redacted.
 */
export function checkRepair(
  drift: DriftedTool,
  added: Op[],
  options: { redactedFits?: boolean } = {}
): { ok: true; evidence: string[] } | { ok: false; drifted: Mismatch[] } {
  const driftedWith = drifting(drift, options);
  const final = [...drift.ops, ...added];
  const drifted = driftedWith(final);
  if (drifted.length > 0) return { ok: false, drifted };
  const targets = driftedWith(drift.ops);
  const adapted = drift.responses.map(({ response }) =>
    applyOps(final, response)
  );
  const history = historyOf(drift.fixtures, drift.responses);
  const evidence = [...new Set(drift.contracts.flat())]
    .filter((read) => targets.some((target) => touches(target.path, read)))
    .map(
      (read) =>
        `${read}: now ${summarize(valuesIn(adapted, read))}; in the Fixtures ${summarize(valuesIn(history, read))}`
    );
  return { ok: true, evidence };
}

// The mismatches of the live responses through some ops that touch a field
// a saved Workflow reads. One that touches none of the reads touches no
// Contract, so responses without such mismatches satisfy every affected
// Contract.
function drifting(
  drift: DriftedTool,
  options: { redactedFits?: boolean } = {}
): (trial: Op[]) => Mismatch[] {
  const reads = [...new Set(drift.contracts.flat())];
  return (trial) =>
    uniqueMismatches(
      drift.responses.flatMap(({ response }) =>
        touching(
          mismatches(drift.baseline, applyOps(trial, response), options),
          reads
        )
      )
    );
}

/** Pending Drift, with what an agent needs to propose ops for it. */
export type RepairTask = PendingDrift & {
  /** The Tool's Baseline response shape. */
  baseline: JsonSchema;
  /** The ops of the Tool's Adapter now. */
  ops: Op[];
  /** The field paths the Workflows read of the Tool. */
  reads: string[];
  /** One line per field read the Drift touches: its values in the Fixtures. */
  fixtureValues: string[];
};

export function repairTask(
  pending: PendingDrift,
  drift: Omit<DriftedTool, "responses">
): RepairTask {
  const reads = [...new Set(drift.contracts.flat())].sort();
  const history = historyOf(drift.fixtures, pending.responses);
  const fixtureValues = reads
    .filter((read) =>
      pending.mismatches.some((mismatch) => touches(mismatch.path, read))
    )
    .map((read) => `${read}: ${summarize(valuesIn(history, read))}`);
  return {
    ...pending,
    baseline: drift.baseline,
    ops: drift.ops,
    reads,
    fixtureValues,
  };
}

/**
 * A copy of a drifted response that keeps only the values sitting where the
 * Baseline lists a field. Redaction rules name fields where the Baseline
 * has them, so they cannot be known to reach a value the Drift moved or
 * renamed: such a value is redacted, and only its shape is kept.
 */
export function redactUnlisted(
  baseline: JsonSchema,
  response: unknown
): unknown {
  return keepListed([baseline], response);
}

function keepListed(
  schemas: (JsonSchema | boolean)[],
  value: unknown
): unknown {
  const options = schemas.flatMap(unionOptions);
  if (options.length === 0) return redactLeaves(value);
  // A schema that says nothing of what is inside a value describes all of it.
  if (options.some(opaque)) return value;
  if (Array.isArray(value)) {
    const items = options.flatMap((schema) => [
      ...(Array.isArray(schema.prefixItems) ? schema.prefixItems : []),
      schema.items ?? true,
    ]);
    return value.map((item) => keepListed(items, item));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      const fields = options.flatMap((schema) => {
        const properties = schema.properties ?? {};
        if (Object.hasOwn(properties, key)) return [properties[key]!];
        // The keys of a map are data, so each one is listed.
        const additional = schema.additionalProperties;
        return additional === true ||
          (typeof additional === "object" && additional !== null)
          ? [additional]
          : [];
      });
      return [key, keepListed(fields, inner)];
    })
  );
}

// The options of a union, each a schema; true allows anything, as {} does.
function unionOptions(schema: JsonSchema | boolean): JsonSchema[] {
  if (schema === false) return [];
  if (schema === true) return [{}];
  return Array.isArray(schema.anyOf)
    ? schema.anyOf.flatMap(unionOptions)
    : [schema];
}

function opaque(schema: JsonSchema): boolean {
  return (
    schema.properties === undefined &&
    schema.additionalProperties === undefined &&
    schema.items === undefined &&
    schema.prefixItems === undefined
  );
}

function redactLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (!isRecord(value)) return redacted;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, redactLeaves(inner)])
  );
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

function same(a: Mismatch, b: Mismatch): boolean {
  return a.path === b.path && a.problem === b.problem;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** A Repair pinfold wrote, kept for the Approval view of later runs. */
export type RepairRecord = {
  /** The Tool, as `server.tool`. */
  tool: string;
  /** Who found it: deterministic search, or an agent through propose_repair. */
  by: "pinfold" | "agent";
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
  /** The fields the run that found it read of the Tool. */
  reads: string[];
  reason: string;
  /**
   * The Tool's calls in the run, as the server answered them, redacted like
   * Fixtures. A Repair proposed later is checked against them.
   */
  responses: Call[];
};

const callSchema = z.object({ arguments: z.json(), response: z.json() });

const recordSchema = z.object({
  tool: z.string(),
  by: z.enum(["pinfold", "agent"]).default("pinfold"),
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
  reads: z.array(z.string()).default([]),
  reason: z.string(),
  responses: z.array(callSchema).default([]),
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
  type Dir = "repairs" | "drift";
  const file = (dir: Dir, name: string) => {
    const { server, tool } = splitToolName(name);
    return join(root, ".pinfold", dir, toolFileName(server, tool));
  };
  const write = async (dir: Dir, tool: string, value: unknown) => {
    await prepareState(root, dir);
    await writeFile(file(dir, tool), `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    async get(tool, digest) {
      const text = await readOrNone(file("repairs", tool));
      const parsed = recordSchema.safeParse(text && safeJson(text));
      return parsed.success && parsed.data.digest === digest
        ? parsed.data
        : undefined;
    },
    async record(repair) {
      await write("repairs", repair.tool, repair);
      await rm(file("drift", repair.tool), { force: true });
    },
    pend: (pending) => write("drift", pending.tool, pending),
    settle: (tool) => rm(file("drift", tool), { force: true }),
    async pending() {
      const found: PendingDrift[] = [];
      const drift = join(root, ".pinfold", "drift");
      for (const name of await listJson(drift)) {
        // Settled since the listing, or damaged: either way not pending.
        const text = await readOrNone(join(drift, name));
        const parsed = pendingSchema.safeParse(text && safeJson(text));
        if (parsed.success) found.push(parsed.data);
      }
      return found.sort((a, b) => a.tool.localeCompare(b.tool));
    },
  };
}
