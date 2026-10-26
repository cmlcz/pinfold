// Workflows, kept in .workflows/ to be committed: each one is an ordinary
// TypeScript file the developer owns, beside a JSON file that records its
// input schema, Tools and Contract. Its Fixtures go to the git-ignored
// .workflows/fixtures/.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  exportedLiteral,
  mainInputSchema,
  numberKeyPattern,
  typecheck,
  type FieldReads,
  type JsonSchema,
} from "../../sandbox/index.ts";
import { splitToolName } from "./baselines.ts";
import {
  listJson,
  prepareState,
  readOrNone,
  readParsed,
  safeJson,
} from "./files.ts";
import { deepestPaths, redact, withoutDataKeys } from "./paths.ts";

const defaultWriteBudget = 10;

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
  /** The digest of the Response Adapter of each of its Tools that has one. */
  adapters: Record<string, string>;
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
  /** The Response Adapters the confirmed run went through, by digest. */
  adapters: z.record(z.string(), z.string()).default({}),
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

// For reading main's input type without the SDK, which the type does not
// depend on.
const anySdk = "declare const sdk: any;\n";

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
  const mainInput = await mainInputSchema(source, request.declarations);
  if (!mainInput.ok) {
    return refuse(
      "main",
      `${mainInput.error}; a Workflow exports a typed main(input)`
    );
  }
  const errors = await typecheck(source, request.declarations);
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
    contract: contractOf(exploration.reads),
    adapters: exploration.adapters,
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

/**
 * The fields a run read, by Tool, as a Contract writes them: without data
 * keys, and only the deepest paths.
 */
export function contractOf(reads: FieldReads): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(reads).map(([tool, paths]) => [
      tool,
      deepestPaths(paths.map(withoutDataKeys).filter((path) => path !== "")),
    ])
  );
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

/**
 * A recorded call with the fields its Tool's redaction rules name replaced
 * by `[redacted]`. Rules name fields of the call: its arguments or its
 * response.
 */
export function redactCall(
  call: RecordedCall,
  rules: Record<string, Record<string, string[]>>
): RecordedCall {
  const paths = redactionRules(rules, call.tool);
  if (paths.length === 0) return call;
  const { arguments: args, response } = redact(
    { arguments: call.arguments, response: call.response },
    paths
  ) as Omit<RecordedCall, "tool">;
  return { tool: call.tool, arguments: args, response };
}

/** The redaction rules of a Tool, as `server.tool`. */
export function redactionRules(
  rules: Record<string, Record<string, string[]>>,
  name: string
): string[] {
  const { server, tool } = splitToolName(name);
  const tools = Object.hasOwn(rules, server) ? rules[server]! : {};
  return Object.hasOwn(tools, tool) ? tools[tool]! : [];
}

/** The saved Workflows, by name. A record that does not parse is skipped. */
export async function listWorkflows(root: string): Promise<WorkflowSummary[]> {
  const lastRuns = new Map(
    (await runHistory(root)).map((entry) => [entry.workflow, entry.at])
  );
  const workflows: WorkflowSummary[] = [];
  for (const record of await readRecords(root)) {
    const source = await readOrNone(
      join(root, ".workflows", `${record.name}.ts`)
    );
    const workflow = summary(record, source !== undefined);
    // The developer may have edited main's input type since the save.
    if (source !== undefined) {
      const current = await mainInputSchema(source, anySdk);
      if (current.ok) workflow.input = current.schema;
    }
    const lastRun = lastRuns.get(workflow.name);
    workflows.push(lastRun === undefined ? workflow : { ...workflow, lastRun });
  }
  return workflows;
}

const fixturesSchema = z.object({
  calls: z.array(
    z.object({ tool: z.string(), arguments: z.json(), response: z.json() })
  ),
});

/**
 * The calls of a Tool, as `server.tool`, that the Fixtures of the saved
 * Workflows recorded. A Fixture file that does not parse is skipped.
 */
export async function fixtureCalls(
  root: string,
  tool: string
): Promise<RecordedCall[]> {
  const dir = join(root, ".workflows", "fixtures");
  const calls: RecordedCall[] = [];
  for (const file of await listJson(dir)) {
    const fixtures = await readParsed(join(dir, file), fixturesSchema);
    if (fixtures === undefined) continue;
    calls.push(...fixtures.calls.filter((call) => call.tool === tool));
  }
  return calls;
}

/** The Tools and Contract of every saved Workflow, by name. */
export async function savedContracts(root: string): Promise<
  {
    name: string;
    /** Every Tool the Workflow calls, as `server.tool`. */
    tools: string[];
    contract: Record<string, string[]>;
  }[]
> {
  return (await readRecords(root)).map(({ name, tools, contract }) => ({
    name,
    tools,
    contract,
  }));
}

// The record of every saved Workflow, by name. A record that does not parse
// is skipped.
async function readRecords(root: string): Promise<WorkflowRecord[]> {
  const dir = join(root, ".workflows");
  const records = [];
  for (const file of (await listJson(dir)).sort()) {
    const record = await readParsed(join(dir, file), recordSchema);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** A saved Workflow that passed the checks made before each of its runs. */
export type LoadedWorkflow = {
  name: string;
  source: string;
  /** The JSON Schema of main's input, from the code as it is now. */
  input: JsonSchema;
  writeBudget: number;
  /** Identifies this save of the Workflow, apart from any earlier one. */
  saved: string;
  /** Every Tool the Workflow calls, as `server.tool`. */
  tools: string[];
  /** The Baseline field paths the code reads, by Tool. */
  contract: Record<string, string[]>;
  /** The Response Adapters the run it was saved from went through. */
  adapters: Record<string, string>;
};

const settingsSchema = z.object({ writeBudget: z.int().nonnegative() });

/**
 * Loads a Workflow for a run, re-checking it since the developer may have
 * edited it: it must still export a typed main(input), type-check against
 * the SDK, set a Write Budget, and call only Tools that are offered.
 */
export async function loadWorkflow(
  root: string,
  name: string,
  sdk: {
    declarations: string;
    /** Every offered Tool, as `server.tool`. */
    tools: Set<string>;
  }
): Promise<
  { ok: true; workflow: LoadedWorkflow } | { ok: false; error: string }
> {
  const refuse = (error: string) => ({
    ok: false as const,
    error: `Workflow ${name} not run: ${error}.`,
  });
  const dir = join(root, ".workflows");
  const record = namePattern.test(name)
    ? await readParsed(join(dir, `${name}.json`), recordSchema)
    : undefined;
  if (record === undefined) {
    return refuse("there is no saved Workflow by that name");
  }
  const source = await readOrNone(join(dir, `${name}.ts`));
  if (source === undefined) return refuse(`.workflows/${name}.ts is missing`);

  const mainInput = await mainInputSchema(source, sdk.declarations);
  if (!mainInput.ok) {
    return refuse(`${mainInput.error}; a Workflow exports a typed main(input)`);
  }
  const errors = await typecheck(source, sdk.declarations);
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
  return {
    ok: true,
    workflow: {
      name,
      source,
      input: mainInput.schema,
      writeBudget: parsedSettings.data.writeBudget,
      saved: `${record.savedFrom}@${record.savedAt}`,
      tools: record.tools,
      contract: record.contract,
      adapters: record.adapters,
    },
  };
}

/** Checks a Workflow's input against the schema of main's input. */
export function checkInput(
  schema: JsonSchema,
  input: unknown
): { ok: true } | { ok: false; error: string } {
  const result = zodSchema(schema).safeParse(input);
  if (result.success) return { ok: true };
  return {
    ok: false,
    error: `The input does not fit main(input):\n${z.prettifyError(result.error)}`,
  };
}

/**
 * A Workflow's input as given on the command line: one value for a main
 * whose input is not an object, or else one `--<field> <value>` flag per
 * field.
 */
export type CommandLineInput = {
  value?: string;
  flags: Record<string, string | true>;
};

/**
 * The input a command line gives, read against the schema of main's input:
 * a value is read as JSON where that fits, so `50` is a number for a number
 * field, and as text otherwise. A flag without a value is true.
 */
export function inputFromCommandLine(
  schema: JsonSchema,
  { value, flags }: CommandLineInput
): unknown {
  if (value !== undefined) return fromText(schema, value);
  // No prototype, so a flag named __proto__ is a field the check refuses.
  const input: Record<string, unknown> = Object.create(null);
  for (const [name, text] of Object.entries(flags)) {
    input[name] = text === true ? true : fromText(fieldOf(schema, name), text);
  }
  return input;
}

// The schema of an object's field, as JSON Schema finds it: a property, else
// a matching pattern, else additionalProperties.
function fieldOf(schema: JsonSchema, name: string): JsonSchema | boolean {
  const properties = schema.properties ?? {};
  if (Object.hasOwn(properties, name)) return properties[name]!;
  const patterns = schema.patternProperties ?? {};
  for (const [pattern, field] of Object.entries(patterns)) {
    if (new RegExp(pattern).test(name)) return field;
  }
  const additional = schema.additionalProperties;
  return typeof additional === "object" ? additional : true;
}

function fromText(schema: JsonSchema | boolean, text: string): unknown {
  const parsed = safeJson(text);
  const fits =
    parsed !== undefined && zodSchema(schema).safeParse(parsed).success;
  return fits ? parsed : text;
}

// The schema of main's input comes from mainInputSchema, which writes only
// what zod's JSON Schema type allows. JsonSchema is wider, since it also
// types the schemas Downstream Servers list.
function zodSchema(schema: JsonSchema | boolean): z.ZodType {
  return z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema);
}

/** One Workflow Run, as the run history records it. */
export type RunEntry = {
  workflow: string;
  /** Which save of the Workflow ran, once it was loaded. */
  saved?: string;
  /** A hash of the Workflow's code as it ran. */
  source?: string;
  at: string;
  /** What became of the run's Write Plan, or `failed`. */
  status: string;
  /** The digest of each Response Adapter the run's Tools went through. */
  adapters?: Record<string, string>;
  plan?: string;
  /** How many writes the run's Write Plan held. */
  writes?: number;
  error?: string;
};

// The run history is the git-ignored state directory's runs.jsonl, one line
// per run. Lines are appended whole, so runs of several processes can share
// it.
function historyFile(root: string): string {
  return join(root, ".pinfold", "runs.jsonl");
}

export async function recordRun(root: string, entry: RunEntry): Promise<void> {
  await prepareState(root);
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
  const { properties } = schema;
  if (properties === undefined) return describeType(schema);
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(properties).map(
    ([name, field]) =>
      `${name}${required.has(name) ? "" : "?"}: ${describeType(field)}`
  );
  // Index signatures: keys that spell numbers, then any other key.
  const patterns = schema.patternProperties ?? {};
  for (const [pattern, values] of Object.entries(patterns)) {
    const key = pattern === numberKeyPattern ? "number" : `/${pattern}/`;
    fields.push(`[key: ${key}]: ${describeType(values)}`);
  }
  const additional = schema.additionalProperties;
  if (typeof additional === "object") {
    fields.push(`[key: string]: ${describeType(additional)}`);
  }
  return fields.length > 0 ? fields.join(", ") : "none";
}

function describeType(schema: JsonSchema | boolean): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map(describeType).join(" | ");
  }
  if (Array.isArray(schema.prefixItems)) {
    const elements = schema.prefixItems.map(describeType);
    if (schema.items !== false) {
      elements.push(`...${describeType(schema.items ?? true)}[]`);
    }
    return `[${elements.join(", ")}]`;
  }
  if (schema.type === "array") {
    return `${describeType(schema.items ?? true)}[]`;
  }
  if (schema.type === "object") return `{ ${describeInput(schema)} }`;
  return typeof schema.type === "string" ? schema.type : "unknown";
}
