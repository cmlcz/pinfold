// Baseline Migration: a Tool moved, at the developer's word, to the shape
// its Downstream Server gives it now (ADR 0008). The new shape comes from
// live responses, since a server's listing may lag behind what it sends.
// Every Workflow that calls the Tool is checked against the new Baseline,
// and the Tool's Response Adapter is reset as a new version, so the next
// run of each of them waits for Approval.
import { join } from "node:path";
import { typecheck } from "../../sandbox/index.ts";
import { loadAdapters, writeAdapter, type Adapters } from "./adapters.ts";
import { toolName } from "./baselines.ts";
import type { DownstreamTool } from "./downstream.ts";
import { mismatches } from "./drift.ts";
import { readOrNone } from "./files.ts";
import type { Failed } from "./outcome.ts";
import { canonicalize } from "./plan.ts";
import { childPath, isRecord, redacted, shapeLists } from "./paths.ts";
import type { Project } from "./project.ts";
import {
  forPinning,
  inferSchema,
  isFullyObserved,
  mergeSchemas,
  type JsonSchema,
  type Shape,
} from "./schema.ts";
import { declarations } from "./sdk.ts";
import { fixtureCalls, savedContracts } from "./workflows.ts";

export type MigrationResult =
  | Failed
  | {
      ok: true;
      tool: string;
      /**
       * One line per field of its arguments or response whose shape
       * changes, as `+`, `-` or `~` and a path such as
       * `response.issues[].count`.
       */
      changes: string[];
      /**
       * Each saved Workflow that calls the Tool, with what of it does not
       * check against the new Baseline: its types and its Contract.
       */
      workflows: { name: string; problems: string[] }[];
      /**
       * `current` when the Baseline is the live shape already, `preview`
       * when nothing was changed, `migrated` when the Baseline was re-pinned.
       */
      status: "current" | "preview" | "migrated";
      /** The Response Adapter version the migration wrote, with no ops. */
      adapter?: number;
    };

/**
 * Moves a Tool's Baseline to the shape its server gives it now. Unless
 * `confirmed`, it only shows what would change, and changes nothing.
 */
export async function migrateBaseline(
  project: Project,
  { tool: name, confirmed }: { tool: string; confirmed: boolean }
): Promise<MigrationResult> {
  const refuse = (error: string): Failed => ({
    ok: false,
    error: `Baseline of ${name} not migrated: ${error}.`,
  });
  const tool = project.tools.get(name);
  if (tool === undefined) return refuse("no Downstream Server offers it");
  const current = project.baselines.get(tool.server, tool.tool);
  if (current === undefined) {
    return refuse(
      "it has no Baseline yet; the first run that calls it pins one"
    );
  }
  const live = await liveShape(project, tool);
  if (!live.ok) return refuse(live.error);

  const changes = [
    ...shapeChanges(current.inputSchema, tool.inputSchema, "arguments"),
    ...shapeChanges(current.outputSchema, live.schema, "response"),
  ];
  const same =
    JSON.stringify(
      canonicalize([current.inputSchema, current.outputSchema])
    ) === JSON.stringify(canonicalize([tool.inputSchema, live.schema]));
  if (same) {
    return { ok: true, tool: name, changes, workflows: [], status: "current" };
  }
  const workflows = await recheck(project, tool, live.schema);
  if (!confirmed) {
    return { ok: true, tool: name, changes, workflows, status: "preview" };
  }

  let adapters: Adapters;
  try {
    adapters = await loadAdapters(project.root);
  } catch (error) {
    return refuse((error as Error).message);
  }
  await project.baselines.repin(tool, live.schema);
  // The Adapter mapped live responses back to the old Baseline; the new one
  // is the live shape, so none of its ops is needed.
  const old = adapters.get(name);
  const version = (old?.version ?? 0) + 1;
  const digest = await writeAdapter(
    project.root,
    { server: tool.server, tool: tool.tool, version, ops: [] },
    old?.path
  );
  // Kept for the Approval view, which settles the Tool's pending Drift too:
  // it was Drift from the old Baseline.
  await project.repairs.record({
    tool: name,
    by: "migration",
    digest,
    version,
    diff: (old?.ops ?? []).map((op) => `- ${JSON.stringify(op)}`),
    evidence: changes,
  });
  return {
    ok: true,
    tool: name,
    changes,
    workflows,
    status: "migrated",
    adapter: version,
  };
}

// The shape a Tool's responses have now. A Read Tool is called again with
// the arguments of its calls in the Fixtures; its listed output schema is
// kept if every response fits it. A Write Tool is never called, so only its
// listing can say.
async function liveShape(
  project: Project,
  tool: DownstreamTool
): Promise<{ ok: true; schema: JsonSchema } | { ok: false; error: string }> {
  const listed = tool.outputSchema;
  if (!project.isRead(tool)) {
    return listed === undefined
      ? {
          ok: false,
          error:
            "it is a Write Tool, which pinfold never calls to see its shape, and its server lists no output schema for it",
        }
      : { ok: true, schema: listed };
  }
  const calls = new Map<string, unknown>();
  for (const call of await fixtureCalls(project.root, toolName(tool))) {
    // A redacted argument would ask for something else than the call did.
    if (holdsRedacted(call.arguments)) continue;
    calls.set(JSON.stringify(canonicalize(call.arguments)), call.arguments);
  }
  if (calls.size === 0) {
    return {
      ok: false,
      error:
        "the Fixtures hold no call of it whose arguments pinfold can send again, as redaction kept them out",
    };
  }
  const responses: unknown[] = [];
  for (const args of calls.values()) {
    try {
      responses.push(await tool.call(args));
    } catch (error) {
      return {
        ok: false,
        error: `calling it failed: ${(error as Error).message}`,
      };
    }
  }
  if (
    listed !== undefined &&
    responses.every((response) => mismatches(listed, response).length === 0)
  ) {
    return { ok: true, schema: listed };
  }
  if (!responses.every(isRecord)) {
    return {
      ok: false,
      error:
        "its live responses are not all JSON objects, so they show no shape to pin",
    };
  }
  const shape = responses
    .map(inferSchema)
    .reduce<Shape | undefined>(mergeSchemas, undefined)!;
  if (!isFullyObserved(shape)) {
    return {
      ok: false,
      error:
        "its live responses do not show its whole shape yet, such as what an empty list holds",
    };
  }
  return {
    ok: true,
    schema: keepFitting(
      project.baselines.get(tool.server, tool.tool)?.outputSchema,
      forPinning(shape),
      responses
    ),
  };
}

// The live shape, keeping the old Baseline's schema of each field whose live
// values all still fit it, such as an enum, so that a migration changes only
// what the server changed. Objects and arrays are built from the live shape,
// so a field the server added is listed.
function keepFitting(
  old: JsonSchema | boolean | undefined,
  shape: Shape,
  values: unknown[]
): JsonSchema {
  if (old === undefined || typeof old === "boolean") return shape;
  if (shape.type === "object" && shape.properties !== undefined) {
    const records = values.filter(isRecord);
    const before = old.type === "object" ? (old.properties ?? {}) : {};
    return {
      ...shape,
      properties: Object.fromEntries(
        Object.entries(shape.properties).map(([key, field]) => [
          key,
          keepFitting(
            Object.hasOwn(before, key) ? before[key] : undefined,
            field,
            records.flatMap((record) =>
              Object.hasOwn(record, key) ? [record[key]] : []
            )
          ),
        ])
      ),
    };
  }
  if (shape.type === "array") {
    return {
      ...shape,
      items: keepFitting(
        old.type === "array" ? old.items : undefined,
        shape.items ?? {},
        values.flatMap((value) => (Array.isArray(value) ? value : []))
      ),
    };
  }
  return values.every((value) => mismatches(old, value).length === 0)
    ? old
    : shape;
}

function holdsRedacted(value: unknown): boolean {
  if (value === redacted) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(holdsRedacted);
}

// Each saved Workflow that calls the Tool, checked against the new Baseline:
// its code against the SDK as the Baseline would describe the Tool, and its
// Contract against the fields the Baseline lists.
async function recheck(
  project: Project,
  tool: DownstreamTool,
  outputSchema: JsonSchema
): Promise<{ name: string; problems: string[] }[]> {
  const name = toolName(tool);
  const sdk = declarations(
    project
      .sdkTools()
      .map((known) =>
        toolName(known) === name
          ? { ...known, inputSchema: tool.inputSchema, outputSchema }
          : known
      )
  );
  const checked = [];
  for (const workflow of await savedContracts(project.root)) {
    if (!workflow.tools.includes(name)) continue;
    const source = await readOrNone(
      join(project.root, ".workflows", `${workflow.name}.ts`)
    );
    const reads = Object.hasOwn(workflow.contract, name)
      ? workflow.contract[name]!
      : [];
    const problems = [
      ...(source === undefined
        ? [`.workflows/${workflow.name}.ts is missing`]
        : await typecheck(source, sdk)),
      ...reads
        .filter((path) => !shapeLists(outputSchema, path))
        .map(
          (path) => `it reads ${path}, which the new Baseline does not have`
        ),
    ];
    checked.push({ name: workflow.name, problems });
  }
  return checked;
}

/**
 * The fields whose shape differs between two schemas, one line each: `+`
 * for a field only the new one has, `-` for one only the old one has, and
 * `~` for one whose kind changed. `root` names the whole value.
 */
export function shapeChanges(
  before: JsonSchema,
  after: JsonSchema,
  root: string
): string[] {
  const old = fieldKinds(before, root);
  const now = fieldKinds(after, root);
  const lines: string[] = [];
  for (const [path, kind] of old) {
    const next = now.get(path);
    if (next === undefined) lines.push(`- ${path}: ${kind}`);
    else if (next !== kind) lines.push(`~ ${path}: ${kind}, now ${next}`);
  }
  for (const [path, kind] of now) {
    if (!old.has(path)) lines.push(`+ ${path}: ${kind}`);
  }
  return lines;
}

// Every field path of a schema with its kind, such as `number`,
// `object[]` or `string, optional`, through objects, arrays and unions.
function fieldKinds(schema: JsonSchema, root: string): Map<string, string> {
  const kinds = new Map<string, string>([[root, kindOf(schema)]]);
  const note = (path: string, kind: string) => {
    const known = kinds.get(path);
    kinds.set(path, known === undefined ? kind : `${known} | ${kind}`);
  };
  const visit = (inner: JsonSchema | boolean, path: string) => {
    if (typeof inner === "boolean") return;
    for (const option of inner.anyOf ?? []) visit(option, path);
    if (inner.items !== undefined) visit(inner.items, `${path}[]`);
    const required = new Set(inner.required ?? []);
    for (const [key, field] of Object.entries(inner.properties ?? {})) {
      const at = childPath(path, key);
      note(at, `${kindOf(field)}${required.has(key) ? "" : ", optional"}`);
      visit(field, at);
    }
  };
  visit(schema, root);
  return kinds;
}

// A schema's kind in a few words; an object's fields are listed apart.
function kindOf(schema: JsonSchema | boolean): string {
  if (schema === true) return "any";
  if (schema === false) return "never";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return [...new Set(schema.anyOf.map(kindOf))].join(" | ");
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  switch (schema.type) {
    case "array":
      return `${kindOf(schema.items ?? true)}[]`;
    case "object": {
      const values = schema.additionalProperties;
      return schema.properties === undefined && typeof values === "object"
        ? `map of ${kindOf(values)}`
        : "object";
    }
    case undefined:
      return "any";
    default:
      return String(schema.type);
  }
}

/** What the developer reads after a Baseline Migration or its preview. */
export function formatMigration(
  result: Extract<MigrationResult, { ok: true }>
): string {
  const { tool, changes, workflows } = result;
  if (result.status === "current") {
    return `The Baseline of ${tool} is the shape its server gives it now already; nothing to migrate.`;
  }
  const lines = [
    `Baseline of ${tool}, against the shape its server gives it now:`,
    ...(changes.length > 0
      ? changes.map((line) => `  ${line}`)
      : ["  no field changes its shape"]),
  ];
  if (workflows.length === 0) {
    lines.push("No saved Workflow calls it.");
  }
  for (const { name, problems } of workflows) {
    lines.push(
      problems.length === 0
        ? `Workflow ${name}: checks against the new Baseline.`
        : `Workflow ${name}: does not check against the new Baseline:`,
      ...problems.map((problem) => `  ${problem}`)
    );
  }
  lines.push(
    result.status === "migrated"
      ? `Migrated: re-pinned the Baseline of ${tool}, and reset its Response Adapter as version ${result.adapter}, with no ops. The next run of each Workflow that calls it waits for Approval. A gateway that is running uses the new Baseline once restarted.`
      : `Nothing changed yet. \`pinfold baseline migrate ${tool} --yes\` re-pins the Baseline.`
  );
  return lines.join("\n");
}
