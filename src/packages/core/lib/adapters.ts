// Response Adapters: per Tool, versioned, declarative mappings from a Tool's
// live response back to its Baseline, in committed files under
// .workflows/adapters/ (ADR 0001). Each file holds one Adapter:
//
//   { "server": "sentry", "tool": "listIssues", "version": 2,
//     "ops": [{ "op": "rename", "from": "issues[].eventCount",
//               "to": "issues[].count" }] }
//
// The ops run in order, each on the result of the one before. Paths are
// field paths into the response; a path that starts nowhere, such as the
// `at` of a wrap left out, is the whole response.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { toolFileName, toolName } from "./baselines.ts";
import { listJson, readJson } from "./files.ts";
import { canonicalize, shortHash } from "./plan.ts";
import { isPrimitive, isRecord, parsePath, type Step } from "./paths.ts";

// A field path that ends in a field, which an op can replace or remove.
const fieldPath = z.string().refine(
  (path) => {
    const last = parsePath(path)?.at(-1);
    return last !== undefined && "key" in last;
  },
  { error: "must be a field path that ends in a field, such as issues[].count" }
);

const opSchema = z.discriminatedUnion("op", [
  /** Moves a field, within the same element of every array on its way. */
  z
    .strictObject({ op: z.literal("rename"), from: fieldPath, to: fieldPath })
    .refine(({ from, to }) => sameArrays(from, to), {
      error: "must move a field within the same array elements",
    }),
  /** Puts the value at `at` under the field `field`. */
  z.strictObject({
    op: z.literal("wrap"),
    at: fieldPath.optional(),
    field: z.string().min(1),
  }),
  /** Replaces the value at `at` with its field `field`. */
  z.strictObject({
    op: z.literal("unwrap"),
    at: fieldPath.optional(),
    field: z.string().min(1),
  }),
  /** Converts a value: text to a number and back, an ISO date to epoch ms and back. */
  z.strictObject({
    op: z.literal("convert"),
    path: fieldPath,
    to: z.enum(["number", "string", "epoch-ms", "iso-date"]),
  }),
  /** Maps enum values: a value named in `values` becomes the value it maps to. */
  z.strictObject({
    op: z.literal("map"),
    path: fieldPath,
    values: z.record(z.string(), z.json()),
  }),
  /** Gives a field that is missing a value. */
  z.strictObject({
    op: z.literal("default"),
    path: fieldPath,
    value: z.json(),
  }),
]);

const adapterSchema = z.strictObject({
  server: z.string(),
  tool: z.string(),
  version: z.int().positive(),
  ops: z.array(opSchema),
});

export type Op = z.infer<typeof opSchema>;

/** Reads ops of the closed set, as an Adapter file holds them. */
export function parseOps(
  value: unknown
): { ok: true; ops: Op[] } | { ok: false; error: string } {
  const parsed = z.array(opSchema).safeParse(value);
  return parsed.success
    ? { ok: true, ops: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

type ResponseAdapter = z.infer<typeof adapterSchema> & {
  /** Changes whenever the Adapter does, by its version or its ops. */
  digest: string;
  /** The file it is in. */
  path: string;
};

export type Adapters = {
  /** The digest of the Adapter of each of these Tools that has one. */
  digests(tools: string[]): Record<string, string>;
  /** The response mapped by the Tool's Adapter; as it is, for a Tool without one. */
  adapt(tool: string, response: unknown): unknown;
  /** The Tool's Adapter, as `server.tool`; undefined for a Tool without one. */
  get(tool: string): ResponseAdapter | undefined;
};

/**
 * Reads the Response Adapters, which the developer may have written since
 * the last run.
 */
export async function loadAdapters(root: string): Promise<Adapters> {
  const dir = join(root, ".workflows", "adapters");
  const adapters = new Map<string, ResponseAdapter>();
  for (const file of await listJson(dir)) {
    const path = join(dir, file);
    const parsed = adapterSchema.safeParse(await readJson(path));
    if (!parsed.success) {
      throw new Error(
        `${path} is not a valid Response Adapter:\n${z.prettifyError(parsed.error)}`
      );
    }
    const { version, ops } = parsed.data;
    const name = toolName(parsed.data);
    if (adapters.has(name)) {
      throw new Error(`${path} is a second Response Adapter for ${name}`);
    }
    adapters.set(name, {
      ...parsed.data,
      digest: digestOf(version, ops),
      path,
    });
  }
  return {
    digests: (tools) =>
      Object.fromEntries(
        tools.flatMap((tool) => {
          const adapter = adapters.get(tool);
          return adapter === undefined ? [] : [[tool, adapter.digest]];
        })
      ),
    adapt(tool, response) {
      const adapter = adapters.get(tool);
      return adapter === undefined ? response : applyOps(adapter.ops, response);
    },
    get: (tool) => adapters.get(tool),
  };
}

/**
 * Writes a new version of a Tool's Adapter to its file, or to a new file for
 * a Tool without one. Returns its digest.
 */
export async function writeAdapter(
  root: string,
  adapter: z.infer<typeof adapterSchema>,
  path?: string
): Promise<string> {
  const dir = join(root, ".workflows", "adapters");
  const parsed = adapterSchema.parse(adapter);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path ?? join(dir, toolFileName(parsed.server, parsed.tool)),
    `${JSON.stringify(parsed, null, 2)}\n`
  );
  return digestOf(parsed.version, parsed.ops);
}

function digestOf(version: number, ops: Op[]): string {
  return shortHash(JSON.stringify(canonicalize({ version, ops })));
}

/** A copy of a response mapped by some ops, in order. */
export function applyOps(ops: Op[], response: unknown): unknown {
  return ops.reduce(applyOp, structuredClone(response));
}

function applyOp(value: unknown, op: Op): unknown {
  switch (op.op) {
    case "rename": {
      const from = steps(op.from);
      const to = steps(op.to);
      const shared = lastEach(from) + 1;
      return eachValue(value, from.slice(0, shared), (element) => {
        const moved = take(element, from.slice(shared));
        if (moved.found) put(element, to.slice(shared), moved.value);
      });
    }
    case "wrap":
      return replace(value, op.at, (inner) => ({ [op.field]: inner }));
    case "unwrap":
      return replace(value, op.at, (inner) =>
        isRecord(inner) && Object.hasOwn(inner, op.field)
          ? inner[op.field]
          : inner
      );
    case "convert":
      return replace(value, op.path, (inner) => convert(inner, op.to));
    case "map":
      return replace(value, op.path, (inner) => {
        const key = isPrimitive(inner) ? String(inner) : undefined;
        return key !== undefined && Object.hasOwn(op.values, key)
          ? op.values[key]
          : inner;
      });
    case "default":
      return eachField(value, steps(op.path), (parent, key) => {
        if (!Object.hasOwn(parent, key)) {
          parent[key] = structuredClone(op.value);
        }
      });
  }
}

function convert(
  value: unknown,
  to: Extract<Op, { op: "convert" }>["to"]
): unknown {
  switch (to) {
    case "number":
      return typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
        ? Number(value)
        : value;
    case "string":
      return typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value;
    case "epoch-ms": {
      const ms = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isNaN(ms) ? value : ms;
    }
    case "iso-date":
      return typeof value === "number" && Number.isFinite(value)
        ? new Date(value).toISOString()
        : value;
  }
}

// Replaces the value a path names, or the whole value when there is no path.
// A field that is missing stays missing.
function replace(
  value: unknown,
  path: string | undefined,
  by: (inner: unknown) => unknown
): unknown {
  if (path === undefined) return by(value);
  return eachField(value, steps(path), (parent, key) => {
    if (Object.hasOwn(parent, key)) parent[key] = by(parent[key]);
  });
}

// Calls `at` with every object and field a path names, through every element
// of each array on the way. Returns the value, changed in place.
function eachField(
  value: unknown,
  path: Step[],
  at: (parent: Record<string, unknown>, key: string) => void
): unknown {
  const last = path.at(-1) as { key: string };
  eachValue(value, path.slice(0, -1), (parent) => {
    if (isRecord(parent)) at(parent, last.key);
  });
  return value;
}

// Calls `at` with every value a path reaches. Returns the value, changed in
// place.
function eachValue(
  value: unknown,
  path: Step[],
  at: (inner: unknown) => void
): unknown {
  const [step, ...rest] = path;
  if (step === undefined) at(value);
  else if ("each" in step) {
    if (Array.isArray(value)) {
      for (const item of value) eachValue(item, rest, at);
    }
  } else if (isRecord(value) && Object.hasOwn(value, step.key)) {
    eachValue(value[step.key], rest, at);
  }
  return value;
}

// Removes the field a path without arrays names, and returns its value.
function take(
  value: unknown,
  path: Step[]
): { found: true; value: unknown } | { found: false } {
  const parents = path.slice(0, -1) as { key: string }[];
  const { key } = path.at(-1) as { key: string };
  let parent = value;
  for (const step of parents) {
    if (!isRecord(parent) || !Object.hasOwn(parent, step.key)) {
      return { found: false };
    }
    parent = parent[step.key];
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) return { found: false };
  const taken = parent[key];
  delete parent[key];
  return { found: true, value: taken };
}

// Sets the field a path without arrays names, adding the objects on its way.
function put(value: unknown, path: Step[], field: unknown): void {
  const parents = path.slice(0, -1) as { key: string }[];
  const { key } = path.at(-1) as { key: string };
  let parent = value;
  for (const step of parents) {
    if (!isRecord(parent)) return;
    if (!isRecord(parent[step.key])) parent[step.key] = {};
    parent = parent[step.key];
  }
  if (isRecord(parent)) parent[key] = field;
}

// Paths of a rename go through the same arrays: up to the last [] of either,
// their steps are equal, and neither has a [] after it.
function sameArrays(from: string, to: string): boolean {
  const a = steps(from);
  const b = steps(to);
  const shared = lastEach(a);
  return (
    shared === lastEach(b) &&
    JSON.stringify(a.slice(0, shared + 1)) ===
      JSON.stringify(b.slice(0, shared + 1))
  );
}

function lastEach(path: Step[]): number {
  return path.findLastIndex((step) => "each" in step);
}

function steps(path: string): Step[] {
  return parsePath(path) ?? [];
}
