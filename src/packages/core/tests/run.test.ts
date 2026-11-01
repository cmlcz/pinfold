import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWorkflowRun,
  formatWorkflows,
  listWorkflows,
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

const code = `export async function main(input: { project: string; minEvents?: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const created = [];
  for (const issue of issues.filter((i) => i.count >= (input.minEvents ?? 50))) {
    const ticket = await sdk.linear.createIssue({
      title: "[Sentry] " + issue.shortId,
      description: issue.culprit,
    });
    created.push(ticket.identifier);
  }
  return created;
}`;

const input = { project: "web" };

/** Saves the triage code as the Workflow triage_sentry. */
async function saveTriage(core: Core): Promise<void> {
  const result = await core.explore({ code, input });
  if (!result.ok) throw new Error(result.error);
  const saved = await core.saveWorkflow({
    run: result.exploration,
    name: "triage_sentry",
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

const workflowFile = () => join(ws.dir, ".workflows", "triage_sentry.ts");

async function editWorkflow(edit: (source: string) => string): Promise<void> {
  await writeFile(workflowFile(), edit(await readFile(workflowFile(), "utf8")));
}

describe("run_workflow", () => {
  it("pauses a Workflow never applied, then applies it once approved", async () => {
    const core = await openTriage();
    await saveTriage(core);

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused.status).toBe("pending");
    expect(paused.approvalReason).toBe(
      "Workflow triage_sentry has never been applied"
    );
    expect(paused.plan.writes.length).toBeGreaterThan(0);
    expect(formatWorkflowRun(paused)).toContain(
      `Paused for Approval: Workflow triage_sentry has never been applied.`
    );
    expect(formatWorkflowRun(paused)).toContain(
      `pinfold approve ${paused.plan.id}`
    );

    await openPlans(ws.dir).approve(paused.plan.id);
    const applied = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(applied.status).toBe("applied");
    expect(applied.plan.id).toBe(paused.plan.id);
  });

  it("applies unattended once applied before, within the Write Budget", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    succeeded(await core.runWorkflow({ name: "triage_sentry", input }));
    // Only the Exploration Run's plan, which is its own.
    const pending = await openPlans(ws.dir).pending();

    const again = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(again.status).toBe("applied");
    expect(await openPlans(ws.dir).pending()).toEqual(pending);
  });

  it("asks again for a declined plan, even once the Workflow runs unattended", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const plans = openPlans(ws.dir);
    const fewer = {
      name: "triage_sentry",
      input: { ...input, minEvents: 100 },
    };
    const declined = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await plans.decline(declined.plan.id);
    await plans.approve(succeeded(await core.runWorkflow(fewer)).plan.id);
    expect(succeeded(await core.runWorkflow(fewer)).status).toBe("applied");
    const sent = await ws.control("linear").receivedWrites();

    const again = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(again).toMatchObject({
      status: "pending",
      declined: true,
      plan: { id: declined.plan.id },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual(sent);
  });

  it("asks again for a declined plan, even once the Workflow runs unattended", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const plans = openPlans(ws.dir);
    const fewer = {
      name: "triage_sentry",
      input: { ...input, minEvents: 100 },
    };
    const declined = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await plans.decline(declined.plan.id);
    await plans.approve(succeeded(await core.runWorkflow(fewer)).plan.id);
    expect(succeeded(await core.runWorkflow(fewer)).status).toBe("applied");
    const sent = await ws.control("linear").receivedWrites();

    const again = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(again).toMatchObject({
      status: "pending",
      declined: true,
      plan: { id: declined.plan.id },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual(sent);
  });

  it("asks for Approval again for a new Workflow saved under an old name", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    succeeded(await core.runWorkflow({ name: "triage_sentry", input }));
    for (const file of ["triage_sentry.ts", "triage_sentry.json"]) {
      await rm(join(ws.dir, ".workflows", file));
    }
    await saveTriage(core);

    const resaved = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(resaved.status).toBe("pending");
    expect(resaved.approvalReason).toBe(
      "Workflow triage_sentry has never been applied"
    );
  });

  it("asks for Approval again once the code changed, even an edit by an agent", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    succeeded(await core.runWorkflow({ name: "triage_sentry", input }));
    await editWorkflow((source) =>
      source.replace(
        "const created = [];",
        'const created = [];\n  await sdk.linear.createIssue({ title: "added" });'
      )
    );

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(paused.plan.id);
    const applied = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused.status).toBe("pending");
    expect(paused.approvalReason).toBe(
      "the code of Workflow triage_sentry changed since its writes were last approved"
    );
    expect(applied.status).toBe("applied");
    expect(
      succeeded(await core.runWorkflow({ name: "triage_sentry", input })).status
    ).toBe("applied");
  });

  it("asks for Approval of the first writes even after a run without writes was applied", async () => {
    const core = await openTriage();
    const maybe = `export async function main(input: { title?: string }) {
  await sdk.sentry.listIssues({ project: "web" });
  if (input.title !== undefined) await sdk.linear.createIssue({ title: input.title });
}`;
    const explored = await core.explore({ code: maybe, input: {} });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "maybe",
      confirmed: true,
    });
    // An Adapter approved through a run that sends nothing.
    await mkdir(join(ws.dir, ".workflows", "adapters"), { recursive: true });
    await writeFile(
      join(ws.dir, ".workflows", "adapters", "sentry.listIssues.json"),
      JSON.stringify({
        server: "sentry",
        tool: "listIssues",
        version: 1,
        ops: [],
      })
    );
    const held = succeeded(
      await core.runWorkflow({ name: "maybe", input: {} })
    );
    await openPlans(ws.dir).approve(held.plan.id);
    expect(
      succeeded(await core.runWorkflow({ name: "maybe", input: {} })).status
    ).toBe("applied");

    const writing = succeeded(
      await core.runWorkflow({ name: "maybe", input: { title: "t" } })
    );

    expect(writing.status).toBe("pending");
    expect(writing.approvalReason).toBe(
      "Workflow maybe has never been applied"
    );
  });

  it("pauses a Write Plan over the Write Budget", async () => {
    const core = await openTriage();
    await saveTriage(core);
    await editWorkflow((source) =>
      source.replace("writeBudget: 10", "writeBudget: 0")
    );
    const first = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );
    await openPlans(ws.dir).approve(first.plan.id);
    succeeded(await core.runWorkflow({ name: "triage_sentry", input }));

    const paused = succeeded(
      await core.runWorkflow({ name: "triage_sentry", input })
    );

    expect(paused.status).toBe("pending");
    expect(paused.approvalReason).toMatch(/over the Write Budget of 0$/);
  });

  it("gives each run a fresh clock once an approved plan was replaced", async () => {
    const core = await openTriage();
    const daily = `export async function main(input: { tag: string }) {
      const { issues } = await sdk.linear.searchIssues({ query: "" });
      await sdk.linear.createIssue({
        title: input.tag + " n=" + issues.length + " at=" + Date.now(),
      });
    }`;
    const explored = await core.explore({ code: daily, input: { tag: "d" } });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "daily",
      confirmed: true,
    });
    const run = async () =>
      succeeded(await core.runWorkflow({ name: "daily", input: { tag: "d" } }));
    const plans = openPlans(ws.dir);
    const at = (result: { plan: { writes: { arguments: unknown }[] } }) =>
      /at=(\d+)/.exec(JSON.stringify(result.plan.writes[0]!.arguments))![1];

    const first = await run();
    await plans.approve(first.plan.id);
    // Another write changes what the Workflow reads, so its plan changes.
    const other = `export async function main() {
      await sdk.linear.createIssue({ title: "other" });
    }`;
    const otherRun = await core.explore({ code: other });
    if (!otherRun.ok) throw new Error(otherRun.error);
    await plans.approve(otherRun.plan.id);
    await core.explore({ code: other });
    const changed = await run();
    expect(changed.status).toBe("changed");
    await plans.approve(changed.plan.id);
    expect((await run()).status).toBe("applied");

    await sleep(5);
    const later = await run();

    expect(later.status).toBe("applied");
    expect(at(later)).not.toBe(at(first));
  });

  it("validates the input against main's input type", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const pending = await openPlans(ws.dir).pending();

    const result = await core.runWorkflow({
      name: "triage_sentry",
      input: { project: 7 },
    });

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(
      /^Workflow triage_sentry not run\. The input does not fit main\(input\)/
    );
    expect(await openPlans(ws.dir).pending()).toEqual(pending);
  });

  it("refuses a hand-edited Workflow that no longer type-checks", async () => {
    const core = await openTriage();
    await saveTriage(core);
    await editWorkflow((source) =>
      source.replace("sdk.linear.createIssue", "sdk.linear.createIssues")
    );

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(
      /^Workflow triage_sentry not run: it does not type-check against the SDK/
    );
  });

  it("refuses a Workflow without a literal Write Budget", async () => {
    const core = await openTriage();
    await saveTriage(core);
    await editWorkflow((source) =>
      source.replace("writeBudget: 10", "writeBudget: 5 + 5")
    );

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(!result.ok && result.error).toContain(
      "it must export const settings = { writeBudget: <n> }"
    );
  });

  it("stops a run that reads a field its Baseline does not allow, before its Write Plan", async () => {
    const core = await openTriage();
    await saveTriage(core);
    await editWorkflow((source) =>
      source.replace(
        "description: issue.culprit,",
        "description: issue.culprit + (issue as any).gone,"
      )
    );

    const result = await core.runWorkflow({ name: "triage_sentry", input });

    expect(!result.ok && result.error).toBe(
      "Workflow triage_sentry stopped before its Write Plan, so nothing was sent: it reads sentry.listIssues issues[].gone, which its Baseline does not have."
    );
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
  });

  it("runs a Workflow that reads a field its Baseline was pinned without", async () => {
    const core = await ws.open({
      servers: {
        uneven: {
          command: process.execPath,
          args: [fileURLToPath(new URL("uneven-server.ts", import.meta.url))],
        },
      },
      classification: { uneven: { get: "read" } },
    });
    // The first response pins the Baseline; only the second has assignee.
    const explored = await core.explore({
      code: `export async function main() {
        await sdk.uneven.get({ n: 1 });
        const second: any = await sdk.uneven.get({ n: 2 });
        return second.assignee;
      }`,
    });
    if (!explored.ok) throw new Error(explored.error);
    const saved = await core.saveWorkflow({
      run: explored.exploration,
      name: "assignee",
      confirmed: true,
    });
    expect(saved).toMatchObject({ ok: true });

    const result = await core.runWorkflow({ name: "assignee", input: {} });

    expect(result).toMatchObject({
      ok: true,
      status: "complete",
      value: "ana",
    });
  });

  it("keeps the Baselines of Tools named alike but for case apart", async () => {
    const config = {
      servers: {
        uneven: {
          command: process.execPath,
          args: [fileURLToPath(new URL("uneven-server.ts", import.meta.url))],
        },
      },
      classification: {
        uneven: { get: "read" as const, Get: "read" as const },
      },
    };
    const core = await ws.open(config);
    const result = await core.explore({
      code: `export async function main() {
        await sdk.uneven.get({ n: 2 });
        await sdk.uneven.Get({});
      }`,
    });
    expect(result).toMatchObject({ ok: true });

    const files = await readdir(join(ws.dir, ".workflows", "baselines"));
    const pinned = await Promise.all(
      files.map(async (file) =>
        JSON.parse(
          await readFile(join(ws.dir, ".workflows", "baselines", file), "utf8")
        )
      )
    );

    expect(pinned.map((baseline) => baseline.tool).sort()).toEqual([
      "Get",
      "get",
    ]);
  });

  it("keeps the keys of a map out of Baselines and Contracts", async () => {
    const core = await ws.open({
      servers: {
        uneven: {
          command: process.execPath,
          args: [fileURLToPath(new URL("uneven-server.ts", import.meta.url))],
        },
      },
      classification: { uneven: { users: "read" } },
    });
    const explored = await core.explore({
      code: `export async function main() {
        const { byEmail, headers }: any = await sdk.uneven.users({});
        return [byEmail["alice@corp.com"].name, headers["content-type"]];
      }`,
    });
    if (!explored.ok) throw new Error(explored.error);
    await core.saveWorkflow({
      run: explored.exploration,
      name: "users",
      confirmed: true,
    });

    const committed = await Promise.all(
      ["baselines", "."].map(async (sub) => {
        const dir = join(ws.dir, ".workflows", sub);
        const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
        return Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
      })
    );

    expect(committed.flat().join("\n")).not.toContain("alice@corp.com");
    const record = JSON.parse(
      await readFile(join(ws.dir, ".workflows", "users.json"), "utf8")
    );
    expect(record.contract["uneven.users"]).toEqual([
      "byEmail",
      'headers["content-type"]',
    ]);
    expect(await core.runWorkflow({ name: "users", input: {} })).toMatchObject({
      ok: true,
      value: ["Alice", "json"],
    });
  });

  it("checks a Contract against a Baseline whose type is a list of types", async () => {
    const core = await openTriage();
    await saveTriage(core);
    const dir = join(ws.dir, ".workflows", "baselines");
    const [file] = (await readdir(dir)).filter((f) =>
      f.startsWith("sentry.listIssues.")
    );
    const baseline = JSON.parse(await readFile(join(dir, file!), "utf8"));
    baseline.outputSchema = {
      ...baseline.outputSchema,
      type: ["object"],
    };
    await writeFile(join(dir, file!), JSON.stringify(baseline));
    await core.close();
    const reopened = await openTriage();

    const result = await reopened.runWorkflow({ name: "triage_sentry", input });

    expect(result.ok ? "ok" : result.error).toBe("ok");
  });

  it("refuses a Workflow that is not saved", async () => {
    const core = await openTriage();

    const result = await core.runWorkflow({ name: "nothing", input: {} });

    expect(!result.ok && result.error).toBe(
      "Workflow nothing not run: there is no saved Workflow by that name."
    );
  });

  it("records each run in the run history", async () => {
    const core = await openTriage();
    await saveTriage(core);
    expect((await listWorkflows(ws.dir))[0]!.lastRun).toBeUndefined();

    await core.runWorkflow({ name: "triage_sentry", input });
    await core.runWorkflow({ name: "triage_sentry", input: {} });

    const lines = (
      await readFile(join(ws.dir, ".pinfold", "runs.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toMatchObject([
      { workflow: "triage_sentry", status: "pending" },
      { workflow: "triage_sentry", status: "failed" },
    ]);
    expect((await listWorkflows(ws.dir))[0]!.lastRun).toBe(lines[1].at);
  });
});

describe("run_workflow from a command line", () => {
  const schemaCode = (
    type: string
  ) => `export async function main(input: ${type}) {
    return input;
  }`;

  async function saveCode(core: Core, name: string, type: string) {
    const explored = await core.explore({ code: schemaCode(type), input: {} });
    if (!explored.ok) throw new Error(explored.error);
    const saved = await core.saveWorkflow({
      run: explored.exploration,
      name,
      confirmed: true,
    });
    if (!saved.ok) throw new Error(saved.error);
  }

  it("reads each flag as JSON where that fits its field, as text otherwise", async () => {
    const core = await ws.open();
    await saveCode(
      core,
      "flags",
      `{ project: string; minEvents: number; id: string | null; level: "1" | "2"; dry?: boolean; none: number | null }`
    );

    const result = await core.runWorkflow({
      name: "flags",
      commandLine: {
        flags: {
          project: "42",
          minEvents: "50",
          id: "123",
          level: "1",
          dry: true,
          none: "null",
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        project: "42",
        minEvents: 50,
        id: "123",
        level: "1",
        dry: true,
        none: null,
      },
    });
  });

  it("reads flags against main's input type as the code is now", async () => {
    const core = await ws.open();
    await saveCode(core, "edited", "{ limit: number }");
    const file = join(ws.dir, ".workflows", "edited.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "{ limit: number }",
        "{ id: string }"
      )
    );

    const [listed] = await listWorkflows(ws.dir);
    const result = await core.runWorkflow({
      name: "edited",
      commandLine: { flags: { id: "123" } },
    });

    expect(result).toMatchObject({ ok: true, value: { id: "123" } });
    expect(listed!.input).toMatchObject({
      properties: { id: { type: "string" } },
    });
  });

  it("keeps the saved input of an edited Workflow that is refused", async () => {
    const core = await ws.open();
    await saveCode(core, "broken", "{ limit: number }");
    const file = join(ws.dir, ".workflows", "broken.ts");
    const record = join(ws.dir, ".workflows", "broken.json");
    const saved = await readFile(record, "utf8");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "{ limit: number }",
        "{ id: string }) { const n: number = input.id; return n; } function unused("
      )
    );

    const result = await core.runWorkflow({
      name: "broken",
      input: { id: "1" },
    });

    expect(!result.ok && result.error).toMatch(/does not type-check/);
    expect(await readFile(record, "utf8")).toBe(saved);
  });

  it("lists the keys of an index signature among the inputs", async () => {
    const core = await ws.open();
    await saveCode(core, "indexed", "{ byId: Record<number, string> }");

    expect(formatWorkflows(await listWorkflows(ws.dir))).toContain(
      "inputs: byId: { [key: number]: string }"
    );
  });

  it("reads flags for the keys of a number index", async () => {
    const core = await ws.open();
    await saveCode(core, "numbered", "Record<number, string>");

    const result = await core.runWorkflow({
      name: "numbered",
      commandLine: { flags: { "1": "123" } },
    });

    expect(result).toMatchObject({ ok: true, value: { "1": "123" } });
  });

  it("takes one value for a main whose input is not an object", async () => {
    const core = await ws.open();
    await saveCode(core, "search", "string");

    const result = await core.runWorkflow({
      name: "search",
      commandLine: { value: "42", flags: {} },
    });

    expect(result).toMatchObject({ ok: true, value: "42" });
  });
});
