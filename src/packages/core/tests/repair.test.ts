import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentryDriftScenarios } from "../../drift-kit/index.ts";
import {
  formatWorkflowRun,
  openPlans,
  type Core,
  type WorkflowRunResult,
} from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

function openTriage(workspace = ws): Promise<Core> {
  return workspace.open({
    servers: { sentry: workspace.sentry(), linear: workspace.linear() },
    classification: {
      ...sentryReads,
      linear: { searchIssues: "read", createIssue: "write" },
    },
  });
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
        "the Response Adapter of sentry.listIssues changed since Workflow triage_sentry was last applied",
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
        "the Response Adapter of sentry.listIssues changed since Workflow triage_copy was last applied",
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
      error: expect.stringContaining("The Drift is recorded as pending."),
    });
    expect(await core.pendingDrift()).toEqual([
      {
        tool: "sentry.listIssues",
        workflow: "triage_sentry",
        at: expect.any(String),
        mismatches: [{ path: "issues[].userCount", problem: "is missing" }],
        reason:
          "no op of the closed set maps the live responses back to issues[].userCount",
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
