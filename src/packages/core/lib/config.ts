import { readFile, writeFile } from "node:fs/promises";
import * as z from "zod";
import type { Limits } from "../../sandbox/index.ts";
import { parsePath } from "./paths.ts";

// A reference to an environment variable inside a value: ${NAME}.
const envReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// A header or environment value, which may hold such references.
const referencingValue = z
  .string()
  .refine((value) => !value.replace(envReference, "").includes("${"), {
    error: "must reference environment variables as ${NAME}",
  });

const stdioServerSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /**
   * Environment variables set for the server, beside the few it inherits.
   * A secret is passed through by reference, as in `"${SENTRY_TOKEN}"`.
   */
  env: z
    .record(
      z.string().regex(/^[^=\0]+$/, "must be a variable name"),
      referencingValue
    )
    .optional(),
  /** The server's working directory, relative to the project root. */
  cwd: z.string().min(1).optional(),
});

const httpServerSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).refine((url) => {
    const { username, password } = new URL(url);
    return username === "" && password === "";
  }, "must not hold credentials; send them in headers from environment variables"),
  /**
   * Static headers sent with every request. A secret is referenced by its
   * environment variable, as in `"Bearer ${LINEAR_API_KEY}"`, so it never
   * lives in the config file.
   */
  headers: z.record(z.string().min(1), referencingValue).optional(),
});

const serverSchema = z.union([stdioServerSchema, httpServerSchema], {
  error:
    "must be a stdio server with a command or a Streamable HTTP server with a url",
});

const toolKindSchema = z.enum(["read", "write"]);

// A field path into a recorded Tool call: its arguments or its response.
const redactionPath = z.string().refine(
  (path) => {
    const [first] = parsePath(path) ?? [];
    return (
      first !== undefined &&
      "key" in first &&
      (first.key === "arguments" || first.key === "response")
    );
  },
  { error: "must be a field path that starts with arguments or response" }
);

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
  /**
   * Fields kept out of Fixtures, by server and Tool, as field paths into the
   * recorded call, such as `response.issues[].assignee.email`.
   */
  redact: z
    .record(z.string(), z.record(z.string(), z.array(redactionPath)))
    .optional(),
  /**
   * The OpenRouter model, such as `openai/gpt-4o-mini`, that proposes a
   * Repair when deterministic search finds none. Its key is read from
   * OPENROUTER_API_KEY. Left out, no model is ever called.
   */
  repairModel: z.string().min(1).optional(),
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

/**
 * A server's headers or environment with each environment variable
 * reference filled in, and the filled-in values, which are secrets.
 */
export function resolveReferences(
  server: string,
  values: Record<string, string>,
  env: NodeJS.ProcessEnv
): { values: Record<string, string>; secrets: string[] } {
  const secrets: string[] = [];
  const resolved = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value.replace(envReference, (_, variable: string) => {
        const secret = env[variable];
        if (secret === undefined || secret === "") {
          throw new Error(
            `Downstream Server "${server}" needs the environment variable ${variable}, which is not set.`
          );
        }
        secrets.push(secret);
        return secret;
      }),
    ])
  );
  return { values: resolved, secrets };
}

/** Records the developer's Tool classification in the config file. */
export async function classifyTools(
  path: string,
  choices: { server: string; tool: string; kind: ToolKind }[]
): Promise<void> {
  const json = JSON.parse(
    await readFile(path, "utf8")
  ) as Partial<PinfoldConfig>;
  // No prototypes, so a server or Tool named like an Object member, such as
  // constructor, is a name like any other.
  const servers: Record<string, Record<string, ToolKind>> = Object.create(null);
  for (const [server, tools] of Object.entries(json.classification ?? {})) {
    servers[server] = Object.assign(Object.create(null), tools);
  }
  for (const { server, tool, kind } of choices) {
    const tools: Record<string, ToolKind> =
      servers[server] ?? Object.create(null);
    tools[tool] = kind;
    servers[server] = tools;
  }
  json.classification = servers;
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
}

export async function loadConfig(path: string): Promise<PinfoldConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `${path} does not exist; create a pinfold config there, or pass --config <path>`,
      { cause: error }
    );
  }
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
