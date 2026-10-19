// Workflows, kept in .workflows/ to be committed: each one is an ordinary
// TypeScript file the developer owns, beside a JSON file that records its
// input schema, Tools and Contract. Its Fixtures go to the git-ignored
// .workflows/fixtures/.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  mainInputSchema,
  typecheck,
  type FieldReads,
  type JsonSchema,
} from "../../sandbox/index.ts";
import { deepestPaths, redact } from "./paths.ts";

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
  const input = mainInputSchema(source, request.declarations);
  if (!input.ok) {
    return refuse(
      "main",
      `${input.error}; a Workflow exports a typed main(input)`
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
    input: input.schema,
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
  const workflows: WorkflowSummary[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const text = await readOrNone(join(dir, file));
    const parsed = recordSchema.safeParse(text && safeJson(text));
    if (!parsed.success) continue;
    const source = await readOrNone(join(dir, `${parsed.data.name}.ts`));
    workflows.push(summary(parsed.data, source !== undefined));
  }
  return workflows;
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
