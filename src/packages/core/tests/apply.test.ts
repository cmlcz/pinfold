import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlans, type Core, type ExploreResult } from "../index.ts";
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

// Creates a Linear issue for each frequent Sentry issue that has none yet.
const triage = {
  code: `export async function main(input: { project: string }) {
    const { issues } = await sdk.sentry.listIssues({ project: input.project });
    const created = [];
    for (const issue of issues.filter((i) => i.count >= 50 && i.status === "unresolved")) {
      const { issues: existing } = await sdk.linear.searchIssues({ query: issue.culprit });
      if (existing.length > 0) continue;
      const ticket = await sdk.linear.createIssue({
        title: "[Sentry] " + issue.shortId,
        description: issue.culprit,
      });
      created.push(ticket.identifier);
    }
    return created;
  }`,
  input: { project: "web" },
};

function planId(result: ExploreResult): string {
  if (!result.ok) throw new Error(result.error);
  return result.plan.id;
}

describe("Approval and Apply", () => {
  it("leaves a Write Plan pending until the developer approves it", async () => {
    const core = await openTriage();

    const result = await core.explore(triage);

    expect(result).toMatchObject({ ok: true, status: "pending" });
    const pending = await openPlans(ws.dir).pending();
    expect(pending.map((plan) => plan.id)).toEqual([planId(result)]);
    expect(pending[0]!.writes).toHaveLength(2);
  });

  it("applies the approved plan when the same code runs again, and returns real results", async () => {
    const core = await openTriage();
    const first = await core.explore(triage);
    await openPlans(ws.dir).approve(planId(first));

    const second = await core.explore(triage);

    expect(second).toMatchObject({
      ok: true,
      status: "applied",
      value: ["ENG-102", "ENG-103"],
      plan: { id: planId(first) },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual([
      {
        tool: "createIssue",
        arguments: {
          title: "[Sentry] WEB-1A",
          description: "checkout.ts in computeTotal",
        },
      },
      {
        tool: "createIssue",
        arguments: {
          title: "[Sentry] WEB-1B",
          description: "sync-worker.ts in flushQueue",
        },
      },
    ]);
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("feeds a write's real result into a later write that used its Placeholder", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        const parent = await sdk.linear.createIssue({ title: "Parent" });
        await sdk.linear.createIssue({ title: "Child", description: parent.url });
        return parent.id;
      }`,
    };
    await openPlans(ws.dir).approve(planId(await core.explore(code)));

    const result = await core.explore(code);

    expect(result).toMatchObject({
      ok: true,
      status: "applied",
      value: "lin-2",
    });
    expect((await ws.control("linear").receivedWrites())[1]).toEqual({
      tool: "createIssue",
      arguments: {
        title: "Child",
        description: "https://linear.example/issue/ENG-102",
      },
    });
  });

  it("sends nothing and reports the difference when the plan changed after Approval", async () => {
    const core = await openTriage();
    const approved = planId(await core.explore(triage));
    await openPlans(ws.dir).approve(approved);

    // Meanwhile someone files a Linear issue for one of the culprits.
    const other = {
      code: `export async function main() {
        await sdk.linear.createIssue({ title: "Checkout", description: "checkout.ts in computeTotal" });
      }`,
    };
    await openPlans(ws.dir).approve(planId(await core.explore(other)));
    await core.explore(other);
    const sentBefore = await ws.control("linear").receivedWrites();

    const result = await core.explore(triage);

    expect(result).toMatchObject({
      ok: true,
      status: "changed",
      approved: { id: approved, writes: [{}, {}] },
      plan: { writes: [{ arguments: { title: "[Sentry] WEB-1B" } }] },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual(sentBefore);
    expect((await openPlans(ws.dir).pending()).map((plan) => plan.id)).toEqual([
      planId(result),
    ]);
  });

  it("never sends a declined plan", async () => {
    const core = await openTriage();
    const declined = planId(await core.explore(triage));
    await openPlans(ws.dir).decline(declined);

    const result = await core.explore(triage);

    expect(result).toMatchObject({
      ok: true,
      status: "declined",
      plan: { id: declined },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("refuses to approve a plan that is not pending", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(triage));
    const plans = openPlans(ws.dir);
    await plans.decline(id);

    await expect(plans.approve(id)).rejects.toThrow(/is declined, not pending/);
    await expect(plans.approve("000000000000")).rejects.toThrow(
      /no Write Plan 000000000000/
    );
  });

  it("never sends a plan again after one of its writes failed", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        await sdk.linear.createIssue({ title: "Sent" });
        // @ts-expect-error -- the server rejects a numeric title
        await sdk.linear.createIssue({ title: 42 });
      }`,
    };
    await openPlans(ws.dir).approve(planId(await core.explore(code)));

    const failed = await core.explore(code);
    const again = await core.explore(code);

    expect(failed).toMatchObject({ ok: false });
    expect(!failed.ok && failed.error).toMatch(
      /^Apply stopped at write 2 of 2 \(linear\.createIssue\): .*Writes sent: 1; not sent: 1\.$/s
    );
    expect(again).toMatchObject({ ok: false });
    expect(!again.ok && again.error).toMatch(/stopped after a failed write/);
    expect(await ws.control("linear").receivedWrites()).toHaveLength(1);
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("applies an approved plan once, even when two runs race for it", async () => {
    const core = await openTriage();
    await openPlans(ws.dir).approve(planId(await core.explore(triage)));

    const results = await Promise.all([
      core.explore(triage),
      core.explore(triage),
    ]);

    expect(results.filter((r) => r.ok && r.status === "applied")).toHaveLength(
      1
    );
    expect(await ws.control("linear").receivedWrites()).toHaveLength(2);
  });

  it("asks for Approval again when an applied plan's code runs again", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        await sdk.linear.createIssue({ title: "Once" });
      }`,
    };
    const id = planId(await core.explore(code));
    await openPlans(ws.dir).approve(id);
    await core.explore(code);

    const again = await core.explore(code);

    expect(again).toMatchObject({ ok: true, status: "pending", plan: { id } });
    expect(await ws.control("linear").receivedWrites()).toHaveLength(1);
    expect((await openPlans(ws.dir).pending()).map((plan) => plan.id)).toEqual([
      id,
    ]);
  });

  it("keeps a plan applied and says so when its result cannot be built", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        const ticket = await sdk.linear.createIssue({ title: "Once" });
        // @ts-expect-error -- the real result has no such field
        return ticket.missing;
      }`,
    };
    const id = planId(await core.explore(code));
    await openPlans(ws.dir).approve(id);

    const result = await core.explore(code);

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(
      new RegExp(
        `^Applied Write Plan ${id}: 1 write sent\\. Its result could not be built: <write 1>\\.missing`
      )
    );
    expect(await core.explore(code)).toMatchObject({
      ok: true,
      status: "pending",
    });
    expect(await ws.control("linear").receivedWrites()).toHaveLength(1);
  });

  it("completes a run without writes at once", async () => {
    const core = await openTriage();

    const result = await core.explore({
      code: `export async function main() { return 1; }`,
    });

    expect(result).toMatchObject({ ok: true, status: "complete", value: 1 });
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });
});
