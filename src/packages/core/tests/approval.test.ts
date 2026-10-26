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

const writing = {
  code: `export async function main() {
    const ticket = await sdk.linear.createIssue({ title: "Fix totals" });
    return ticket.identifier;
  }`,
};

function paused(result: ExploreResult) {
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("approvalRequest", () => {
  it("shows the Write Plan and what approving it does", async () => {
    const core = await openTriage();
    const run = paused(await core.explore(writing));

    expect(await core.approvalRequest(run)).toBe(
      [
        `Write Plan ${run.plan.id}: 1 write, none sent yet`,
        '  1. linear.createIssue {"title":"Fix totals"}',
        "",
        "Approve to send this write now; decline and no run sends this plan.",
      ].join("\n")
    );
  });

  it("says when the developer declined the same plan before", async () => {
    const core = await openTriage();
    const first = paused(await core.explore(writing));
    await openPlans(ws.dir).decline(first.plan.id);

    const again = paused(await core.explore(writing));

    expect(await core.approvalRequest(again)).toMatch(
      new RegExp(
        `^The developer declined Write Plan ${again.plan.id} before\\.\\n\\nWrite Plan `
      )
    );
  });

  it("says a plan without writes releases a held-back result", async () => {
    const core = await openTriage();
    const run = paused(await core.explore(writing));

    const text = await core.approvalRequest({
      ...run,
      plan: { ...run.plan, writes: [] },
    });

    expect(text).toMatch(
      /Approve to accept the Response Adapters it names and release the result built through them; decline and the result stays held back\.$/
    );
  });
});

describe("answerApproval", () => {
  it("approves a pending plan, and counts one approved in a terminal meanwhile", async () => {
    const core = await openTriage();
    const run = paused(await core.explore(writing));

    expect(await core.answerApproval(run.plan.id, "approve")).toEqual({
      ok: true,
      approved: true,
    });
    expect(await core.answerApproval(run.plan.id, "approve")).toEqual({
      ok: true,
      approved: true,
    });
  });

  it("declines a plan for good, and leaves it pending when dismissed", async () => {
    const core = await openTriage();
    const run = paused(await core.explore(writing));
    const { id } = run.plan;

    const dismissed = await core.answerApproval(id, "dismiss");
    const pendingAfter = await openPlans(ws.dir).pending();
    const declined = await core.answerApproval(id, "decline");

    expect(dismissed).toMatchObject({ ok: true, approved: false });
    expect(pendingAfter.map((plan) => plan.id)).toEqual([id]);
    expect(declined).toMatchObject({
      ok: true,
      approved: false,
      text: expect.stringMatching(/^The developer declined Write Plan /),
    });
    expect(await openPlans(ws.dir).pending()).toEqual([]);
  });

  it("refuses an answer for a plan decided the other way", async () => {
    const core = await openTriage();
    const run = paused(await core.explore(writing));
    await openPlans(ws.dir).decline(run.plan.id);

    expect(await core.answerApproval(run.plan.id, "approve")).toEqual({
      ok: false,
      error: `The answer to the Approval dialog was not taken: Write Plan ${run.plan.id} is declined, not pending.`,
    });
  });
});
