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
import { listJson, readJson } from "./files.ts";
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
};

export async function openBaselines(root: string): Promise<Baselines> {
  const dir = join(root, ".workflows", "baselines");
  const pinned = new Map<string, Baseline>();
  for (const file of await listJson(dir)) {
    const path = join(dir, file);
    const parsed = baselineSchema.safeParse(await readJson(path));
    if (!parsed.success) {
      throw new Error(
        `${path} is not a valid Baseline:\n${z.prettifyError(parsed.error)}`
      );
    }
    // zod leaves absent keys absent, so the data fits exact optional types.
    pinned.set(
      baselineKey(parsed.data.server, parsed.data.tool),
      parsed.data as Baseline
    );
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
    pinned.set(id, baseline);
    observed.delete(id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, toolFileName(baseline.server, baseline.tool)),
      `${JSON.stringify(baseline, null, 2)}\n`
    );
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
  };
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
