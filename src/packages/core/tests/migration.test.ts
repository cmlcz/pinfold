import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatMigration,
  formatWorkflowRun,
  openPlans,
  type Core,
  type MigrationResult,
  type PinfoldConfig,
  type WorkflowRunResult,
} from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

function openTriage(config: Partial<PinfoldConfig> = {}): Promise<Core> {
  return ws.open({
    servers: { sentry: ws.sentry(), linear: ws.linear() },
    classification: {
      ...sentryReads,
      linear: { searchIssues: "read", createIssue: "write" },
    },
    ...config,
  });
}

const input = { project: "web" };

// Reads count, userCount, status, shortId and culprit, and files tickets.
const triage = `export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const created = [];
  for (const issue of issues.filter((i) => i.count >= 50 && i.status === "unresolved")) {
    const ticket = await sdk.linear.createIssue({ title: issue.shortId, description: issue.culprit });
    created.push(ticket.identifier);
  }
  return { created, users: issues.reduce((sum, i) => sum + i.userCount, 0) };
}`;

// Reads only shortId, and writes nothing.
const shortIds = `export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  return issues.map((i) => i.shortId);
}`;

async function save(core: Core, name: string, code: string) {
  const explored = await core.explore({ code, input });
  if (!explored.ok) throw new Error(explored.error);
  const saved = await core.saveWorkflow({
    run: explored.exploration,
    name,
    confirmed: true,
  });
  if (!saved.ok) throw new Error(saved.error);
}

function succeeded<T extends WorkflowRunResult | MigrationResult>(
  result: T
): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<T, { ok: true }>;
}

async function baselineFile(): Promise<string> {
  const dir = join(ws.dir, ".workflows", "baselines");
  const [file] = (await readdir(dir)).filter((name) =>
    name.startsWith("sentry.listIssues.")
  );
  return join(dir, file!);
}

describe("Baseline Migration", () => {
  it("previews the changes to the Baseline and the Workflows they break, and changes nothing", async () => {
    const core = await openTriage();
    await save(core, "triage_sentry", triage);
    await save(core, "short_ids", shortIds);
    const file = await baselineFile();
    const before = await readFile(file, "utf8");
    await ws.control("sentry").startDrift("rename");

    const preview = succeeded(
      await core.migrateBaseline({
        tool: "sentry.listIssues",
        confirmed: false,
      })
    );

    // Fields the rename left alone keep their Baseline schema, enums too.
    expect(preview.changes).toEqual([
      "- response.issues[].count: number",
      "+ response.issues[].eventCount: number",
    ]);
    expect(preview).toMatchObject({
      status: "preview",
      workflows: [
        { name: "short_ids", problems: [] },
        {
          name: "triage_sentry",
          problems: expect.arrayContaining([
            expect.stringContaining("'count'"),
            "it reads issues[].count, which the new Baseline does not have",
          ]),
        },
      ],
    });
    expect(formatMigration(preview)).toContain(
      [
        "Baseline of sentry.listIssues, against the shape its server gives it now:",
        "  - response.issues[].count: number",
        "  + response.issues[].eventCount: number",
        "Workflow short_ids: checks against the new Baseline.",
        "Workflow triage_sentry: does not check against the new Baseline:",
      ].join("\n")
    );
    expect(formatMigration(preview)).toMatch(
      /Nothing changed yet\. `pinfold baseline migrate sentry\.listIssues --yes` re-pins the Baseline\.$/
    );
    expect(await readFile(file, "utf8")).toBe(before);
    await expect(
      readdir(join(ws.dir, ".workflows", "adapters"))
    ).rejects.toThrow();
  });

  it("re-pins the Baseline, resets the Adapter, and has the next run wait for Approval once", async () => {
    const core = await openTriage();
    await save(core, "short_ids", shortIds);
    expect(
      succeeded(await core.runWorkflow({ name: "short_ids", input })).status
    ).toBe("complete");
    await ws.control("sentry").startDrift("rename");

    const migrated = succeeded(
      await core.migrateBaseline({ tool: "sentry.listIssues", confirmed: true })
    );

    expect(migrated).toMatchObject({ status: "migrated", adapter: 1 });
    const baseline = JSON.parse(await readFile(await baselineFile(), "utf8"));
    const issue = baseline.outputSchema.properties.issues.items;
    expect(Object.keys(issue.properties)).toContain("eventCount");
    expect(Object.keys(issue.properties)).not.toContain("count");
    const adapters = join(ws.dir, ".workflows", "adapters");
    const [adapterFile] = await readdir(adapters);
    expect(
      JSON.parse(await readFile(join(adapters, adapterFile!), "utf8"))
    ).toEqual({ server: "sentry", tool: "listIssues", version: 1, ops: [] });

    const paused = succeeded(
      await core.runWorkflow({ name: "short_ids", input })
    );
    expect(paused).toMatchObject({
      status: "pending",
      approvalReason:
        "the Response Adapter of sentry.listIssues changed since the last finished run of Workflow short_ids",
      repairs: [{ tool: "sentry.listIssues", by: "migration", version: 1 }],
    });
    expect(formatWorkflowRun(paused)).toContain(
      [
        "A Baseline Migration moved sentry.listIssues to the shape its server gives it now, and reset its Response Adapter, now version 1:",
        "Changes to its Baseline:",
        "  - response.issues[].count: number",
        "  + response.issues[].eventCount: number",
      ].join("\n")
    );

    await openPlans(ws.dir).approve(paused.plan.id);
    const done = succeeded(
      await core.runWorkflow({ name: "short_ids", input })
    );
    expect(done).toMatchObject({
      status: "applied",
      value: ["WEB-1A", "WEB-1B", "WEB-1C"],
    });
    expect(
      succeeded(await core.runWorkflow({ name: "short_ids", input })).status
    ).toBe("complete");
  });

  it("resets an Adapter a Repair wrote, and settles the Tool's pending Drift", async () => {
    const core = await openTriage();
    await save(core, "triage_sentry", triage);
    await ws.control("sentry").startDrift("rename");
    expect(
      succeeded(await core.runWorkflow({ name: "triage_sentry", input }))
        .repairs
    ).toHaveLength(1);
    await ws.control("sentry").startDrift("removed-field");
    expect(
      await core.runWorkflow({ name: "triage_sentry", input })
    ).toMatchObject({ ok: false });
    expect(await core.pendingDrift()).toHaveLength(1);

    const migrated = succeeded(
      await core.migrateBaseline({ tool: "sentry.listIssues", confirmed: true })
    );

    expect(migrated.adapter).toBe(2);
    expect(await core.pendingDrift()).toEqual([]);
    const adapters = join(ws.dir, ".workflows", "adapters");
    const [adapterFile, ...others] = await readdir(adapters);
    expect(others).toEqual([]);
    expect(
      JSON.parse(await readFile(join(adapters, adapterFile!), "utf8"))
    ).toEqual({ server: "sentry", tool: "listIssues", version: 2, ops: [] });
    expect(migrated.changes).toEqual([
      "- response.issues[].count: number",
      "- response.issues[].userCount: number",
      "+ response.issues[].eventCount: number",
    ]);
  });

  it("keeps fields the server added invisible to Workflows until a Baseline Migration", async () => {
    const core = await openTriage();
    await save(core, "short_ids", shortIds);
    await ws.control("sentry").startDrift("rename");
    const reads = {
      code: `export async function main(input: { project: string }) {
        const { issues } = await sdk.sentry.listIssues({ project: input.project });
        return issues.map((i) => i.eventCount);
      }`,
      input,
    };

    const before = await core.explore(reads);
    expect(before).toMatchObject({
      ok: false,
      error: expect.stringContaining("eventCount"),
    });

    succeeded(
      await core.migrateBaseline({ tool: "sentry.listIssues", confirmed: true })
    );
    expect(await core.explore(reads)).toMatchObject({
      ok: true,
      value: [128, 73, 210],
    });
  });

  it("says when the Baseline is the live shape already", async () => {
    const core = await openTriage();
    await save(core, "short_ids", shortIds);

    const result = succeeded(
      await core.migrateBaseline({ tool: "sentry.listIssues", confirmed: true })
    );

    expect(result.status).toBe("current");
    expect(formatMigration(result)).toBe(
      "The Baseline of sentry.listIssues is the shape its server gives it now already; nothing to migrate."
    );
  });

  it("refuses a Tool it cannot see the live shape of", async () => {
    const core = await openTriage({
      redact: { sentry: { listIssues: ["arguments.project"] } },
    });
    await save(core, "short_ids", shortIds);

    expect(
      await core.migrateBaseline({ tool: "sentry.nope", confirmed: true })
    ).toEqual({
      ok: false,
      error:
        "Baseline of sentry.nope not migrated: no Downstream Server offers it.",
    });
    expect(
      await core.migrateBaseline({ tool: "sentry.getIssue", confirmed: true })
    ).toEqual({
      ok: false,
      error:
        "Baseline of sentry.getIssue not migrated: it has no Baseline yet; the first run that calls it pins one.",
    });
    expect(
      await core.migrateBaseline({ tool: "sentry.listIssues", confirmed: true })
    ).toEqual({
      ok: false,
      error:
        "Baseline of sentry.listIssues not migrated: the Fixtures hold no call of it whose arguments pinfold can send again, as redaction kept them out.",
    });
  });
});
