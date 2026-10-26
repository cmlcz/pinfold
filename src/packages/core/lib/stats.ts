// What pinfold did for the developer, from quantities it measured itself:
// runs and their wall time, Tool calls and the bytes of their responses,
// Repairs, and the Repair Model's tokens. Never an estimate of tokens saved.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { Traffic } from "./downstream.ts";
import { prepareState, readOrNone, safeJson } from "./files.ts";
import { openRepairs, type RepairRecord } from "./repair.ts";
import { runHistory, type RunEntry } from "./workflows.ts";

/** An Exploration Run as .pinfold/explorations.jsonl keeps it. */
export type ExplorationEntry = {
  /** The run's ID, if it succeeded. */
  exploration?: string;
  at: string;
  /** What became of the run's Write Plan, or `failed`. */
  status: string;
} & Traffic;

export async function recordExploration(
  root: string,
  entry: ExplorationEntry
): Promise<void> {
  const state = await prepareState(root);
  await appendFile(
    join(state, "explorations.jsonl"),
    `${JSON.stringify(entry)}\n`
  );
}

/**
 * Runs and what they did. Runs from before pinfold measured them count only
 * in `unmeasured`, never as zero traffic.
 */
export type RunTotals = Traffic & { runs: number; unmeasured: number };

export type Stats = {
  /** When the oldest run or Repair counted here happened. */
  since?: string;
  explorationRuns: RunTotals;
  workflowRuns: RunTotals;
  /** Each Workflow's runs, by name. */
  workflows: ({ name: string } & RunTotals)[];
  total: RunTotals;
  /** Repairs by who made them, since pinfold began to log them. */
  repairs: Record<RepairRecord["by"], number>;
  /** What pinfold itself spent through the Repair Model. */
  model: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    /** In credits, summed over the calls whose cost the API reported. */
    cost: number;
  };
};

const trafficSchema = z.object({
  ms: z.number(),
  toolCalls: z.number(),
  responseBytes: z.number(),
});

const usageSchema = z.object({
  at: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cost: z.number().optional(),
});

/** Reads the stats from what pinfold keeps in .pinfold/. */
export async function readStats(root: string): Promise<Stats> {
  const state = join(root, ".pinfold");
  const explorations = await readEntries(
    join(state, "explorations.jsonl"),
    z.looseObject({ at: z.string() })
  );
  const runs = await runHistory(root);
  const usage = await readEntries(
    join(state, "model-usage.jsonl"),
    usageSchema
  );
  const repairs = await openRepairs(root).log();

  const byWorkflow = new Map<string, RunEntry[]>();
  for (const run of runs) {
    const entries = byWorkflow.get(run.workflow) ?? [];
    entries.push(run);
    byWorkflow.set(run.workflow, entries);
  }
  const counted = { pinfold: 0, agent: 0, model: 0, migration: 0 };
  for (const { by } of repairs) counted[by]++;
  const times = [
    ...explorations.map(({ at }) => at),
    ...runs.map(({ at }) => at),
    ...repairs.map(({ at }) => at),
    ...usage.map(({ at }) => at),
  ].sort();

  return {
    ...(times[0] !== undefined && { since: times[0] }),
    explorationRuns: totals(explorations),
    workflowRuns: totals(runs),
    workflows: [...byWorkflow]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entries]) => ({ name, ...totals(entries) })),
    total: totals([...explorations, ...runs]),
    repairs: counted,
    model: {
      calls: usage.length,
      promptTokens: sum(usage.map((call) => call.promptTokens)),
      completionTokens: sum(usage.map((call) => call.completionTokens)),
      // Rounded past what OpenRouter reports, to drop float sum noise.
      cost: Number(sum(usage.map((call) => call.cost ?? 0)).toFixed(9)),
    },
  };
}

// The lines of a JSON Lines file that fit `schema`; others are skipped, so
// one damaged line cannot hide the rest.
async function readEntries<T>(
  file: string,
  schema: z.ZodType<T>
): Promise<T[]> {
  const text = (await readOrNone(file)) ?? "";
  return text.split("\n").flatMap((line) => {
    const parsed = schema.safeParse(safeJson(line));
    return parsed.success ? [parsed.data] : [];
  });
}

function totals(entries: unknown[]): RunTotals {
  const measured = entries.flatMap((entry) => {
    const parsed = trafficSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    runs: measured.length,
    unmeasured: entries.length - measured.length,
    ms: sum(measured.map(({ ms }) => ms)),
    toolCalls: sum(measured.map(({ toolCalls }) => toolCalls)),
    responseBytes: sum(measured.map(({ responseBytes }) => responseBytes)),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The stats as the developer reads them in a terminal. */
export function formatStats(stats: Stats): string {
  if (stats.since === undefined) {
    return "Nothing measured yet: pinfold has kept no runs, Repairs or Repair Model calls.";
  }
  const { repairs, model } = stats;
  const lines = [
    `Measured by pinfold since ${stats.since}.`,
    "",
    `Exploration Runs: ${describe(stats.explorationRuns)}`,
    `Workflow Runs: ${describe(stats.workflowRuns)}`,
    ...stats.workflows.map(
      (workflow) => `  ${workflow.name}: ${describe(workflow)}`
    ),
    `Total: ${describe(stats.total)}`,
    "",
    "Tool responses stay in the sandbox: the agent reads only what a run returns.",
    "",
    `Repairs: ${repairs.pinfold} by pinfold, ${repairs.agent} by an agent, ${repairs.model} by the Repair Model, ${count(repairs.migration, "Baseline Migration")}`,
    `Repair Model: ${count(model.calls, "call")}, ${number(model.promptTokens)} prompt tokens, ${number(model.completionTokens)} completion tokens, ${model.cost} credits`,
  ];
  return lines.join("\n");
}

function describe(totals: RunTotals): string {
  const parts = [
    count(totals.runs, "run"),
    `${(totals.ms / 1000).toFixed(1)} s`,
    count(totals.toolCalls, "Tool call"),
    `${number(totals.responseBytes)} bytes of Tool responses`,
  ];
  if (totals.unmeasured > 0) {
    parts.push(
      `and ${count(totals.unmeasured, "run")} from before pinfold measured them`
    );
  }
  return parts.join(", ");
}

function count(n: number, noun: string): string {
  return `${number(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function number(n: number): string {
  return n.toLocaleString("en-US");
}
