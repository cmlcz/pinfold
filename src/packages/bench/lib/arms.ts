// The Arms the harness compares. A2 is an agent that writes a fresh
// program through pinfold's Gateway on every run; A4 is a saved Workflow
// that runs with no LLM.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { openPlans } from "../../core/index.ts";
import { createGateway } from "../../gateway/index.ts";
import {
  runAgent,
  noUsage,
  type ChatModel,
  type ChatMessage,
  type Usage,
} from "./agent.ts";
import type { Bench } from "./bench.ts";
import { saveApplied } from "./h2.ts";
import type { Verdict } from "./state.ts";
import type { Task } from "./tasks.ts";

export type ArmName = "A2" | "A4";

/** One run of one task by one Arm, as the results record it. */
export type RunRecord = {
  arm: ArmName;
  task: string;
  input: number;
  /** Which of the repeated runs of this task, input and Arm. */
  repeat: number;
  model?: string;
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
 * Arm A2: the agent solves the task from scratch through the Gateway's
 * tools. A Write Plan that waits for Approval is approved at once, as a
 * developer would, and the same call made again; the agent sees only the
 * applied result, and the pause is not timed.
 */
export async function runA2(
  bench: Bench,
  model: ChatModel,
  task: Task,
  input: number
): Promise<Omit<RunRecord, "repeat"> & { transcript: ChatMessage[] }> {
  const { core, root } = await bench.fresh();
  const { server } = createGateway(core, { root });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const client = new Client({ name: "pinfold-bench", version: "0.0.0" });
  await client.connect(clientEnd);
  let approvals = 0;
  let pausedMs = 0;
  try {
    const { tools } = await client.listTools();
    const call = async (name: string, args: unknown): Promise<string> => {
      const text = await callText(client, name, args);
      if (name !== "run_sandbox") return text;
      const paused = Date.now();
      const pending = await openPlans(root).pending();
      if (pending.length === 0) return text;
      for (const plan of pending) await openPlans(root).approve(plan.id);
      approvals += pending.length;
      pausedMs += Date.now() - paused;
      return callText(client, name, args);
    };
    const started = Date.now();
    const run = await runAgent(model, {
      system: agentSystemPrompt,
      prompt: task.instruction(task.inputs[input]!),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema as Record<string, unknown>,
      })),
      call,
    });
    const wallMs = Date.now() - started - pausedMs;
    const value =
      run.answer === undefined ? undefined : parseAnswer(run.answer);
    const verdict = task.check(task.inputs[input]!, await bench.outcome(value));
    return {
      arm: "A2",
      task: task.name,
      input,
      model: model.id,
      usage: run.usage,
      roundTrips: run.roundTrips,
      wallMs,
      approvals,
      verdict,
      ...(run.answer === undefined
        ? { error: "the agent ran out of turns" }
        : { answer: run.answer }),
      transcript: run.transcript,
    };
  } finally {
    await client.close();
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

async function callText(
  client: Client,
  name: string,
  args: unknown
): Promise<string> {
  const result = await client.callTool({
    name,
    arguments: (args ?? {}) as Record<string, unknown>,
  });
  const text = (result.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return result.isError ? `Error: ${text}` : text;
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
