import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatLifecycle,
  lifecycleDrift,
  loopDriver,
  ModelUnavailable,
  runLifecycle,
  startBench,
  tasks,
  type Bench,
  type ChatModel,
  type GridScenario,
} from "../index.ts";

let bench: Bench;
let grid: GridScenario[];

beforeAll(async () => {
  bench = await startBench();
  grid = JSON.parse(
    await readFile(new URL("../h2-scenarios.json", import.meta.url), "utf8")
  ) as GridScenario[];
});

afterAll(() => bench.close());

const task = tasks.find((candidate) => candidate.name === "triage-assign")!;

// An agent that runs the task's reference program as it is, then answers
// with what it returned. Each call costs a cent.
const fakeModel: ChatModel = {
  id: "fake/model@fake",
  async chat(messages) {
    const usage = {
      promptTokens: 1000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 100,
      reasoningTokens: 0,
      cost: 0.01,
    };
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      return {
        message: { role: "assistant", content: last.content.split("\n\n")[0]! },
        usage,
      };
    }
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "run_sandbox",
              arguments: JSON.stringify({
                code: task.program,
                input: task.inputs[0],
              }),
            },
          },
        ],
      },
      usage,
    };
  },
};

describe("the lifecycle experiment", () => {
  it("turns on the grid's first mappable rename, type change and wrap for the task, a quarter of the way apart", () => {
    expect(lifecycleDrift(grid, task, 100)).toEqual([
      { at: 26, server: "github", scenario: "rename:getBlame:authorEmail" },
      {
        at: 51,
        server: "sentry",
        scenario: "type-change:listIssues:issues[].count",
      },
      { at: 76, server: "github", scenario: "wrap:getBlame" },
    ]);
  });

  it("counts each Arm's runs, failures, Approval pauses and cost, with A4's Exploration Run", async () => {
    const drift = lifecycleDrift(grid, task, 8);
    const result = await runLifecycle(bench, {
      task,
      input: 0,
      runs: 8,
      drift,
      driver: loopDriver(fakeModel),
      arms: ["A2"],
      budgetUsd: 1,
    });

    expect(result.stopped).toBeUndefined();
    expect(result.exploration.cost).toBeCloseTo(0.02);
    const a4 = result.runs.filter((run) => run.arm === "A4");
    // Deterministic Repair keeps A4 working through the rename, the type
    // change and the wrap, each Repair waiting once for Approval of the
    // changed Adapter. The wrap of getBlame, whose Adapter already renames
    // a field, is repaired by running that rename again after the unwrap.
    expect(a4.map((run) => [run.run, run.success, run.paused])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, true, true],
      [4, true, false],
      [5, true, true],
      [6, true, false],
      [7, true, true],
      [8, true, false],
    ]);
    expect(a4.flatMap((run) => (run.repairs ? [run.repairs] : []))).toEqual([
      { pinfold: 1, model: 0 },
      { pinfold: 1, model: 0 },
      { pinfold: 1, model: 0 },
    ]);
    const a2 = result.runs.filter((run) => run.arm === "A2");
    expect(a2).toHaveLength(8);
    // The fake agent reruns its first program unchanged, which Drift breaks.
    expect(a2.slice(0, 2).every((run) => run.success)).toBe(true);
    expect(a2.slice(2).some((run) => !run.success)).toBe(true);

    const report = formatLifecycle(result, { "Measured on": "test" });
    expect(report).toContain("| A4 | 8 | 0 | 3 | 2200 | 0.0200 |");
    expect(report).toContain("| A2 | 8 |");
    expect(report).toContain(
      "A4 reached its Break-even Point against A2 at run 1"
    );
  });

  it("gives the same runs on parallel lanes as one at a time", async () => {
    const drift = lifecycleDrift(grid, task, 8);
    const options = {
      task,
      input: 0,
      runs: 8,
      drift,
      driver: loopDriver(fakeModel),
      arms: ["A2"] as const,
      budgetUsd: 1,
    };
    const outcome = (result: Awaited<ReturnType<typeof runLifecycle>>) =>
      result.runs.map(({ arm, run, success, paused }) => [
        arm,
        run,
        success,
        paused,
      ]);

    const sequential = await runLifecycle(bench, options);
    const parallel = await runLifecycle(bench, { ...options, parallel: 3 });

    expect(outcome(parallel)).toEqual(outcome(sequential));
    expect(parallel.runs.filter((run) => run.arm === "A2")).toHaveLength(8);
  });

  it("stops, keeping the runs so far, when the model stays unavailable", async () => {
    // The Exploration Run and the first A2 run take two calls each.
    let calls = 0;
    const failing: ChatModel = {
      id: fakeModel.id,
      chat(messages, tools) {
        if (++calls > 4) {
          throw new ModelUnavailable("fetch failed, after 6 attempts");
        }
        return fakeModel.chat(messages, tools);
      },
    };

    const result = await runLifecycle(bench, {
      task,
      input: 0,
      runs: 3,
      drift: [],
      driver: loopDriver(failing),
      arms: ["A2"],
      budgetUsd: 1,
    });

    expect(result.stopped).toBe("fetch failed, after 6 attempts");
    expect(result.runs.map((run) => [run.arm, run.run])).toEqual([
      ["A4", 1],
      ["A4", 2],
      ["A4", 3],
      ["A2", 1],
    ]);
  });
});
