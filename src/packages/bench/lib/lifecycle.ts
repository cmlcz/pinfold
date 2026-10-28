// The lifecycle experiment (H5): one task run many times in a row per Arm,
// with Drift Scenarios turning on along the way. It counts what each Arm
// spends over a Workflow's life: A4 pays once for its Exploration Run and
// then for every Repair and Approval pause; A2 pays for every run.
import { openPlans } from "../../core/index.ts";
import type { DriftKitServerName } from "../../drift-kit/index.ts";
import {
  addUsage,
  ModelUnavailable,
  noUsage,
  type ChatModel,
  type Usage,
} from "./agent.ts";
import { runA2 } from "./arms.ts";
import type { Bench } from "./bench.ts";
import { saveApplied } from "./h2.ts";
import { BudgetExceeded, budgeted } from "./harness.ts";
import type { GridScenario } from "./h2.ts";
import type { Task } from "./tasks.ts";

export type ScheduledDrift = {
  /** The run before which the scenario turns on, counted from 1. */
  at: number;
  server: DriftKitServerName;
  scenario: string;
};

export type LifecycleRun = {
  arm: "A2" | "A4";
  run: number;
  usage: Usage;
  success: boolean;
  /** Whether the run waited for the developer's Approval. */
  paused: boolean;
  error?: string;
};

export type LifecycleResult = {
  task: string;
  input: number;
  drift: ScheduledDrift[];
  /** What A4's Exploration Run, an agent solving the task once, cost. */
  exploration: Usage;
  runs: LifecycleRun[];
  stopped?: string;
};

/**
 * The Drift a lifecycle of `runs` runs injects: of the committed grid's
 * mappable scenarios that apply to the task, the first rename, type change
 * and wrap, turning on a quarter, half and three quarters of the way in.
 */
export function lifecycleDrift(
  grid: readonly GridScenario[],
  task: Task,
  runs: number
): ScheduledDrift[] {
  return ["rename", "type-change", "wrap"].flatMap((kind, index) => {
    const entry = grid.find(
      (candidate) =>
        candidate.mappable &&
        candidate.scenario.startsWith(`${kind}:`) &&
        candidate.runs.some((run) => run.task === task.name)
    );
    if (entry === undefined) return [];
    const at = Math.round((runs * (index + 1)) / 4) + 1;
    return [{ at, server: entry.server, scenario: entry.scenario }];
  });
}

export async function runLifecycle(
  bench: Bench,
  options: {
    task: Task;
    input: number;
    runs: number;
    drift: ScheduledDrift[];
    model: ChatModel;
    budgetUsd: number;
    log?: (line: string) => void;
  }
): Promise<LifecycleResult> {
  const { task, input, drift, log = () => {} } = options;
  const model = budgeted(options.model, options.budgetUsd);
  const runs: LifecycleRun[] = [];
  let exploration = noUsage;
  const result = (stopped?: string): LifecycleResult => ({
    task: task.name,
    input,
    drift,
    exploration,
    runs,
    ...(stopped !== undefined && { stopped }),
  });
  const turnOn = async (run: number) => {
    for (const scheduled of drift.filter((entry) => entry.at === run)) {
      await bench.keepDrift(scheduled.server, scheduled.scenario);
    }
  };
  try {
    // A4: an agent explores the task once; the developer saves the task's
    // program as a Workflow and approves its first run.
    exploration = (await runA2(bench, model, task, input)).usage;
    const { core, root } = await bench.fresh();
    const setup = await saveApplied(core, root, task, input);
    if (!setup.ok) throw new Error(`${task.name}: ${setup.error}`);
    for (let run = 1; run <= options.runs; run++) {
      await turnOn(run);
      await bench.reset();
      let result = await core.runWorkflow({
        name: "w",
        input: task.inputs[input]!,
      });
      let paused = false;
      if (
        result.ok &&
        (result.status === "pending" || result.status === "changed")
      ) {
        paused = true;
        await openPlans(root).approve(result.plan.id);
        result = await core.runWorkflow({
          name: "w",
          input: task.inputs[input]!,
        });
      }
      const verdict = task.check(
        task.inputs[input]!,
        await bench.outcome(result.ok ? result.value : undefined)
      );
      runs.push({
        arm: "A4",
        run,
        usage: noUsage,
        success: verdict.success,
        paused,
        ...(!result.ok && { error: result.error.split("\n")[0]! }),
      });
      log(
        `A4 run ${run}: ${verdict.success ? "ok" : "failed"}${paused ? ", paused" : ""}`
      );
    }

    await bench.dropDrift();
    for (let run = 1; run <= options.runs; run++) {
      await turnOn(run);
      const a2 = await runA2(bench, model, task, input);
      runs.push({
        arm: "A2",
        run,
        usage: a2.usage,
        success: a2.verdict.success,
        paused: a2.approvals > 0,
        ...(a2.error !== undefined && { error: a2.error }),
      });
      log(
        `A2 run ${run}: ${a2.verdict.success ? "ok" : "failed"}, $${a2.usage.cost.toFixed(4)}, $${model.spent().toFixed(4)} spent`
      );
    }
  } catch (error) {
    if (error instanceof BudgetExceeded || error instanceof ModelUnavailable) {
      return result(error.message);
    }
    throw error;
  } finally {
    await bench.dropDrift();
  }
  return result();
}

/** The lifecycle's totals, cumulative cost and Break-even Point, as Markdown. */
export function formatLifecycle(
  result: LifecycleResult,
  provenance: Record<string, string>
): string {
  const of = (arm: "A2" | "A4") => result.runs.filter((run) => run.arm === arm);
  const cumulative = (arm: "A2" | "A4") => {
    let total = arm === "A4" ? result.exploration : noUsage;
    return of(arm).map((run) => (total = addUsage(total, run.usage)));
  };
  const a2 = cumulative("A2");
  const a4 = cumulative("A4");
  const tokens = (usage: Usage) => usage.promptTokens + usage.completionTokens;
  const breakEven = a4.findIndex(
    (usage, index) => a2[index] !== undefined && usage.cost <= a2[index].cost
  );
  const checkpoints = [
    1,
    10,
    ...result.drift.flatMap((entry) => [entry.at - 1, entry.at]),
    of("A4").length,
  ].filter((run, index, all) => run >= 1 && all.indexOf(run) === index);
  const row = (arm: "A2" | "A4") => {
    const runs = of(arm);
    const total = (arm === "A2" ? a2 : a4).at(-1) ?? noUsage;
    return `| ${arm} | ${runs.length} | ${runs.filter((run) => !run.success).length} | ${runs.filter((run) => run.paused).length} | ${tokens(total)} | ${total.cost.toFixed(4)} |`;
  };
  return [
    "# Lifecycle experiment",
    "",
    ...Object.entries(provenance).map(([key, value]) => `- ${key}: ${value}`),
    `- Task: ${result.task}, input ${result.input}`,
    ...result.drift.map(
      (entry) =>
        `- Before run ${entry.at}: \`${entry.scenario}\` on ${entry.server}, kept on`
    ),
    ...(result.stopped === undefined
      ? []
      : [`- Stopped early: ${result.stopped}`]),
    "",
    `A4's totals include its Exploration Run, one agent run: ${tokens(result.exploration)} tokens, $${result.exploration.cost.toFixed(4)}. Repairs are deterministic and cost no tokens; a run that paused waited for the developer's Approval of a changed Response Adapter or a new plan.`,
    "",
    "| Arm | Runs | Failed | Approval pauses | Tokens | Cost (USD) |",
    "| :--- | ---: | ---: | ---: | ---: | ---: |",
    row("A2"),
    row("A4"),
    "",
    breakEven === -1
      ? "A4 did not reach its Break-even Point against A2 within these runs."
      : `A4 reached its Break-even Point against A2 at run ${breakEven + 1}: from there on, its cumulative cost is at most A2's.`,
    "",
    "Cumulative cost (USD) by run:",
    "",
    "| Run | A2 | A4 |",
    "| ---: | ---: | ---: |",
    ...checkpoints.map(
      (run) =>
        `| ${run} | ${a2[run - 1]?.cost.toFixed(4) ?? "-"} | ${a4[run - 1]?.cost.toFixed(4) ?? "-"} |`
    ),
    "",
  ].join("\n");
}
