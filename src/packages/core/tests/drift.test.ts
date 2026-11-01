import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeFieldOptional,
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
    const pending = await openPlans(ws.dir).pending();
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toEqual({
      ok: false,
      error: [
        "Workflow triage_sentry not run: the responses of sentry.listIssues drifted from its Baseline, so the run stopped before it made a Write Plan; nothing was sent.",
        "  issues[].userCount is missing",
        "Affected Workflows: triage_sentry.",
        "If the server leaves out issues[].userCount at times, rather than having dropped it, `pinfold baseline optional sentry.listIssues issues[].userCount` makes it optional in the Baseline.",
        "pinfold found no Repair to propose: no op of the closed set maps the live responses back to issues[].userCount. The Drift is recorded as pending: the agent can see it and propose a Response Adapter with propose_repair, which the developer then approves.",
        "A Response Adapter for sentry.listIssues in .workflows/adapters/ that maps its responses back to the Baseline repairs every affected Workflow.",
      ].join("\n"),
    });
    expect(await linear.receivedWrites()).toHaveLength(sent);
    expect(await openPlans(ws.dir).pending()).toEqual(pending);
  });

  it("stops a run that reads a drifted field the saved run never read", async () => {
    const core = await openTriage();
    const verbose = triage
      .replace(
        "description: issue.culprit",
        'description: input.verbose ? issue.culprit + " affects " + issue.userCount + " users" : issue.culprit'
      )
      .replace(
        "main(input: { project: string })",
        "main(input: { project: string; verbose?: boolean })"
      )
      .replace(", users: issues.reduce((sum, i) => sum + i.userCount, 0)", "");
    await saveApplied(core, "verbose_triage", verbose);
    const sent = (await ws.control("linear").receivedWrites()).length;
    await ws.control("sentry").startDrift("removed-field");

    const result = await core.runWorkflow({
      name: "verbose_triage",
      input: { ...input, verbose: true },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("issues[].userCount is missing"),
    });
    expect(await ws.control("linear").receivedWrites()).toHaveLength(sent);
  });

  it("runs an edited Workflow that no longer reads the drifted field", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");
    expect((await core.runWorkflow({ name: "triage_sentry", input })).ok).toBe(
      false
    );
    const file = join(ws.dir, ".workflows", "triage_sentry.ts");
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source.replace(
        ", users: issues.reduce((sum, i) => sum + i.userCount, 0)",
        ""
      )
    );

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({ ok: true, status: "pending" });
  });

  it("keeps pending Drift when a run sees nothing where it drifted", async () => {
    const core = await openTriage();
    await saveApplied(core, "triage_sentry");
    await ws.control("sentry").startDrift("removed-field");
    await core.runWorkflow({ name: "triage_sentry", input });

    succeeded(
      await core.runWorkflow({
        name: "triage_sentry",
        input: { project: "none" },
      })
    );

    expect(await core.pendingDrift()).toHaveLength(1);
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

  it("stops a run that read drifted data, whatever the program made of it", async () => {
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
          "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow triage_sentry",
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

  it("never lets one Workflow take the Adapter Approval of another (#54)", async () => {
    const core = await openTriage();
    await save(core, "list_titles", titles);
    // Files an issue only when asked to.
    const fileIf = `export async function main(input: { project: string; write: boolean }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      if (input.write) return sdk.linear.createIssue({ title: issues[0]!.title, description: "" });
      return issues.length;
    }`;
    const writing = { ...input, write: true };
    const explored = await core.explore({ code: fileIf, input: writing });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "file_if",
      confirmed: true,
    });
    const first = succeeded(
      await core.runWorkflow({ name: "file_if", input: writing })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    expect(
      succeeded(await core.runWorkflow({ name: "file_if", input: writing }))
        .status
    ).toBe("applied");
    await ws.control("sentry").startDrift("rename");
    await writeAdapter([
      { op: "rename", from: "issues[].eventCount", to: "issues[].count" },
    ]);
    const titlesPaused = succeeded(
      await core.runWorkflow({ name: "list_titles", input })
    );
    expect(titlesPaused).toMatchObject({ status: "pending" });
    await openPlans(ws.dir).approve(titlesPaused.plan.id);
    const sent = (await ws.control("linear").receivedWrites()).length;

    // A plan with no writes through the same Adapter, in another Workflow.
    const reading = succeeded(
      await core.runWorkflow({
        name: "file_if",
        input: { ...input, write: false },
      })
    );
    const filing = succeeded(
      await core.runWorkflow({ name: "file_if", input: writing })
    );

    expect(reading.status).toBe("pending");
    expect(reading.plan.id).not.toBe(titlesPaused.plan.id);
    expect(filing.status).toBe("pending");
    expect(await ws.control("linear").receivedWrites()).toHaveLength(sent);
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

describe("Optional fields", () => {
  function openUneven(): Promise<Core> {
    return ws.open({
      servers: {
        uneven: {
          command: process.execPath,
          args: [fileURLToPath(new URL("uneven-server.ts", import.meta.url))],
        },
      },
      classification: { uneven: { get: "read", list: "read" } },
    });
  }

  async function saveUneven(
    core: Core,
    name: string,
    code: string,
    given: unknown
  ) {
    const explored = await core.explore({ code, input: given });
    if (!explored.ok) throw new Error(explored.error);
    const saved = await core.saveWorkflow({
      run: explored.exploration,
      name,
      confirmed: true,
    });
    if (!saved.ok) throw new Error(saved.error);
  }

  it("is no Drift when some elements of an array leave out a field, or hold null", async () => {
    const core = await openUneven();
    await saveUneven(
      core,
      "assignees",
      `export async function main(input: { from: number }) {
        const { issues } = (await sdk.uneven.list({ from: input.from, to: 3 })) as any;
        return issues.map((issue: any) => issue.assignee ?? "nobody");
      }`,
      { from: 2 }
    );

    const result = await core.runWorkflow({
      name: "assignees",
      input: { from: 0 },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "complete",
      value: ["nobody", "nobody", "ana", "ana"],
    });
  });

  it("makes a field optional in a Baseline pinned from one response", async () => {
    const core = await openUneven();
    await saveUneven(
      core,
      "assignee",
      `export async function main(input: { n: number }) {
        const issue: any = await sdk.uneven.get({ n: input.n });
        return issue.assignee ?? "nobody";
      }`,
      { n: 2 }
    );
    const stopped = await core.runWorkflow({
      name: "assignee",
      input: { n: 1 },
    });
    expect(!stopped.ok && stopped.error).toContain(
      "`pinfold baseline optional uneven.get assignee` makes it optional in the Baseline."
    );

    await makeFieldOptional(ws.dir, "uneven.get", "assignee");
    const reopened = await openUneven();

    expect(
      await reopened.runWorkflow({ name: "assignee", input: { n: 1 } })
    ).toMatchObject({ ok: true, value: "nobody" });
    expect(
      await reopened.runWorkflow({ name: "assignee", input: { n: 0 } })
    ).toMatchObject({ ok: true, value: "nobody" });
    await expect(
      makeFieldOptional(ws.dir, "uneven.get", "owner")
    ).rejects.toThrow("The Baseline of uneven.get has no field owner");
    await expect(
      makeFieldOptional(ws.dir, "uneven.nothing", "owner")
    ).rejects.toThrow("uneven.nothing has no Baseline");
  });
});
