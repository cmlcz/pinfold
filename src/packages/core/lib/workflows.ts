// Workflows, kept in .workflows/ to be committed: each one is an ordinary
// TypeScript file the developer owns, beside a JSON file that records its
// input schema, Tools and Contract. Its Fixtures go to the git-ignored
// .workflows/fixtures/.
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  exportedLiteral,
  mainInputSchema,
  typecheck,
  type FieldReads,
  type JsonSchema,
} from "../../sandbox/index.ts";
import { deepestPaths, redact, shapeHas } from "./paths.ts";

export const defaultWriteBudget = 10;

/** A Tool call an Exploration Run made live, as a Fixture records it. */
export type RecordedCall = {
  tool: string;
  arguments: unknown;
  response: unknown;
};

/** What a successful Exploration Run leaves for save_workflow. */
export type Exploration = {
  run: string;
  code: string;
  input: unknown;
  /** The Read Tool calls, with their responses. */
  calls: RecordedCall[];
  /** Every Tool the run called, as `server.tool`, Read and Write alike. */
  tools: string[];
  reads: FieldReads;
};

/** The checks save_workflow makes, in order. */
export type SaveCheck = "name" | "run" | "confirmation" | "main" | "types";

export type SaveResult =
  | { ok: true; workflow: WorkflowSummary }
  | { ok: false; check: SaveCheck; error: string };

const recordSchema = z.object({
  name: z.string(),
  /** The JSON Schema of main's input. */
  input: z.record(z.string(), z.unknown()),
  tools: z.array(z.string()),
  /** The Baseline field paths the code read, by Tool. */
  contract: z.record(z.string(), z.array(z.string())),
  savedFrom: z.string(),
  savedAt: z.string(),
});

type WorkflowRecord = z.infer<typeof recordSchema>;

export type WorkflowSummary = {
  name: string;
  input: JsonSchema;
  tools: string[];
  /** When a Workflow Run last ran it; undefined if none has. */
  lastRun?: string;
  status: "ready" | "missing";
};

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Saves an Exploration Run as a Workflow if every check passes, and writes
 * nothing otherwise.
 */
export async function saveWorkflow(
  root: string,
  request: {
    name: string;
    exploration: Exploration | undefined;
    run: string;
    confirmed: boolean;
    declarations: string;
    /** Redaction rules by server, then Tool. */
    redact: Record<string, Record<string, string[]>>;
  }
): Promise<SaveResult> {
  const { name, exploration } = request;
  const dir = join(root, ".workflows");
  const refuse = (check: SaveCheck, error: string): SaveResult => ({
    ok: false,
    check,
    error: `Not saved: ${error}.`,
  });

  if (!namePattern.test(name)) {
    return refuse(
      "name",
      `${JSON.stringify(name)} is not a Workflow name; use lower case letters, digits and _, starting with a letter`
    );
  }
  if ((await readOrNone(join(dir, `${name}.json`))) !== undefined) {
    return refuse("name", `a Workflow named ${name} exists already`);
  }
  if (exploration === undefined) {
    return refuse(
      "run",
      `there is no successful Exploration Run ${request.run} in this session; only a run that finished without error as a valid Plan can be saved`
    );
  }
  if (!request.confirmed) {
    return refuse(
      "confirmation",
      "the developer has not confirmed the run's result; show it to them, and save once they confirm it"
    );
  }
  const source = workflowSource(name, exploration);
  const mainInput = mainInputSchema(source, request.declarations);
  if (!mainInput.ok) {
    return refuse(
      "main",
      `${mainInput.error}; a Workflow exports a typed main(input)`
    );
  }
  const errors = typecheck(source, request.declarations);
  if (errors.length > 0) {
    return refuse(
      "types",
      `the Workflow does not type-check against the SDK:\n${errors.join("\n")}`
    );
  }

  const record: WorkflowRecord = {
    name,
    input: mainInput.schema,
    tools: exploration.tools,
    contract: Object.fromEntries(
      Object.entries(exploration.reads).map(([tool, paths]) => [
        tool,
        deepestPaths(paths),
      ])
    ),
    savedFrom: exploration.run,
    savedAt: new Date().toISOString(),
  };
  const fixtures = {
    input: exploration.input,
    calls: exploration.calls.map((call) => redactCall(call, request.redact)),
  };

  await mkdir(join(dir, "fixtures"), { recursive: true });
  try {
    // Created only if absent, so of two saves under one name only one wins.
    await writeFile(join(dir, `${name}.ts`), source, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return refuse(
      "name",
      `a Workflow file .workflows/${name}.ts exists already`
    );
  }
  await writeFile(join(dir, "fixtures", ".gitignore"), "*\n");
  await writeFile(
    join(dir, "fixtures", `${name}.json`),
    `${JSON.stringify(fixtures, null, 2)}\n`
  );
  await writeFile(
    join(dir, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );
  return { ok: true, workflow: summary(record, true) };
}

function workflowSource(name: string, exploration: Exploration): string {
  return [
    `// Workflow ${name}, saved by pinfold from Exploration Run ${exploration.run}.`,
    "// This file is yours to edit. Each Workflow Run runs main(input) as a Plan;",
    "// a Write Plan with more writes than settings.writeBudget waits for Approval.",
    `export const settings = { writeBudget: ${defaultWriteBudget} };`,
    "",
    exploration.code.trim(),
    "",
  ].join("\n");
}

// Rules name fields of the recorded call: its arguments or its response.
function redactCall(
  call: RecordedCall,
  rules: Record<string, Record<string, string[]>>
): RecordedCall {
  const [server, ...rest] = call.tool.split(".");
  const tool = rest.join(".");
  const tools = Object.hasOwn(rules, server!) ? rules[server!]! : {};
  const paths = Object.hasOwn(tools, tool) ? tools[tool]! : [];
  if (paths.length === 0) return call;
  const { arguments: args, response } = redact(
    { arguments: call.arguments, response: call.response },
    paths
  ) as Omit<RecordedCall, "tool">;
  return { tool: call.tool, arguments: args, response };
}

/** The saved Workflows, by name. A record that does not parse is skipped. */
export async function listWorkflows(root: string): Promise<WorkflowSummary[]> {
  const dir = join(root, ".workflows");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lastRuns = new Map(
    (await runHistory(root)).map((entry) => [entry.workflow, entry.at])
  );
  const workflows: WorkflowSummary[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const text = await readOrNone(join(dir, file));
    const parsed = recordSchema.safeParse(text && safeJson(text));
    if (!parsed.success) continue;
    const source = await readOrNone(join(dir, `${parsed.data.name}.ts`));
    const workflow = summary(parsed.data, source !== undefined);
    const lastRun = lastRuns.get(workflow.name);
    workflows.push(lastRun === undefined ? workflow : { ...workflow, lastRun });
  }
  return workflows;
}

/** A saved Workflow that passed the checks made before each of its runs. */
export type LoadedWorkflow = {
  name: string;
  source: string;
  /** The JSON Schema of main's input, from the code as it is now. */
  input: JsonSchema;
  writeBudget: number;
};

const settingsSchema = z.object({ writeBudget: z.int().nonnegative() });

/**
 * Loads a Workflow for a run, re-checking it since the developer may have
 * edited it: it must still export a typed main(input), type-check against
 * the SDK, set a Write Budget, and call only Tools that are offered, whose
 * Baselines still have every field its Contract reads.
 */
export async function loadWorkflow(
  root: string,
  name: string,
  sdk: {
    declarations: string;
    /** Every offered Tool, as `server.tool`. */
    tools: Set<string>;
    /** The pinned response shape of a Tool, if it has one yet. */
    outputSchema(tool: string): JsonSchema | undefined;
  }
): Promise<
  { ok: true; workflow: LoadedWorkflow } | { ok: false; error: string }
> {
  const refuse = (error: string) => ({
    ok: false as const,
    error: `Workflow ${name} not run: ${error}.`,
  });
  const dir = join(root, ".workflows");
  const text = namePattern.test(name)
    ? await readOrNone(join(dir, `${name}.json`))
    : undefined;
  const parsed = recordSchema.safeParse(text && safeJson(text));
  if (!parsed.success) return refuse("there is no saved Workflow by that name");
  const record = parsed.data;
  const source = await readOrNone(join(dir, `${name}.ts`));
  if (source === undefined) return refuse(`.workflows/${name}.ts is missing`);

  const mainInput = mainInputSchema(source, sdk.declarations);
  if (!mainInput.ok) {
    return refuse(`${mainInput.error}; a Workflow exports a typed main(input)`);
  }
  const errors = typecheck(source, sdk.declarations);
  if (errors.length > 0) {
    return refuse(
      `it does not type-check against the SDK:\n${errors.join("\n")}`
    );
  }
  const settings = exportedLiteral(source, "settings");
  const parsedSettings = settings.ok
    ? settingsSchema.safeParse(settings.value)
    : undefined;
  if (!parsedSettings?.success) {
    return refuse(
      "it must export const settings = { writeBudget: <n> }, with n a whole number of writes"
    );
  }
  for (const tool of record.tools) {
    if (!sdk.tools.has(tool)) {
      return refuse(`it calls ${tool}, which no Downstream Server offers`);
    }
  }
  for (const [tool, paths] of Object.entries(record.contract)) {
    const shape = sdk.outputSchema(tool);
    if (shape === undefined) continue;
    const missing = paths.filter((path) => !shapeHas(shape, path));
    if (missing.length > 0) {
      return refuse(
        `its Contract reads ${missing.map((path) => `${tool} ${path}`).join(", ")}, which the Baseline of ${tool} does not have`
      );
    }
  }
  return {
    ok: true,
    workflow: {
      name,
      source,
      input: mainInput.schema,
      writeBudget: parsedSettings.data.writeBudget,
    },
  };
}

/** Checks a Workflow's input against the schema of main's input. */
export function checkInput(
  schema: JsonSchema,
  input: unknown
): { ok: true } | { ok: false; error: string } {
  const result = z.fromJSONSchema(schema).safeParse(input);
  if (result.success) return { ok: true };
  return {
    ok: false,
    error: `The input does not fit main(input):\n${z.prettifyError(result.error)}`,
  };
}

/**
 * An input from command-line flags: a value is read as JSON, so `50` is a
 * number, unless the field takes a string; a flag without a value is true.
 */
export function inputFromFlags(
  schema: JsonSchema,
  flags: Record<string, string | true>
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const input: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(flags)) {
    const field = Object.hasOwn(properties, name) ? properties[name] : {};
    if (text === true || field?.type === "string") input[name] = text;
    else input[name] = safeJson(text) ?? text;
  }
  return input;
}

/** One Workflow Run, as the run history records it. */
export type RunEntry = {
  workflow: string;
  at: string;
  /** What became of the run's Write Plan, or `failed`. */
  status: string;
  plan?: string;
  error?: string;
};

// The run history is the git-ignored state directory's runs.jsonl, one line
// per run. Lines are appended whole, so runs of several processes can share
// it.
function historyFile(root: string): string {
  return join(root, ".pinfold", "runs.jsonl");
}

export async function recordRun(root: string, entry: RunEntry): Promise<void> {
  const state = join(root, ".pinfold");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, ".gitignore"), "*\n");
  await appendFile(historyFile(root), `${JSON.stringify(entry)}\n`);
}

/** Every recorded Workflow Run, oldest first. Damaged lines are skipped. */
export async function runHistory(root: string): Promise<RunEntry[]> {
  const text = (await readOrNone(historyFile(root))) ?? "";
  return text
    .split("\n")
    .map(safeJson)
    .filter(
      (entry): entry is RunEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RunEntry).workflow === "string" &&
        typeof (entry as RunEntry).at === "string"
    );
}

function summary(record: WorkflowRecord, present: boolean): WorkflowSummary {
  return {
    name: record.name,
    input: record.input,
    tools: record.tools,
    status: present ? "ready" : "missing",
  };
}

/** One line per Workflow: name, inputs, Tools, last run and status. */
export function formatWorkflows(workflows: WorkflowSummary[]): string {
  if (workflows.length === 0) return "No saved Workflows.";
  return workflows
    .map((workflow) =>
      [
        workflow.name,
        `  inputs: ${describeInput(workflow.input)}`,
        `  tools: ${workflow.tools.join(", ") || "none"}`,
        `  last run: ${workflow.lastRun ?? "never"}`,
        `  status: ${workflow.status === "ready" ? "ready" : `missing .workflows/${workflow.name}.ts`}`,
      ].join("\n")
    )
    .join("\n\n");
}

function describeInput(schema: JsonSchema): string {
  const properties = schema.properties as
    Record<string, JsonSchema> | undefined;
  if (properties === undefined) return describeType(schema);
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const fields = Object.entries(properties).map(
    ([name, field]) =>
      `${name}${required.has(name) ? "" : "?"}: ${describeType(field)}`
  );
  return fields.length > 0 ? fields.join(", ") : "none";
}

function describeType(schema: JsonSchema): string {
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).map(describeType).join(" | ");
  }
  if (schema.type === "array") {
    return `${describeType(schema.items as JsonSchema)}[]`;
  }
  if (schema.type === "object") return `{ ${describeInput(schema)} }`;
  return typeof schema.type === "string" ? schema.type : "unknown";
}

async function readOrNone(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
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
