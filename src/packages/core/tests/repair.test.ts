import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentryDriftScenarios } from "../../drift-kit/index.ts";
import {
  chatClient,
  formatProposal,
  formatRepairTasks,
  formatWorkflowRun,
  openPlans,
  reviewPlan,
  type Core,
  type ModelClient,
  type WorkflowRunResult,
} from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

function openTriage(
  workspace = ws,
  options: { model?: ModelClient } = {}
): Promise<Core> {
  return workspace.open(
    {
      servers: { sentry: workspace.sentry(), linear: workspace.linear() },
      classification: {
        ...sentryReads,
        linear: { searchIssues: "read", createIssue: "write" },
      },
    },
    options
  );
}

// Reads count, status and userCount of every issue, and files a ticket for
// each frequent unresolved one.
const triage = `export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const created = [];
  for (const issue of issues.filter((i) => i.count >= 50 && i.status === "unresolved")) {
    const ticket = await sdk.linear.createIssue({ title: issue.shortId, description: issue.culprit });
    created.push(ticket.identifier);
  }
  return { created, users: issues.reduce((sum, i) => sum + i.userCount, 0) };
}`;

const input = { project: "web" };

function succeeded(
  result: WorkflowRunResult
): Extract<WorkflowRunResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** Saves the triage Workflow and applies it once, so later runs go unattended. */
async function saveApplied(core: Core, name: string, workspace = ws) {
  const explored = await core.explore({ code: triage, input });
  if (!explored.ok) throw new Error(explored.error);
  const saved = await core.saveWorkflow({
    run: explored.exploration,
    name,
    confirmed: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  const paused = succeeded(await core.runWorkflow({ name, input }));
  await openPlans(workspace.dir).approve(paused.plan.id);
  return succeeded(await core.runWorkflow({ name, input }));
}

const renameRepair = {
  tool: "sentry.listIssues",
  by: "pinfold",
  digest: expect.any(String),
  version: 1,
  diff: [
    '+ {"op":"rename","from":"issues[].eventCount","to":"issues[].count"}',
  ],
  evidence: [
    "issues[].count: now median 128, range 73–210; in the Fixtures median 128, range 73–210",
  ],
};

describe("Deterministic Repair", () => {
  it("repairs a renamed field, and shows the Adapter diff, value evidence and Write Plan for Approval", async () => {
    const core = await openTriage();
    const before = await saveApplied(core, "triage_sentry");
    const workflowFile = join(ws.dir, ".workflows", "triage_sentry.ts");
    const source = await readFile(workflowFile, "utf8");
    await ws.control("sentry").startDrift("rename");

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow triage_sentry",
      repairs: [renameRepair],
    });
    expect(paused.plan.writes).toEqual(before.plan.writes);
    const view = formatWorkflowRun(paused);
    expect(view).toContain(
      [
        "pinfold repaired the Response Adapter of sentry.listIssues, now version 1:",
        '  + {"op":"rename","from":"issues[].eventCount","to":"issues[].count"}',
        "Value evidence, the live responses through this version next to the Fixtures:",
        "  issues[].count: now median 128, range 73–210; in the Fixtures median 128, range 73–210",
      ].join("\n")
    );
    expect(view).toContain(`Write Plan ${paused.plan.id}`);
    const adapters = join(ws.dir, ".workflows", "adapters");
    const [file, ...others] = await readdir(adapters);
    expect(others).toEqual([]);
    expect(JSON.parse(await readFile(join(adapters, file!), "utf8"))).toEqual({
      server: "sentry",
      tool: "listIssues",
      version: 1,
      ops: [
        { op: "rename", from: "issues[].eventCount", to: "issues[].count" },
      ],
    });

    await openPlans(ws.dir).approve(paused.plan.id);
    const applied = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(applied.status).toBe("applied");
    expect(applied.plan.writes).toEqual(before.plan.writes);
    expect(await readFile(workflowFile, "utf8")).toBe(source);
  });

  it("asks again when the Adapter changed after the developer approved the plan", async () => {
    const core = await openTriage();
    const explored = await core.explore({ code: triage, input });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "triage_sentry",
      confirmed: true,
    });
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    await ws.control("sentry").startDrift("rename");

    const next = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(next).toMatchObject({ status: "pending", repairs: [renameRepair] });
    expect(next.plan.writes).toEqual(first.plan.writes);
    expect(next.plan.id).not.toBe(first.plan.id);
    expect(formatWorkflowRun(next)).toContain(
      `Through the Response Adapters: sentry.listIssues ${next.repairs![0]!.digest}`
    );
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
  });

  it("shows the Repair in the Approval view of every other Workflow that uses the Tool", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await saveApplied(core, "triage_copy");
    await ws.control("sentry").startDrift("rename");
    await core.runWorkflow({ name: "triage_sentry", input });

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_copy", input })
    );

    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow triage_copy",
      repairs: [renameRepair],
    });
  });

  it("records Drift it cannot settle as pending, until the responses fit again", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("The Drift is recorded as pending"),
    });
    expect(await core.pendingDrift()).toEqual([
      {
        tool: "sentry.listIssues",
        workflow: "triage_sentry",
        at: expect.any(String),
        mismatches: [{ path: "issues[].userCount", problem: "is missing" }],
        reads: expect.arrayContaining(["issues[].userCount"]),
        reason:
          "no op of the closed set maps the live responses back to issues[].userCount",
        responses: [
          { arguments: input, response: { issues: expect.any(Array) } },
        ],
      },
    ]);
    await expect(
      readdir(join(ws.dir, ".workflows", "adapters"))
    ).rejects.toThrow();

    await ws.control("sentry").stopDrift("removed-field");
    succeeded(await core.runWorkflow({ name: "triage_sentry", input }));

    expect(await core.pendingDrift()).toEqual([]);
  });

  it("proposes no mapping whose values do not agree with the Fixtures", async () => {
    // A Baseline whose issues hold only a tally, which the server never sends.
    const baselines = join(ws.dir, ".workflows", "baselines");
    await mkdir(baselines, { recursive: true });
    await writeFile(
      join(baselines, "sentry.listIssues.json"),
      JSON.stringify({
        server: "sentry",
        tool: "listIssues",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"],
        },
        outputSchema: {
          type: "object",
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: { tally: { type: "number" } },
                required: ["tally"],
              },
            },
          },
          required: ["issues"],
        },
      })
    );
    const core = await openTriage();
    const explored = await core.explore({
      code: `export async function main(input: { project: string }) {
        const { issues } = await sdk.sentry.listIssues({ project: input.project });
        return issues.map((issue) => issue.tally);
      }`,
      input,
    });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "tallies",
      confirmed: true,
    });

    const result = await core.runWorkflow({ name: "tallies", input });

    // count and userCount both fit a number, but the Fixtures hold no tally
    // to agree with.
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "fits issues[].tally, but its values agree too little with the Fixtures"
      ),
    });
    expect(await core.pendingDrift()).toHaveLength(1);
  });

  it("reports a pagination change as needing a manual fix", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("pagination");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "It needs a manual fix: its responses now come in pages, with nextCursor, and a Response Adapter maps one response without fetching the others."
      ),
    });
    expect(await core.pendingDrift()).toEqual([]);
  });

  it("repairs at least 80% of the mappable Drift Scenarios with no model (H2)", async () => {
    const outcomes: Record<string, string> = {};
    for (const scenario of sentryDriftScenarios) {
      const workspace = await createWorkspace();
      try {
        const core = await openTriage(workspace);
        const before = await saveApplied(core, "triage_sentry", workspace);
        await workspace.control("sentry").startDrift(scenario);
        const result = await core.runWorkflow({ name: "triage_sentry", input });
        if (result.ok && result.repairs !== undefined) {
          // A right Repair rebuilds the Write Plan the Workflow made before.
          expect(result.plan.writes).toEqual(before.plan.writes);
          outcomes[scenario] = "repaired";
        } else if (!result.ok) {
          outcomes[scenario] = /manual fix/.test(result.error)
            ? "manual"
            : "pending";
        } else {
          outcomes[scenario] = "not detected";
        }
      } finally {
        await workspace.close();
      }
    }

    // Pagination needs another call, which no Response Adapter can make.
    const mappable = sentryDriftScenarios.filter(
      (scenario) => scenario !== "pagination"
    );
    const repaired = mappable.filter(
      (scenario) => outcomes[scenario] === "repaired"
    );
    console.info(
      `H2: ${repaired.length} of ${mappable.length} mappable Drift Scenarios repaired deterministically`,
      outcomes
    );
    expect(outcomes.pagination).toBe("manual");
    expect(repaired.length / mappable.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe("Repair through the agent", () => {
  /** Saves and applies the triage Workflow, then removes userCount upstream. */
  async function pendingRemovedField(core: Core) {
    const before = await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");
    const stopped = await core.runWorkflow({ name: "triage_sentry", input });
    if (stopped.ok) throw new Error("the run was not stopped by Drift");
    return { before, stopped };
  }

  const userCountDefault = [
    { op: "default", path: "issues[].userCount", value: 0 },
  ];

  it("never applies an agent's Adapter through a plan approved before it", async () => {
    const core = await openTriage();
    const explored = await core.explore({ code: triage, input });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "triage_sentry",
      confirmed: true,
    });
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    await ws.control("sentry").startDrift("removed-field");
    expect((await core.runWorkflow({ name: "triage_sentry", input })).ok).toBe(
      false
    );
    const proposed = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: userCountDefault,
    });
    if (!proposed.ok) throw new Error(proposed.error);

    const next = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    const review = await reviewPlan(ws.dir, next.plan);

    expect(next.status).toBe("pending");
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
    expect(review).toContain(
      "An agent, through propose_repair, repaired the Response Adapter of sentry.listIssues, now version 1:"
    );
    expect(review).toContain(
      "issues[].userCount: now median 0, range 0–0; in the Fixtures median 61, range 12–88"
    );
  });

  it("has no repair task without pending Drift", async () => {
    const core = await openTriage();

    expect(await core.repairTasks()).toEqual([]);
    expect(formatRepairTasks([])).toBe("No pending Drift.");
    expect(
      await core.proposeRepair({
        tool: "sentry.listIssues",
        ops: userCountDefault,
      })
    ).toEqual({
      ok: false,
      error:
        "Repair of sentry.listIssues not proposed: it has no pending Drift; propose_repair with no ops lists the Tools that have.",
    });
  });

  it("points the stopped run to propose_repair", async () => {
    const core = await openTriage();
    const { stopped } = await pendingRemovedField(core);

    expect(stopped.error).toContain(
      "the agent can see it and propose a Response Adapter with propose_repair, which the developer then approves."
    );
  });

  it("shows the pending Drift with a live response and Fixture values, redacted", async () => {
    const core = await ws.open({
      servers: { sentry: ws.sentry(), linear: ws.linear() },
      classification: {
        ...sentryReads,
        linear: { searchIssues: "read", createIssue: "write" },
      },
      redact: { sentry: { listIssues: ["response.issues[].culprit"] } },
    });
    await pendingRemovedField(core);

    const [task, ...others] = await core.repairTasks();

    expect(others).toEqual([]);
    expect(task).toMatchObject({
      tool: "sentry.listIssues",
      workflow: "triage_sentry",
      mismatches: [{ path: "issues[].userCount", problem: "is missing" }],
      ops: [],
      reads: [
        "issues[].count",
        "issues[].culprit",
        "issues[].shortId",
        "issues[].status",
        "issues[].userCount",
      ],
      fixtureValues: ["issues[].userCount: median 61, range 12–88"],
    });
    const [sample] = task!.responses;
    const issues = (sample!.response as { issues: Record<string, unknown>[] })
      .issues;
    expect(issues[0]).not.toHaveProperty("userCount");
    expect(issues.every((issue) => issue.culprit === "[redacted]")).toBe(true);
    const text = formatRepairTasks([task!]);
    expect(text).toContain(
      "Pending Drift of sentry.listIssues, found by a run of Workflow triage_sentry at "
    );
    expect(text).toContain("  issues[].userCount is missing");
    expect(text).toContain('"culprit":"[redacted]"');
    expect(text).not.toContain("checkout.ts in computeTotal");
  });

  it("checks a proposal against redacted responses, where a redacted value fits", async () => {
    // count is a number the Workflow reads, which redaction turns to text.
    const core = await ws.open({
      servers: { sentry: ws.sentry(), linear: ws.linear() },
      classification: {
        ...sentryReads,
        linear: { searchIssues: "read", createIssue: "write" },
      },
      redact: { sentry: { listIssues: ["response.issues[].count"] } },
    });
    await pendingRemovedField(core);

    const proposed = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: userCountDefault,
    });

    expect(proposed.ok).toBe(true);
  });

  it("redacts the values a Drift moved out of reach of the redaction rules", async () => {
    const core = await ws.open({
      servers: { sentry: ws.sentry(), linear: ws.linear() },
      classification: {
        ...sentryReads,
        linear: { searchIssues: "read", createIssue: "write" },
      },
      redact: { sentry: { listIssues: ["response.issues[].culprit"] } },
    });
    await saveApplied(core, "triage_sentry");
    // The response now sits under data, where the rule does not reach.
    await ws.control("sentry").startDrift("wrap");
    await ws.control("sentry").startDrift("removed-field");
    await core.runWorkflow({ name: "triage_sentry", input });

    const [pending] = await core.pendingDrift();

    const stored = JSON.stringify(pending!.responses);
    expect(stored).not.toContain("checkout.ts in computeTotal");
    expect(stored).not.toContain("WEB-1A");
    const { data } = pending!.responses[0]!.response as {
      data: { issues: Record<string, unknown>[] };
    };
    expect(data.issues[0]).toMatchObject({
      culprit: "[redacted]",
      count: "[redacted]",
    });
    expect(
      await core.proposeRepair({
        tool: "sentry.listIssues",
        ops: [{ op: "unwrap", field: "data" }, ...userCountDefault],
      })
    ).toMatchObject({ ok: true });
  });

  it("keeps the Repair it writes in a git-ignored state directory", async () => {
    const core = await openTriage();
    await pendingRemovedField(core);
    const ignore = join(ws.dir, ".pinfold", ".gitignore");
    await rm(ignore);

    const proposed = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: userCountDefault,
    });

    expect(proposed.ok).toBe(true);
    expect(await readFile(ignore, "utf8")).toBe("*\n");
  });

  it("rejects ops outside the closed set, and ops that leave the Drift, with the reason", async () => {
    const core = await openTriage();
    await pendingRemovedField(core);

    const unknown = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: [{ op: "eval", code: "1" }],
    });
    const leaves = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: [{ op: "rename", from: "issues[].users", to: "issues[].userCount" }],
    });

    expect(unknown).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Repair of sentry\.listIssues not proposed: the ops are not of the closed set:\n/
      ),
    });
    expect(leaves).toEqual({
      ok: false,
      error: [
        "Repair of sentry.listIssues not proposed: through its Response Adapter and these ops, its live responses still do not fit the Baseline where a saved Workflow reads them:",
        "  issues[].userCount is missing.",
      ].join("\n"),
    });
    await expect(
      readdir(join(ws.dir, ".workflows", "adapters"))
    ).rejects.toThrow();
    expect(await core.pendingDrift()).toHaveLength(1);
  });

  it("writes a valid proposal as the next Adapter version, which waits for the developer's Approval", async () => {
    const core = await openTriage();
    const { before } = await pendingRemovedField(core);

    const proposed = await core.proposeRepair({
      tool: "sentry.listIssues",
      ops: userCountDefault,
    });

    if (!proposed.ok) throw new Error(proposed.error);
    const agentRepair = {
      tool: "sentry.listIssues",
      by: "agent",
      digest: expect.any(String),
      version: 1,
      diff: ['+ {"op":"default","path":"issues[].userCount","value":0}'],
      evidence: [
        "issues[].userCount: now median 0, range 0–0; in the Fixtures median 61, range 12–88",
      ],
    };
    expect(proposed).toEqual({
      ok: true,
      repair: agentRepair,
      affected: ["triage_sentry"],
    });
    expect(formatProposal(proposed)).toContain(
      "It is not approved: the next run of Workflow triage_sentry pauses for the developer to approve it in a terminal"
    );
    expect(await core.pendingDrift()).toEqual([]);

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow triage_sentry",
      repairs: [agentRepair],
    });
    expect(formatWorkflowRun(paused)).toContain(
      "An agent, through propose_repair, repaired the Response Adapter of sentry.listIssues, now version 1:"
    );
    expect(paused.plan.writes).toEqual(before.plan.writes);

    await openPlans(ws.dir).approve(paused.plan.id);
    const applied = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(applied.status).toBe("applied");
  });
});

describe("Approval of changed Adapters without writes", () => {
  const counts = `export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  return issues.map((issue) => issue.count);
}`;

  async function saveCounts(core: Core) {
    const explored = await core.explore({ code: counts, input });
    if (!explored.ok) throw new Error(explored.error);
    const saved = await core.saveWorkflow({
      run: explored.exploration,
      name: "counts",
      confirmed: true,
    });
    if (!saved.ok) throw new Error(saved.error);
    return explored.value;
  }

  it("holds back the result of a run through a changed Adapter until the developer approves it", async () => {
    const core = await openTriage();
    const value = await saveCounts(core);
    expect(
      succeeded(await core.runWorkflow({ name: "counts", input })).status
    ).toBe("complete");
    await ws.control("sentry").startDrift("rename");

    const paused = succeeded(await core.runWorkflow({ name: "counts", input }));

    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow counts",
      repairs: [{ tool: "sentry.listIssues", by: "pinfold" }],
      plan: { writes: [] },
    });
    const view = formatWorkflowRun(paused);
    expect(view).toContain(
      `The result is held back until the developer approves the changed Response Adapters it was built through, in a terminal:\n  pinfold approve ${paused.plan.id}`
    );
    expect(view).not.toContain(JSON.stringify(value));

    await openPlans(ws.dir).approve(paused.plan.id);
    const approved = succeeded(
      await core.runWorkflow({ name: "counts", input })
    );
    const after = succeeded(await core.runWorkflow({ name: "counts", input }));

    expect(approved).toMatchObject({ status: "applied", value });
    expect(after).toMatchObject({ status: "complete", value });
  });

  it("asks for Approval of an Adapter that changed since the Workflow was saved", async () => {
    const core = await openTriage();
    await saveCounts(core);
    const adapters = join(ws.dir, ".workflows", "adapters");
    await mkdir(adapters, { recursive: true });
    await writeFile(
      join(adapters, "sentry.listIssues.json"),
      JSON.stringify({
        server: "sentry",
        tool: "listIssues",
        version: 1,
        ops: [{ op: "default", path: "issues[].count", value: 0 }],
      })
    );

    const paused = succeeded(await core.runWorkflow({ name: "counts", input }));

    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since Workflow counts was saved",
    });
  });
});

describe("Repair through the repair model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A model that gives the same answer to every prompt, and keeps them. */
  function scriptedModel(answer: string) {
    const prompts: string[] = [];
    const model: ModelClient = {
      async complete(prompt) {
        prompts.push(prompt);
        return {
          text: answer,
          usage: {
            model: "test/small",
            promptTokens: 1200,
            completionTokens: 40,
            cost: 0.0003,
          },
        };
      },
    };
    return { model, prompts };
  }

  it("repairs pending Drift unattended, and its Repair waits for Approval", async () => {
    const userCountDefault = [
      { op: "default", path: "issues[].userCount", value: 0 },
    ];
    const { model, prompts } = scriptedModel(
      `\`\`\`json\n${JSON.stringify(userCountDefault)}\n\`\`\``
    );
    const core = await openTriage(ws, { model });
    const before = await saveApplied(core, "triage_sentry");
    const sent = await ws.control("linear").receivedWrites();
    await ws.control("sentry").startDrift("removed-field");

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused).toMatchObject({
      status: "pending",
      repairs: [
        {
          tool: "sentry.listIssues",
          by: "model",
          version: 1,
          diff: ['+ {"op":"default","path":"issues[].userCount","value":0}'],
        },
      ],
    });
    expect(paused.plan.writes).toEqual(before.plan.writes);
    expect(await ws.control("linear").receivedWrites()).toEqual(sent);
    expect(formatWorkflowRun(paused)).toContain(
      "The repair model, unattended, repaired the Response Adapter of sentry.listIssues, now version 1:"
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("issues[].userCount is missing");
    expect(await core.pendingDrift()).toEqual([]);
    const usage = await readFile(
      join(ws.dir, ".pinfold", "model-usage.jsonl"),
      "utf8"
    );
    expect(JSON.parse(usage)).toEqual({
      at: expect.any(String),
      tool: "sentry.listIssues",
      model: "test/small",
      promptTokens: 1200,
      completionTokens: 40,
      cost: 0.0003,
    });
  });

  it("keeps the Drift pending when the model's ops do not repair it", async () => {
    const { model } = scriptedModel(
      '[{"op":"rename","from":"issues[].users","to":"issues[].userCount"}]'
    );
    const core = await openTriage(ws, { model });
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "The repair model repaired nothing: Repair of sentry.listIssues not proposed: through its Response Adapter and these ops"
      ),
    });
    expect(await core.pendingDrift()).toHaveLength(1);
  });

  it("calls no model when none is configured", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("The Drift is recorded as pending"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to open with a repair model but no key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(
      ws.open({ repairModel: "openai/gpt-4o-mini" })
    ).rejects.toThrow(
      "repairModel needs the environment variable OPENROUTER_API_KEY, which is not set."
    );
  });

  it("asks an OpenAI-compatible API and reads OpenRouter's usage fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        choices: [{ message: { content: "[]" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost: 0.00001,
        },
      })
    );
    vi.stubGlobal("fetch", fetch);
    const client = chatClient({
      model: "openai/gpt-4o-mini",
      apiKey: "sk-test",
    });

    const answer = await client.complete("Propose ops.");

    expect(answer).toEqual({
      text: "[]",
      usage: {
        model: "openai/gpt-4o-mini",
        promptTokens: 10,
        completionTokens: 2,
        cost: 0.00001,
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Propose ops." }],
    });
  });
});
