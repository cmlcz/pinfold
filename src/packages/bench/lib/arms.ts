// The Arms the harness compares. A1 is an agent with every Downstream
// Server Tool loaded; A2 an agent that writes a fresh program through
// pinfold's Gateway on every run; A3 an agent told to reuse a saved
// program; A4 a saved Workflow that runs with no LLM.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openPlans } from "../../core/index.ts";
import { noUsage, type Usage } from "./agent.ts";
import type { Bench } from "./bench.ts";
import type { Driver } from "./drivers.ts";
import { saveApplied } from "./h2.ts";
import type { Verdict } from "./state.ts";
import { openSurface, type AgentArm } from "./surface.ts";
import type { Task } from "./tasks.ts";

export type ArmName = AgentArm | "A4";

/** One run of one task by one Arm, as the results record it. */
export type RunRecord = {
  arm: ArmName;
  task: string;
  input: number;
  /** Which of the repeated runs of this task, input and Arm. */
  repeat: number;
  /** The driver and model, for an agent Arm. */
  model?: string;
  /** Each model and provider OpenRouter says served the calls. */
  served?: string[];
  usage: Usage;
  roundTrips: number;
  /** Wall time, Approval pauses excluded. */
  wallMs: number;
  /** Write Plans the harness approved on the developer's behalf. */
  approvals: number;
  verdict: Verdict;
  /** What the agent said last, or the Workflow Run's error. */
  answer?: string;
  error?: string;
};

export const agentSystemPrompt =
  "You are a coding agent. Do the developer's task with the tools you have; do not ask the developer anything. When you are done, reply with the task's result as JSON and nothing else.";

/**
 * An agent Arm: the driver's agent does the task through the Arm's
 * Surface, in a fresh working directory. Approval pauses are not timed.
 */
export async function runAgentArm(
  bench: Bench,
  driver: Driver,
  arm: AgentArm,
  task: Task,
  input: number
): Promise<Omit<RunRecord, "repeat"> & { transcript: unknown[] }> {
  const surface = await openSurface(bench, arm, task);
  const workdir = await mkdtemp(join(tmpdir(), "pinfold-agent-"));
  try {
    for (const [path, content] of Object.entries(surface.files)) {
      await mkdir(dirname(join(workdir, path)), { recursive: true });
      await writeFile(join(workdir, path), content);
    }
    const started = Date.now();
    const run = await driver.run({
      system: agentSystemPrompt,
      prompt: task.instruction(task.inputs[input]!),
      surface,
      workdir,
    });
    const wallMs = Date.now() - started - surface.pausedMs();
    const value =
      run.answer === undefined ? undefined : parseAnswer(run.answer);
    const verdict = task.check(task.inputs[input]!, await bench.outcome(value));
    return {
      arm,
      task: task.name,
      input,
      model: driver.id,
      ...(run.served !== undefined && { served: run.served }),
      usage: run.usage,
      roundTrips: run.roundTrips,
      wallMs,
      approvals: surface.approvals(),
      verdict,
      ...(run.answer !== undefined && { answer: run.answer }),
      ...(run.error !== undefined && { error: run.error }),
      transcript: run.transcript,
    };
  } finally {
    await surface.close();
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Arm A4: the task's reference program, saved as a Workflow whose first
 * run the developer approved, runs with no LLM. The setup is not timed;
 * the servers are reset to their seeds before the timed run.
 */
export async function runA4(
  bench: Bench,
  task: Task,
  input: number
): Promise<Omit<RunRecord, "repeat">> {
  const { core, root } = await bench.fresh();
  const setup = await saveApplied(core, root, task, input);
  if (!setup.ok) throw new Error(`${task.name}: ${setup.error}`);
  await bench.reset();
  const started = Date.now();
  const result = await core.runWorkflow({
    name: "w",
    input: task.inputs[input]!,
  });
  let wallMs = Date.now() - started;
  let approvals = 0;
  let final = result;
  // Not expected, since the developer approved this very code; timed
  // without the pause if it happens.
  if (
    result.ok &&
    (result.status === "pending" || result.status === "changed")
  ) {
    approvals = 1;
    await openPlans(root).approve(result.plan.id);
    const rerun = Date.now();
    final = await core.runWorkflow({ name: "w", input: task.inputs[input]! });
    wallMs += Date.now() - rerun;
  }
  const value = final.ok ? final.value : undefined;
  const verdict = task.check(task.inputs[input]!, await bench.outcome(value));
  return {
    arm: "A4",
    task: task.name,
    input,
    usage: noUsage,
    roundTrips: 0,
    wallMs,
    approvals,
    verdict,
    ...(!final.ok && { error: final.error }),
  };
}

/**
 * The JSON an agent answered with: the whole answer, or else the last
 * fenced block in it. Undefined if neither parses.
 */
export function parseAnswer(answer: string): unknown {
  const candidates = [
    answer.trim(),
    ...[...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
      .map((match) => match[1]!.trim())
      .reverse(),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}
