import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlans, type Core, type WorkflowRunResult } from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

function openTriage(): Promise<Core> {
  return ws.open({
    servers: { sentry: ws.sentry(), linear: ws.linear() },
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

// Reads only the titles.
const titles = `export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  return issues.map((issue) => issue.title);
}`;

const input = { project: "web" };

async function save(core: Core, name: string, code: string): Promise<void> {
  const explored = await core.explore({ code, input });
  if (!explored.ok) throw new Error(explored.error);
  const saved = await core.saveWorkflow({
    run: explored.exploration,
    name,
    confirmed: true,
  });
  if (!saved.ok) throw new Error(saved.error);
}

function succeeded(
  result: WorkflowRunResult
): Extract<WorkflowRunResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** Saves a Workflow and applies it once, so later runs go unattended. */
async function saveApplied(core: Core, name: string, code = triage) {
  await save(core, name, code);
  const paused = succeeded(await core.runWorkflow({ name, input }));
  expect(paused.status).toBe("pending");
  await openPlans(ws.dir).approve(paused.plan.id);
  const applied = succeeded(await core.runWorkflow({ name, input }));
  expect(applied.status).toBe("applied");
  return applied;
}

async function writeAdapter(ops: unknown[], version = 1): Promise<void> {
  const dir = join(ws.dir, ".workflows", "adapters");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "sentry.listIssues.json"),
    JSON.stringify({ server: "sentry", tool: "listIssues", version, ops })
  );
}

describe("Drift detection", () => {
  it("stops a run whose Contract drifted, before any write, and names the Tool, fields and affected Workflows", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await save(core, "list_titles", titles);
    const linear = ws.control("linear");
    const sent = (await linear.receivedWrites()).length;
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toEqual({
      ok: false,
      error: [
        "Workflow triage_sentry not run: the responses of sentry.listIssues drifted from its Baseline, so the run stopped before it made a Write Plan; nothing was sent.",
        "  issues[].userCount is missing",
        "Affected Workflows: triage_sentry.",
        "pinfold found no Repair to propose: no op of the closed set maps the live responses back to issues[].userCount. The Drift is recorded as pending: the agent can see it and propose a Response Adapter with propose_repair, which the developer then approves.",
        "A Response Adapter for sentry.listIssues in .workflows/adapters/ that maps its responses back to the Baseline repairs every affected Workflow.",
      ].join("\n"),
    });
    expect(await linear.receivedWrites()).toHaveLength(sent);
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("leaves a Workflow alone whose Contract the Drift does not touch", async () => {
    const core = await openTriage();
    await save(core, "list_titles", titles);
    await ws.control("sentry").startDrift("rename");

    const result = succeeded(
      await core.runWorkflow({ name: "list_titles", input })
    );

    expect(result.status).toBe("complete");
    expect(result.value).toHaveLength(3);
  });

  it("fails the run even when the program catches the Drift", async () => {
    const core = await openTriage();
    await save(
      core,
      "careless",
      `export async function main(input: { project: string }) {
        try {
          const { issues } = await sdk.sentry.listIssues({ project: input.project });
          return issues.map((issue) => issue.userCount);
        } catch {
          await sdk.linear.createIssue({ title: "fallback", description: "" });
          return "caught";
        }
      }`
    );
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "careless", input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("  issues[].userCount is missing"),
    });
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("checks responses against a Baseline whose schema holds true, as a server may declare", async () => {
    const dir = join(ws.dir, ".workflows", "baselines");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "sentry.listIssues.json"),
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
              items: { type: "object", properties: { title: true } },
            },
          },
          required: ["issues"],
        },
      })
    );
    const core = await openTriage();
    await save(core, "list_titles", titles);

    const result = succeeded(
      await core.runWorkflow({ name: "list_titles", input })
    );

    expect(result.value).toHaveLength(3);
  });

  it("reports a pagination change, which needs more than a Response Adapter", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("pagination");

    expect(
      await core.runWorkflow({ name: "triage_sentry", input })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("  issues is missing"),
    });
  });
});

describe("Response Adapters", () => {
  it.each([
    [
      "rename",
      [{ op: "rename", from: "issues[].eventCount", to: "issues[].count" }],
    ],
    ["wrap", [{ op: "unwrap", field: "data" }]],
    ["type-change", [{ op: "convert", path: "issues[].count", to: "number" }]],
    [
      "enum-change",
      [
        {
          op: "map",
          path: "issues[].status",
          values: { open: "unresolved", closed: "resolved", muted: "ignored" },
        },
      ],
    ],
    [
      "removed-field",
      [{ op: "default", path: "issues[].userCount", value: 0 }],
    ],
  ])(
    "repairs the %s Drift Scenario without editing the Workflow",
    async (scenario, ops) => {
      const core = await openTriage();
      const before = await saveApplied(core, "triage_sentry");
      await ws.control("sentry").startDrift(scenario);

      await writeAdapter(ops);
      const repaired = succeeded(
        await core.runWorkflow({ name: "triage_sentry", input })
      );

      expect(repaired).toMatchObject({
        status: "pending",
        approvalReason:
          "the Response Adapter of sentry.listIssues changed since Workflow triage_sentry was last applied",
      });
      expect(repaired.plan.writes).toEqual(before.plan.writes);
    }
  );

  it("asks for Approval once per new or changed Adapter, in every Workflow that uses the Tool", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await saveApplied(core, "triage_copy");
    await ws.control("sentry").startDrift("rename");
    await writeAdapter([
      { op: "rename", from: "issues[].eventCount", to: "issues[].count" },
    ]);

    for (const name of ["triage_sentry", "triage_copy"]) {
      const paused = succeeded(await core.runWorkflow({ name, input }));
      expect(paused.approvalReason).toMatch(/Response Adapter/);
      await openPlans(ws.dir).approve(paused.plan.id);
      expect(succeeded(await core.runWorkflow({ name, input })).status).toBe(
        "applied"
      );
    }
    // Approved, the Adapter lets later runs go unattended.
    expect(
      succeeded(await core.runWorkflow({ name: "triage_sentry", input })).status
    ).toBe("applied");

    // A new version is asked about again.
    await writeAdapter(
      [{ op: "rename", from: "issues[].eventCount", to: "issues[].count" }],
      2
    );
    expect(
      succeeded(await core.runWorkflow({ name: "triage_sentry", input }))
    ).toMatchObject({ status: "pending" });
  });

  it("maps the responses an Exploration Run reads", async () => {
    const core = await openTriage();
    await ws.control("sentry").startDrift("wrap");
    await ws.control("sentry").startDrift("type-change");
    await writeAdapter([
      { op: "unwrap", field: "data" },
      { op: "convert", path: "issues[].count", to: "number" },
    ]);

    const result = await core.explore({
      code: `export async function main() {
        const { issues } = await sdk.sentry.listIssues({ project: "web" });
        return issues.map((issue) => issue.count);
      }`,
    });

    expect(result).toMatchObject({ ok: true, value: [128, 73, 210] });
  });

  it("refuses an Adapter outside the closed set of operations, naming its file", async () => {
    const core = await openTriage();
    await writeAdapter([{ op: "eval", code: "1" }]);

    const result = await core.explore({ code: titles, input });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        `${join(ws.dir, ".workflows", "adapters", "sentry.listIssues.json")} is not a valid Response Adapter`
      ),
    });
  });
});
