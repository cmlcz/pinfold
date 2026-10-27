import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatStats, readStats, type Core, type Stats } from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

const countIssues = {
  code: `export async function main(input: { project: string }) {
    const { issues } = await sdk.sentry.listIssues(input);
    return issues.reduce((sum, issue) => sum + issue.count, 0);
  }`,
  input: { project: "web" },
};

async function saveCountIssues(core: Core) {
  const explored = await core.explore(countIssues);
  if (!explored.ok) throw new Error(explored.error);
  await core.saveWorkflow({
    run: explored.exploration,
    name: "count_issues",
    confirmed: true,
  });
}

async function appendState(file: string, ...entries: object[]) {
  await mkdir(join(ws.dir, ".pinfold"), { recursive: true });
  await appendFile(
    join(ws.dir, ".pinfold", file),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")
  );
}

describe("readStats", () => {
  it("counts runs, their wall time, Tool calls and response bytes, per Workflow and in total", async () => {
    const core = await ws.open();
    await saveCountIssues(core);
    await core.explore({
      code: "export async function main() { throw new Error('boom'); }",
    });
    await core.runWorkflow({ name: "count_issues", input: { project: "web" } });
    await core.runWorkflow({ name: "count_issues", input: { project: "web" } });

    const stats = await readStats(ws.dir);

    const { explorationRuns, workflowRuns, workflows, total } = stats;
    expect(explorationRuns).toMatchObject({
      runs: 2,
      unmeasured: 0,
      toolCalls: 1,
    });
    expect(explorationRuns.responseBytes).toBeGreaterThan(100);
    expect(workflowRuns).toMatchObject({
      runs: 2,
      toolCalls: 2,
      responseBytes: 2 * explorationRuns.responseBytes,
    });
    expect(workflows).toEqual([{ name: "count_issues", ...workflowRuns }]);
    expect(total).toEqual({
      runs: 4,
      unmeasured: 0,
      ms: explorationRuns.ms + workflowRuns.ms,
      toolCalls: 3,
      responseBytes: 3 * explorationRuns.responseBytes,
    });
    expect(stats.since).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("counts Repairs by who made them", async () => {
    const core = await ws.open({
      servers: { sentry: ws.sentry() },
      classification: sentryReads,
    });
    await saveCountIssues(core);
    await ws.control("sentry").startDrift("rename");

    await core.runWorkflow({ name: "count_issues", input: { project: "web" } });

    expect((await readStats(ws.dir)).repairs).toEqual({
      pinfold: 1,
      agent: 0,
      model: 0,
      migration: 0,
    });
  });

  it("sums the Repair Model's tokens and cost, and keeps runs it did not measure apart", async () => {
    await appendState(
      "model-usage.jsonl",
      {
        at: "2026-10-01T00:00:00.000Z",
        tool: "sentry.listIssues",
        model: "test/small",
        promptTokens: 1200,
        completionTokens: 40,
        cost: 0.0003,
      },
      {
        at: "2026-10-02T00:00:00.000Z",
        tool: "sentry.listIssues",
        model: "test/small",
        promptTokens: 800,
        completionTokens: 10,
      }
    );
    await appendState("runs.jsonl", {
      workflow: "count_issues",
      at: "2026-09-30T00:00:00.000Z",
      status: "complete",
    });

    const stats = await readStats(ws.dir);

    expect(stats.model).toEqual({
      calls: 2,
      promptTokens: 2000,
      completionTokens: 50,
      cost: 0.0003,
    });
    expect(stats.workflowRuns).toEqual({
      runs: 0,
      unmeasured: 1,
      ms: 0,
      toolCalls: 0,
      responseBytes: 0,
    });
    expect(stats.since).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("formatStats", () => {
  const run = { runs: 0, unmeasured: 0, ms: 0, toolCalls: 0, responseBytes: 0 };

  it("shows what pinfold measured, and no estimate of tokens saved", () => {
    const stats: Stats = {
      since: "2026-10-01T00:00:00.000Z",
      explorationRuns: {
        ...run,
        runs: 3,
        ms: 2350,
        toolCalls: 4,
        responseBytes: 18204,
      },
      workflowRuns: {
        ...run,
        runs: 1,
        unmeasured: 2,
        ms: 400,
        toolCalls: 1,
        responseBytes: 4551,
      },
      workflows: [
        {
          name: "count_issues",
          ...run,
          runs: 1,
          unmeasured: 2,
          ms: 400,
          toolCalls: 1,
          responseBytes: 4551,
        },
      ],
      total: {
        ...run,
        runs: 4,
        unmeasured: 2,
        ms: 2750,
        toolCalls: 5,
        responseBytes: 22755,
      },
      repairs: { pinfold: 2, agent: 1, model: 0, migration: 1 },
      model: {
        calls: 1,
        promptTokens: 1200,
        completionTokens: 40,
        cost: 0.0003,
      },
    };

    const text = formatStats(stats);

    expect(text).toBe(
      [
        "Measured by pinfold since 2026-10-01T00:00:00.000Z.",
        "",
        "Exploration Runs: 3 runs, 2.4 s, 4 Tool calls, 18,204 bytes of Tool responses",
        "Workflow Runs: 1 run, 0.4 s, 1 Tool call, 4,551 bytes of Tool responses, and 2 runs from before pinfold measured them",
        "  count_issues: 1 run, 0.4 s, 1 Tool call, 4,551 bytes of Tool responses, and 2 runs from before pinfold measured them",
        "Total: 4 runs, 2.8 s, 5 Tool calls, 22,755 bytes of Tool responses, and 2 runs from before pinfold measured them",
        "",
        "Tool responses stay in the sandbox: the agent reads only what a run returns.",
        "",
        "Repairs: 2 by pinfold, 1 by an agent, 0 by the Repair Model, 1 Baseline Migration",
        "Repair Model: 1 call, 1,200 prompt tokens, 40 completion tokens, 0.0003 credits",
      ].join("\n")
    );
    expect(text).not.toMatch(/sav(ed|ing)/i);
  });

  it("says when nothing was measured yet", () => {
    expect(
      formatStats({
        explorationRuns: run,
        workflowRuns: run,
        workflows: [],
        total: run,
        repairs: { pinfold: 0, agent: 0, model: 0, migration: 0 },
        model: { calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 },
      })
    ).toBe(
      "Nothing measured yet: pinfold has kept no runs, Repairs or Repair Model calls."
    );
  });
});
