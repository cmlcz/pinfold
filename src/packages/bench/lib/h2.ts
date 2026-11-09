// H2: how many mappable Drift Scenarios deterministic Repair alone repairs.
// The scenario grid is generated from the fields the six tasks' reference
// programs read, and committed before any run; a run applies each scenario
// to each saved Workflow that reads its field, and the task's checker
// judges the repaired run.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  openPlans,
  type Core,
  type WorkflowRunResult,
} from "../../core/index.ts";
import type { Bench, BenchServer } from "./bench.ts";
import { tasks, type Task } from "./tasks.ts";

/** One Drift Scenario of the grid, and the Workflows it is tried on. */
export type GridScenario = {
  server: BenchServer;
  /** The field-level scenario's name, as the Drift Kit takes it. */
  scenario: string;
  /** Whether a Response Adapter can express the change. */
  mappable: boolean;
  /** Each task whose Workflow reads what the scenario changes, by input. */
  runs: { task: string; input: number }[];
};

// A removed field has no value to map from, and pages need calls that a
// Response Adapter cannot make.
const mappableKinds = new Set(["rename", "type-change", "enum-change", "wrap"]);

/**
 * Saves the reference program of a task for one input as a Workflow and
 * applies its first run, as a developer would before Drift.
 */
export async function saveApplied(
  core: Core,
  root: string,
  task: Task,
  input: number
): Promise<WorkflowRunResult> {
  const explored = await core.explore({
    code: task.program,
    input: task.inputs[input],
  });
  if (!explored.ok) throw new Error(`${task.name}: ${explored.error}`);
  const saved = await core.saveWorkflow({
    run: explored.exploration,
    name: "w",
    confirmed: true,
  });
  if (!saved.ok) throw new Error(`${task.name}: ${saved.error}`);
  return approvedRun(core, root, task.inputs[input]!);
}

// Runs Workflow w, approving a plan that waits for Approval once.
export async function approvedRun(
  core: Core,
  root: string,
  input: unknown
): Promise<WorkflowRunResult> {
  const first = await core.runWorkflow({ name: "w", input });
  if (!first.ok || (first.status !== "pending" && first.status !== "changed")) {
    return first;
  }
  await openPlans(root).approve(first.plan.id);
  const second = await core.runWorkflow({ name: "w", input });
  // Keep the Repairs the first run made, which the second only shows when
  // it made them itself.
  return second.ok &&
    first.repairs !== undefined &&
    second.repairs === undefined
    ? { ...second, repairs: first.repairs }
    : second;
}

/**
 * The scenario grid: each field-level change of each field a task's
 * Workflow reads, for any of its inputs, and each response-level change of
 * each Tool it calls.
 */
export async function generateGrid(bench: Bench): Promise<GridScenario[]> {
  const grid = new Map<string, GridScenario>();
  const add = (
    server: BenchServer,
    scenario: string,
    run: { task: string; input: number }
  ) => {
    const entry = grid.get(scenario) ?? {
      server,
      scenario,
      mappable: mappableKinds.has(scenario.split(":")[0]!),
      runs: [],
    };
    if (!entry.runs.some((other) => other.task === run.task)) {
      entry.runs.push(run);
    }
    grid.set(scenario, entry);
  };
  for (const task of tasks) {
    for (const [input] of task.inputs.entries()) {
      const { core, root } = await bench.fresh();
      await saveApplied(core, root, task, input);
      const record = JSON.parse(
        await readFile(join(root, ".workflows", "w.json"), "utf8")
      ) as { contract: Record<string, string[]> };
      const baselines = await readBaselines(root);
      for (const [name, paths] of Object.entries(record.contract)) {
        const [server, tool] = name.split(".") as [BenchServer, string];
        const schema = baselines.get(name);
        const run = { task: task.name, input };
        for (const path of paths) {
          for (const kind of fieldKinds(schemaAt(schema, path))) {
            add(server, `${kind}:${tool}:${path}`, run);
          }
        }
        add(server, `wrap:${tool}`, run);
        if (pageable(schema)) add(server, `pagination:${tool}`, run);
      }
    }
  }
  return [...grid.values()].sort((a, b) =>
    a.scenario.localeCompare(b.scenario)
  );
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  items?: Schema;
};

async function readBaselines(root: string): Promise<Map<string, Schema>> {
  const dir = join(root, ".workflows", "baselines");
  const baselines = new Map<string, Schema>();
  for (const file of await readdir(dir)) {
    const { server, tool, outputSchema } = JSON.parse(
      await readFile(join(dir, file), "utf8")
    ) as { server: string; tool: string; outputSchema: Schema };
    baselines.set(`${server}.${tool}`, outputSchema);
  }
  return baselines;
}

// The schema of the field a path names.
function schemaAt(
  schema: Schema | undefined,
  path: string
): Schema | undefined {
  let at = schema;
  for (const step of path.split(".")) {
    at = at?.properties?.[step.replace("[]", "")];
    if (step.endsWith("[]")) at = at?.items;
  }
  return at;
}

// The field-level changes that apply to a field: any field can be renamed
// or removed, a number can become text, and an enum can change its values.
function fieldKinds(schema: Schema | undefined): string[] {
  const types = [schema?.type ?? []].flat();
  return [
    "rename",
    ...(types.includes("number") || types.includes("integer")
      ? ["type-change"]
      : []),
    ...(schema?.enum !== undefined ? ["enum-change"] : []),
    "removed-field",
  ];
}

// A response that holds a list and is not paged already.
function pageable(schema: Schema | undefined): boolean {
  const properties = Object.values(schema?.properties ?? {});
  return (
    properties.some((property) => property.type === "array") &&
    !Object.hasOwn(schema?.properties ?? {}, "nextCursor")
  );
}

/** What became of one Workflow facing one scenario. */
export type H2Outcome =
  /** Repaired, and the repaired run did the task. */
  | "repaired"
  /** Repaired, but the repaired run did not do the task. */
  | "wrong repair"
  /** Stopped, and told the developer it needs a manual fix. */
  | "manual"
  /** Stopped with Drift that no Repair settled. */
  | "unrepaired"
  /** No Drift found, and the run still did the task. */
  | "unaffected"
  /** No Drift found, and the run failed or did not do the task. */
  | "missed";

export type H2Result = GridScenario & {
  outcomes: {
    task: string;
    input: number;
    outcome: H2Outcome;
    detail: string;
  }[];
};

/** Runs every scenario of the grid on each Workflow it applies to. */
export async function runGrid(
  bench: Bench,
  grid: readonly GridScenario[]
): Promise<H2Result[]> {
  const results: H2Result[] = [];
  for (const entry of grid) {
    const outcomes: H2Result["outcomes"] = [];
    for (const run of entry.runs) {
      const task = tasks.find((candidate) => candidate.name === run.task)!;
      outcomes.push({
        ...run,
        ...(await tryScenario(bench, entry, task, run.input)),
      });
    }
    results.push({ ...entry, outcomes });
  }
  return results;
}

async function tryScenario(
  bench: Bench,
  entry: GridScenario,
  task: Task,
  input: number
): Promise<{ outcome: H2Outcome; detail: string }> {
  const { core, root } = await bench.fresh();
  await saveApplied(core, root, task, input);
  // The drifted run starts from the seed, so its writes are its own.
  await bench.reset();
  await bench.controls[entry.server].startDrift(entry.scenario);
  const result = await approvedRun(core, root, task.inputs[input]!);
  if (!result.ok) {
    const detail = result.error.split("\n")[0]!;
    if (/manual fix/.test(result.error)) return { outcome: "manual", detail };
    if (/drifted/.test(result.error)) return { outcome: "unrepaired", detail };
    return { outcome: "missed", detail };
  }
  const verdict = task.check(
    task.inputs[input]!,
    await bench.outcome(result.value)
  );
  const detail = verdict.problems.join("; ");
  if (result.repairs !== undefined) {
    return { outcome: verdict.success ? "repaired" : "wrong repair", detail };
  }
  return { outcome: verdict.success ? "unaffected" : "missed", detail };
}

/** The H2 rate and the outcomes by scenario kind, as Markdown. */
export function formatResults(
  results: readonly H2Result[],
  provenance: Record<string, string>
): string {
  const runs = results.flatMap((result) =>
    result.outcomes.map((outcome) => ({
      ...outcome,
      kind: result.scenario.split(":")[0]!,
      mappable: result.mappable,
      scenario: result.scenario,
    }))
  );
  const mappable = runs.filter((run) => run.mappable);
  const repaired = mappable.filter((run) => run.outcome === "repaired");
  const rate = mappable.length === 0 ? 0 : repaired.length / mappable.length;
  const kinds = [...new Set(runs.map((run) => run.kind))];
  const outcomes: H2Outcome[] = [
    "repaired",
    "wrong repair",
    "manual",
    "unrepaired",
    "unaffected",
    "missed",
  ];
  const lines = [
    "# H2 results",
    "",
    ...Object.entries(provenance).map(([key, value]) => `- ${key}: ${value}`),
    "",
    `Deterministic Repair alone repaired **${repaired.length} of ${mappable.length}** runs of mappable Drift Scenarios (${(rate * 100).toFixed(1)}%), against a target of 80%. A run is one task's Workflow facing one scenario; it counts as repaired only if the repaired run then passes the task's checker.`,
    "",
    `Over all ${runs.length} runs, including the ${runs.length - mappable.length} that no mapping can fix (a removed field, a paged response), ${repaired.length} were repaired (${((repaired.length / runs.length) * 100).toFixed(1)}%).`,
    "",
    "The grid renames each field by a fixed rule that keeps the old name's words ([ADR 0010](../adr/0010-generate-the-h2-scenario-grid.md)), which favours deterministic Repair's name matching. Scenarios taken from real MCP server changelogs, which H2 reports apart, are not in this run.",
    "",
    `| Kind | Mappable | ${outcomes.join(" | ")} |`,
    `| :--- | :--- | ${outcomes.map(() => "---:").join(" | ")} |`,
    ...kinds.map((kind) => {
      const ofKind = runs.filter((run) => run.kind === kind);
      const counts = outcomes.map(
        (outcome) => ofKind.filter((run) => run.outcome === outcome).length
      );
      return `| ${kind} | ${mappableKinds.has(kind) ? "yes" : "no"} | ${counts.join(" | ")} |`;
    }),
    "",
    "## Runs not repaired",
    "",
    "| Scenario | Task | Outcome | Detail |",
    "| :--- | :--- | :--- | :--- |",
    ...runs
      .filter(
        (run) => run.outcome !== "repaired" && run.outcome !== "unaffected"
      )
      .map(
        (run) =>
          `| \`${run.scenario}\` | ${run.task} | ${run.outcome} | ${run.detail.replaceAll("|", "\\|")} |`
      ),
    "",
  ];
  return lines.join("\n");
}
