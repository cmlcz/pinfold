import { readFile, writeFile } from "node:fs/promises";
import * as z from "zod";
import type { Limits } from "../../sandbox/index.ts";

const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});

const toolKindSchema = z.enum(["read", "write"]);

const configSchema = z.object({
  /** Downstream Servers by name; a server's Tools appear as `sdk.<name>.<tool>`. */
  servers: z.record(
    z.string().regex(/^[A-Za-z_$][\w$]*$/, "must be a JavaScript identifier"),
    serverSchema
  ),
  /**
   * The developer's Tool classification by server and Tool. A Tool not
   * classified as "read" is a Write Tool (ADR 0004).
   */
  classification: z
    .record(z.string(), z.record(z.string(), toolKindSchema))
    .optional(),
  /** Per-run limits; each one left out takes its default. */
  limits: z
    .object({
      timeoutMs: z.number().int().positive(),
      memoryBytes: z.number().int().positive(),
      toolCalls: z.number().int().nonnegative(),
    })
    .partial()
    .optional(),
});

export type ServerConfig = z.infer<typeof serverSchema>;
export type ToolKind = z.infer<typeof toolKindSchema>;
export type PinfoldConfig = z.infer<typeof configSchema>;

const defaultLimits: Limits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  toolCalls: 100,
};

export function resolveLimits(config: PinfoldConfig): Limits {
  const limits = config.limits ?? {};
  return {
    timeoutMs: limits.timeoutMs ?? defaultLimits.timeoutMs,
    memoryBytes: limits.memoryBytes ?? defaultLimits.memoryBytes,
    toolCalls: limits.toolCalls ?? defaultLimits.toolCalls,
  };
}

/** Records the developer's Tool classification in the config file. */
export async function classifyTools(
  path: string,
  choices: { server: string; tool: string; kind: ToolKind }[]
): Promise<void> {
  const json = JSON.parse(
    await readFile(path, "utf8")
  ) as Partial<PinfoldConfig>;
  json.classification ??= {};
  for (const { server, tool, kind } of choices) {
    (json.classification[server] ??= {})[tool] = kind;
  }
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
}

export async function loadConfig(path: string): Promise<PinfoldConfig> {
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${path} is not a valid pinfold config:\n${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}
