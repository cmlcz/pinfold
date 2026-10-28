// The lifecycle experiment (H5): one task run many times in a row per Arm,
// with Drift Scenarios turning on along the way. It counts what each Arm
// spends over a Workflow's life: A4 pays once for its Exploration Run and
// then for every Repair and Approval pause; an agent Arm pays every run.
import { openPlans, readStats, type Stats } from "../../core/index.ts";
import type { DriftKitServerName } from "../../drift-kit/index.ts";
import { addUsage, noUsage, type Usage } from "./agent.ts";
import { runAgentArm, type ArmName } from "./arms.ts";
import { startBench, type Bench } from "./bench.ts";
import type { Driver } from "./drivers.ts";
import { saveApplied, type GridScenario } from "./h2.ts";
import { openBudget, stopReason } from "./harness.ts";
import type { AgentArm } from "./surface.ts";
import type { Task } from "./tasks.ts";

export type ScheduledDrift = {
  /** The run before which the scenario turns on, counted from 1. */
  at: number;
  server: DriftKitServerName;
  scenario: string;
};

export type LifecycleRun = {
  arm: ArmName;
  run: number;
  usage: Usage;
  success: boolean;
  /** Whether the run waited for the developer's Approval. */
  paused: boolean;
  /** For A4: the Repairs the run made, by who made them. */
  repairs?: { pinfold: number; model: number };
  /** Why the checker failed the run. */
  problems?: string[];
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
    driver: Driver;
    /** The agent Arms A4 is compared with. */
    arms: readonly AgentArm[];
    budgetUsd: number;
    /**
     * Agent runs at a time, each on Drift Kit servers of its own: the runs
     * are independent, as each starts a fresh project. 1 by default.
     */
    parallel?: number;
    log?: (line: string) => void;
  }
): Promise<LifecycleResult> {
  const { task, input, drift, driver, log = () => {} } = options;
  const parallel = Math.max(1, options.parallel ?? 1);
  const budget = openBudget(options.budgetUsd);
  const agent = async (on: Bench, arm: AgentArm) => {
    // Every lane's run in flight may cost as much as the dearest so far.
    budget.check(parallel);
    const run = await runAgentArm(on, driver, arm, task, input);
    budget.add(run.usage.cost);
    return run;
  };
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
    exploration = (await agent(bench, "A2")).usage;
    const { core, root } = await bench.fresh();
    const setup = await saveApplied(core, root, task, input);
    if (!setup.ok) throw new Error(`${task.name}: ${setup.error}`);
    // A Repair Model, if the environment names one, repairs what pinfold
    // cannot; what it spends is A4's.
    let before = await readStats(root);
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
      const after = await readStats(root);
      const spent = modelSpent(before, after);
      const repairs = {
        pinfold: after.repairs.pinfold - before.repairs.pinfold,
        model: after.repairs.model - before.repairs.model,
      };
      before = after;
      runs.push({
        arm: "A4",
        run,
        usage: spent,
        success: verdict.success,
        paused,
        ...(repairs.pinfold + repairs.model > 0 && { repairs }),
        ...(!result.ok && { error: result.error.split("\n")[0]! }),
      });
      log(
        `A4 run ${run}: ${verdict.success ? "ok" : "failed"}${paused ? ", paused" : ""}${repairs.model > 0 ? `, repaired by the Repair Model for $${spent.cost.toFixed(4)}` : ""}`
      );
    }

    const lanes = [
      bench,
      ...(await Promise.all(
        Array.from({ length: parallel - 1 }, () => startBench())
      )),
    ];
    try {
      for (const arm of options.arms) {
        const done = await runLanes(lanes, options.runs, async (on, run) => {
          // The Drift scheduled up to this run, on this lane's servers.
          await on.dropDrift();
          for (const scheduled of drift.filter((entry) => entry.at <= run)) {
            await on.keepDrift(scheduled.server, scheduled.scenario);
          }
          const ran = await agent(on, arm);
          log(
            `${arm} run ${run}: ${ran.verdict.success ? "ok" : "failed"}, $${ran.usage.cost.toFixed(4)}, $${budget.spent().toFixed(4)} spent`
          );
          return {
            arm,
            run,
            usage: ran.usage,
            success: ran.verdict.success,
            paused: ran.approvals > 0,
            ...(!ran.verdict.success && { problems: ran.verdict.problems }),
            ...(ran.error !== undefined && { error: ran.error }),
          };
        });
        runs.push(...done.runs);
        if (done.stopped !== undefined) return result(done.stopped);
      }
    } finally {
      await Promise.all(lanes.slice(1).map((lane) => lane.close()));
    }
  } catch (error) {
    const reason = stopReason(error);
    if (reason !== undefined) return result(reason);
    throw error;
  } finally {
    await bench.dropDrift();
  }
  return result();
}

/**
 * Runs 1 to `runs` across the lanes, each lane taking the next run when it
 * is free, and returns them in order. A run that stops the benchmark, on
 * the budget or an unavailable model, lets no lane start another; the runs
 * finished are kept.
 */
async function runLanes(
  lanes: readonly Bench[],
  runs: number,
  each: (lane: Bench, run: number) => Promise<LifecycleRun>
): Promise<{ runs: LifecycleRun[]; stopped?: string }> {
  const finished: LifecycleRun[] = [];
  let next = 1;
  let stopped: string | undefined;
  await Promise.all(
    lanes.map(async (lane) => {
      while (stopped === undefined && next <= runs) {
        const run = next++;
        try {
          finished.push(await each(lane, run));
        } catch (error) {
          const reason = stopReason(error);
          if (reason === undefined) throw error;
          stopped ??= reason;
        }
      }
    })
  );
  finished.sort((a, b) => a.run - b.run);
  return { runs: finished, ...(stopped !== undefined && { stopped }) };
}

// What the Repair Model spent between two readings of the stats.
function modelSpent(before: Stats, after: Stats): Usage {
  return {
    ...noUsage,
    promptTokens: after.model.promptTokens - before.model.promptTokens,
    completionTokens:
      after.model.completionTokens - before.model.completionTokens,
    cost: after.model.cost - before.model.cost,
  };
}

/**
 * The lifecycle's totals, cumulative cost and A4's Break-even Point against
 * each agent Arm, as Markdown.
 */
export function formatLifecycle(
  result: LifecycleResult,
  provenance: Record<string, string>
): string {
  const of = (arm: ArmName) => result.runs.filter((run) => run.arm === arm);
  const cumulative = (arm: ArmName) => {
    let total = arm === "A4" ? result.exploration : noUsage;
    return of(arm).map((run) => (total = addUsage(total, run.usage)));
  };
  const agents = [...new Set(result.runs.map((run) => run.arm))].filter(
    (arm) => arm !== "A4"
  );
  const arms: ArmName[] = [...agents, "A4"];
  const totals = new Map(arms.map((arm) => [arm, cumulative(arm)]));
  const a4 = totals.get("A4")!;
  const tokens = (usage: Usage) => usage.promptTokens + usage.completionTokens;
  const repaired = (by: "pinfold" | "model") =>
    of("A4").reduce((sum, run) => sum + (run.repairs?.[by] ?? 0), 0);
  const checkpoints = [
    1,
    10,
    ...result.drift.flatMap((entry) => [entry.at - 1, entry.at]),
    of("A4").length,
  ].filter((run, index, all) => run >= 1 && all.indexOf(run) === index);
  const row = (arm: ArmName) => {
    const runs = of(arm);
    const total = totals.get(arm)!.at(-1) ?? noUsage;
    return `| ${arm} | ${runs.length} | ${runs.filter((run) => !run.success).length} | ${runs.filter((run) => run.paused).length} | ${tokens(total)} | ${total.cost.toFixed(4)} |`;
  };
  const breakEven = (arm: ArmName) => {
    const other = totals.get(arm)!;
    const at = a4.findIndex(
      (usage, index) =>
        other[index] !== undefined && usage.cost <= other[index].cost
    );
    return at === -1
      ? `A4 did not reach its Break-even Point against ${arm} within these runs.`
      : `A4 reached its Break-even Point against ${arm} at run ${at + 1}: from there on, its cumulative cost is at most ${arm}'s.`;
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
    `A4's totals include its Exploration Run, one agent run: ${tokens(result.exploration)} tokens, $${result.exploration.cost.toFixed(4)}, and every Repair: ${repaired("pinfold")} by pinfold's deterministic search, which costs no tokens, and ${repaired("model")} by the Repair Model. A run that paused waited for the developer's Approval of a changed Response Adapter or a new plan.`,
    "",
    "| Arm | Runs | Failed | Approval pauses | Tokens | Cost (USD) |",
    "| :--- | ---: | ---: | ---: | ---: | ---: |",
    ...arms.map(row),
    "",
    ...agents.map(breakEven),
    "",
    "Cumulative cost (USD) by run:",
    "",
    `| Run | ${arms.join(" | ")} |`,
    `| ---: | ${arms.map(() => "---:").join(" | ")} |`,
    ...checkpoints.map(
      (run) =>
        `| ${run} | ${arms.map((arm) => totals.get(arm)![run - 1]?.cost.toFixed(4) ?? "-").join(" | ")} |`
    ),
    "",
  ].join("\n");
}
