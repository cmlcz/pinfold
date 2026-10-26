// Baselines: each Tool's shape, pinned on first use in committed files
// under .workflows/baselines/ (ADR 0001).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  forPinning,
  inferSchema,
  isFullyObserved,
  mergeSchemas,
  type JsonSchema,
  type Shape,
} from "./schema.ts";
import { mismatches } from "./drift.ts";
import { listJson, readJson } from "./files.ts";
import { parsePath, schemasAt } from "./paths.ts";
import { shortHash } from "./plan.ts";
import type { SdkTool } from "./sdk.ts";

const baselineSchema = z.object({
  server: z.string(),
  tool: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/** A pinned Tool: unlike a live listing, its response shape is always known. */
type Baseline = SdkTool & { outputSchema: JsonSchema };

export type Baselines = {
  get(server: string, tool: string): Baseline | undefined;
  /**
   * Records a response from a successful call, pinning the Tool's Baseline
   * once its response shape is known: declared, or observed well enough.
   */
  record(tool: SdkTool, response: unknown): Promise<void>;
  /**
   * Pins a Tool's Baseline anew from its listing and this response shape,
   * in place of the one it has: a Baseline Migration.
   */
  repin(tool: SdkTool, outputSchema: JsonSchema): Promise<void>;
};

export async function openBaselines(root: string): Promise<Baselines> {
  const dir = join(root, ".workflows", "baselines");
  const pinned = new Map<string, Baseline>();
  // The file each pinned Baseline is in, which a re-pin writes again.
  const files = new Map<string, string>();
  for (const file of await listJson(dir)) {
    const path = join(dir, file);
    const parsed = baselineSchema.safeParse(await readJson(path));
    if (!parsed.success) {
      throw new Error(
        `${path} is not a valid Baseline:\n${z.prettifyError(parsed.error)}`
      );
    }
    // zod leaves absent keys absent, so the data fits exact optional types.
    const id = baselineKey(parsed.data.server, parsed.data.tool);
    pinned.set(id, parsed.data as Baseline);
    files.set(id, path);
  }

  // Inferred shapes of Tools whose responses have not shown enough yet.
  const observed = new Map<string, Shape>();

  async function pin(tool: SdkTool, outputSchema: JsonSchema) {
    const id = baselineKey(tool.server, tool.tool);
    // Parsing drops anything beyond the Baseline's own fields.
    const baseline = baselineSchema.parse({
      ...tool,
      outputSchema,
    }) as Baseline;
    const file =
      files.get(id) ?? join(dir, toolFileName(baseline.server, baseline.tool));
    pinned.set(id, baseline);
    files.set(id, file);
    observed.delete(id);
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(baseline, null, 2)}\n`);
  }

  return {
    get: (server, tool) => pinned.get(baselineKey(server, tool)),
    async record(tool, response) {
      const id = baselineKey(tool.server, tool.tool);
      if (pinned.has(id)) return;
      if (tool.outputSchema !== undefined) return pin(tool, tool.outputSchema);
      // Plain text, an empty answer or a bare number says nothing reliable
      // about the shape of the Tool's later responses.
      if (typeof response !== "object" || response === null) return;
      const merged = mergeSchemas(observed.get(id), inferSchema(response));
      if (isFullyObserved(merged)) return pin(tool, forPinning(merged));
      observed.set(id, merged);
    },
    repin: pin,
  };
}

/**
 * Makes a field of a Tool's pinned Baseline optional, a small Baseline
 * Migration: the field may then be missing, or null. One response cannot
 * show that a field is optional, so a Baseline pinned from one may need it.
 * `name` is the Tool as `server.tool`; `path` a field path such as
 * `issues[].assignee`.
 */
export async function makeFieldOptional(
  root: string,
  name: string,
  path: string
): Promise<void> {
  const steps = parsePath(path);
  const last = steps?.at(-1);
  if (steps === undefined || last === undefined || "each" in last) {
    throw new Error(
      `${path} is not a field path that ends in a field, such as issues[].assignee`
    );
  }
  const dir = join(root, ".workflows", "baselines");
  const { server, tool } = splitToolName(name);
  for (const file of await listJson(dir)) {
    const parsed = baselineSchema.safeParse(await readJson(join(dir, file)));
    if (!parsed.success) continue;
    const baseline = parsed.data;
    if (baseline.server !== server || baseline.tool !== tool) continue;
    const parents = schemasAt(baseline.outputSchema, steps.slice(0, -1));
    const holding = parents.filter(
      ({ properties }) =>
        properties !== undefined && Object.hasOwn(properties, last.key)
    );
    if (holding.length === 0) {
      throw new Error(`The Baseline of ${name} has no field ${path}`);
    }
    for (const parent of holding) {
      if (parent.required !== undefined) {
        parent.required = parent.required.filter((key) => key !== last.key);
      }
      parent.properties![last.key] = orNull(parent.properties![last.key]!);
    }
    await writeFile(join(dir, file), `${JSON.stringify(baseline, null, 2)}\n`);
    return;
  }
  throw new Error(`${name} has no Baseline`);
}

// A schema that allows null too.
function orNull(schema: JsonSchema | boolean): JsonSchema | boolean {
  if (typeof schema === "boolean" || mismatches(schema, null).length === 0) {
    return schema;
  }
  return { anyOf: [schema, { type: "null" }] };
}

function baselineKey(server: string, tool: string): string {
  return `${server}\0${tool}`;
}

/** A Tool's name as the SDK and the Workflows write it: `server.tool`. */
export function toolName(tool: { server: string; tool: string }): string {
  return `${tool.server}.${tool.tool}`;
}

/** A name written `server.tool`, apart; a server's name has no dot. */
export function splitToolName(name: string): { server: string; tool: string } {
  const [server = "", ...rest] = name.split(".");
  return { server, tool: rest.join(".") };
}

/**
 * The file name for a Tool's file. Tool names come from Downstream Servers,
 * so only a short, safe part of the name is kept, for people to read; the
 * file itself holds the exact name. A hash of the exact names keeps apart
 * names that differ only in case, or in the characters left out.
 */
export function toolFileName(server: string, tool: string): string {
  const readable = `${server}.${tool}`.replace(/[^\w.-]/g, "_").slice(0, 64);
  return `${readable}.${shortHash(baselineKey(server, tool))}.json`;
}
