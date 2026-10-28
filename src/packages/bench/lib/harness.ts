// The benchmark harness: runs tasks across Arms, repeated, under a hard
// budget cap, and writes every run and a summary with its provenance.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelUnavailable, type Usage } from "./agent.ts";
import { runAgentArm, runA4, type ArmName, type RunRecord } from "./arms.ts";
import type { Bench } from "./bench.ts";
import type { Driver } from "./drivers.ts";
import type { Task } from "./tasks.ts";

export type HarnessOptions = {
  tasks: readonly Task[];
  /** Which inputs of each task to run; all three by default. */
  inputs?: readonly number[];
  arms: readonly ArmName[];
  /** Runs of each task, input and Arm, for passᵏ. */
  repeats: number;
  /** What drives the agent Arms. */
  driver?: Driver;
  /** Spending on model calls stops before it would pass this, in USD. */
  budgetUsd: number;
  /** Where runs.jsonl, the transcripts and summary.md go. */
  out: string;
  provenance: Record<string, string>;
  log?: (line: string) => void;
};

export class BudgetExceeded extends Error {}

/**
 * Why a benchmark stops early, keeping the runs so far: the budget cap, or
 * a model that stayed unavailable. Undefined for any other error.
 */
export function stopReason(error: unknown): string | undefined {
  return error instanceof BudgetExceeded || error instanceof ModelUnavailable
    ? error.message
    : undefined;
}

/**
 * Spending on model calls, refused once it might pass the cap: before each
 * run, what was spent plus the dearest run so far must fit.
 */
export function openBudget(budgetUsd: number) {
  let spent = 0;
  let dearest = 0;
  return {
    spent: () => spent,
    /** Throws if `inFlight` runs, each as dear as the dearest, could pass the cap. */
    check(inFlight = 1) {
      if (spent + inFlight * dearest > budgetUsd) {
        throw new BudgetExceeded(
          `the budget of $${budgetUsd} would be passed: $${spent.toFixed(4)} spent, and a run has cost up to $${dearest.toFixed(4)}`
        );
      }
    },
    add(cost: number) {
      spent += cost;
      dearest = Math.max(dearest, cost);
    },
  };
}

export async function runBenchmark(
  bench: Bench,
  options: HarnessOptions
): Promise<{ records: RunRecord[]; stopped?: string }> {
  const { out, log = () => {} } = options;
  await mkdir(join(out, "transcripts"), { recursive: true });
  const { driver } = options;
  const budget = openBudget(options.budgetUsd);
  const records: RunRecord[] = [];
  let stopped: string | undefined;
  runs: for (const task of options.tasks) {
    for (const input of options.inputs ?? [0, 1, 2]) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        for (const arm of options.arms) {
          let record: RunRecord;
          try {
            if (arm !== "A4") {
              if (driver === undefined)
                throw new Error(`${arm} needs a driver`);
              budget.check();
              const { transcript, ...run } = await runAgentArm(
                bench,
                driver,
                arm,
                task,
                input
              );
              budget.add(run.usage.cost);
              record = { ...run, repeat };
              await writeFile(
                join(
                  out,
                  "transcripts",
                  `${arm}-${task.name}-${input}-${repeat}.json`
                ),
                `${JSON.stringify(transcript, null, 2)}\n`
              );
            } else {
              record = { ...(await runA4(bench, task, input)), repeat };
            }
          } catch (error) {
            stopped = stopReason(error);
            if (stopped !== undefined) break runs;
            throw error;
          }
          records.push(record);
          await writeFile(
            join(out, "runs.jsonl"),
            `${JSON.stringify(record)}\n`,
            {
              flag: "a",
            }
          );
          log(
            `${arm} ${task.name}#${input} run ${repeat}: ${record.verdict.success ? "ok" : "failed"}, $${record.usage.cost.toFixed(4)}, ${record.wallMs} ms${driver ? `, $${budget.spent().toFixed(4)} spent` : ""}`
          );
        }
      }
    }
  }
  const summary = formatSummary(records, options.provenance, stopped);
  await writeFile(join(out, "summary.md"), summary);
  await writeFile(
    join(out, "provenance.json"),
    `${JSON.stringify({ ...options.provenance, ...(stopped && { stopped }) }, null, 2)}\n`
  );
  return { records, ...(stopped !== undefined && { stopped }) };
}

/** The metrics per task and Arm, as Markdown. */
export function formatSummary(
  records: readonly RunRecord[],
  provenance: Record<string, string>,
  stopped?: string
): string {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.task}\u0000${record.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows = [...groups.values()].map((runs) => {
    const { task, arm } = runs[0]!;
    const usage = (pick: (usage: Usage) => number) =>
      mean(runs.map((run) => pick(run.usage)));
    const walls = runs.map((run) => run.wallMs);
    return {
      task,
      arm,
      runs: runs.length,
      success: runs.filter((run) => run.verdict.success).length / runs.length,
      passK: passK(runs),
      prompt: usage((u) => u.promptTokens),
      cached: usage((u) => u.cachedTokens),
      cacheWrite: usage((u) => u.cacheWriteTokens),
      completion: usage((u) => u.completionTokens),
      reasoning: usage((u) => u.reasoningTokens),
      cost: usage((u) => u.cost),
      p50: percentile(walls, 0.5),
      p95: percentile(walls, 0.95),
      roundTrips: mean(runs.map((run) => run.roundTrips)),
      unintended: runs.reduce(
        (sum, run) => sum + run.verdict.unintendedWrites.length,
        0
      ),
      approvals: runs.reduce((sum, run) => sum + run.approvals, 0),
    };
  });
  const fixed = (value: number, digits = 0) => value.toFixed(digits);
  return [
    "# Benchmark results",
    "",
    ...Object.entries(provenance).map(([key, value]) => `- ${key}: ${value}`),
    ...(stopped === undefined ? [] : [`- Stopped early: ${stopped}`]),
    "",
    "Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.",
    "",
    "| Task | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |",
    "| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.task} | ${row.arm} | ${row.runs} | ${fixed(row.success * 100)}% | ${fixed(row.passK * 100)}% | ${fixed(row.prompt)} | ${fixed(row.cached)} | ${fixed(row.cacheWrite)} | ${fixed(row.completion)} | ${fixed(row.reasoning)} | ${fixed(row.cost, 4)} | ${fixed(row.p50)} | ${fixed(row.p95)} | ${fixed(row.roundTrips, 1)} | ${row.unintended} | ${row.approvals} |`
    ),
    "",
    ...breakEven(rows),
  ].join("\n");
}

// A4's Break-even Point against each agent Arm per task: the runs after
// which A4's one-time cost, its Exploration Run priced as one run of that
// Arm, is paid back. Drift, Repairs and Approval pauses over a Workflow's
// life are counted in the lifecycle experiment instead.
function breakEven(
  rows: { task: string; arm: string; cost: number }[]
): string[] {
  const arms = [...new Set(rows.map((row) => row.arm))].filter(
    (arm) => arm !== "A4"
  );
  const lines: string[] = [];
  for (const task of new Set(rows.map((row) => row.task))) {
    const a4 = rows.find((row) => row.task === task && row.arm === "A4");
    if (a4 === undefined) continue;
    const cells = arms.map((arm) => {
      const other = rows.find((row) => row.task === task && row.arm === arm);
      if (other === undefined || other.cost <= a4.cost) return "-";
      return String(Math.ceil(other.cost / (other.cost - a4.cost)));
    });
    if (cells.some((cell) => cell !== "-")) {
      lines.push(`| ${task} | ${cells.join(" | ")} |`);
    }
  }
  if (lines.length === 0) return [];
  return [
    "Break-even Point of A4 against each agent Arm, in runs, with A4's Exploration Run priced as one run of that Arm:",
    "",
    `| Task | ${arms.map((arm) => `Against ${arm}`).join(" | ")} |`,
    `| :--- | ${arms.map(() => "---:").join(" | ")} |`,
    ...lines,
    "",
  ];
}

// The share of inputs whose every repeated run succeeded.
function passK(runs: readonly RunRecord[]): number {
  const byInput = new Map<number, boolean>();
  for (const run of runs) {
    byInput.set(
      run.input,
      (byInput.get(run.input) ?? true) && run.verdict.success
    );
  }
  const all = [...byInput.values()];
  return all.filter(Boolean).length / all.length;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// The nearest-rank percentile.
function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}
