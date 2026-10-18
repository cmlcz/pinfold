// Baselines: each Tool's shape, pinned on first use in committed files
// under .workflows/baselines/ (ADR 0001).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { JsonSchema } from "./schema.ts";
import type { SdkTool } from "./sdk.ts";

const baselineSchema = z.object({
  server: z.string(),
  tool: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/** A pinned Tool: unlike a live listing, its response shape is always known. */
export type Baseline = SdkTool & { outputSchema: JsonSchema };

export type Baselines = {
  get(server: string, tool: string): Baseline | undefined;
  /** Pins a Tool's Baseline unless it already has one. */
  pin(baseline: Baseline): Promise<void>;
};

export async function openBaselines(root: string): Promise<Baselines> {
  const dir = join(root, ".workflows", "baselines");
  const pinned = new Map<string, Baseline>();
  for (const file of await listJson(dir)) {
    const path = join(dir, file);
    const parsed = baselineSchema.safeParse(
      JSON.parse(await readFile(path, "utf8"))
    );
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

  return {
    get: (server, tool) => pinned.get(baselineKey(server, tool)),
    async pin(tool) {
      const id = baselineKey(tool.server, tool.tool);
      if (pinned.has(id)) return;
      // Parsing drops anything beyond the Baseline's own fields.
      const baseline = baselineSchema.parse(tool) as Baseline;
      pinned.set(id, baseline);
      await mkdir(dir, { recursive: true });
      // Tool names come from Downstream Servers, so keep them out of the path.
      const file = `${baseline.server}.${encodeURIComponent(baseline.tool)}.json`;
      await writeFile(
        join(dir, file),
        `${JSON.stringify(baseline, null, 2)}\n`
      );
    },
  };
}

function baselineKey(server: string, tool: string): string {
  return `${server}\0${tool}`;
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
