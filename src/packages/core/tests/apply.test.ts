import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
      /^Apply stopped at write 2 of 2 \(linear\.createIssue\): .*Sent: write 1\. Not sent: write 2\. `pinfold resume \S+` sends the writes not sent\.$/s
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
    // The other run either found the plan being applied, or ran after the
    // Apply and found nothing left to write; it never sends the plan again.
    const other = results.find((r) => !r.ok || r.status !== "applied")!;
    if (other.ok) expect(other.status).toBe("complete");
    else expect(other.error).toMatch(/is being applied by another run/);
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

  it("does not resolve a Placeholder path through inherited members", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        const ticket = await sdk.linear.createIssue({ title: "Once" });
        // Every object inherits constructor; a real result does not own it.
        return ticket.constructor;
      }`,
    };
    const id = planId(await core.explore(code));
    await openPlans(ws.dir).approve(id);

    const result = await core.explore(code);

    expect(!result.ok && result.error).toMatch(
      /Its result could not be built: <write 1>\.constructor has no value/
    );
  });

  it("lets the developer decline a plan whose Apply stopped half-way", async () => {
    const core = await openTriage();
    const code = {
      code: `export async function main() {
        await sdk.linear.createIssue({ title: "Once" });
      }`,
    };
    const id = planId(await core.explore(code));
    const plans = openPlans(ws.dir);
    await plans.approve(id);
    // A run that claimed the plan and then died before finishing.
    const claimed = (await readdir(join(ws.dir, ".pinfold", "plans"))).find(
      (file) => file.endsWith(".json")
    );
    await writeFile(
      join(ws.dir, ".pinfold", "plans", claimed!.replace(/\.json$/, ".claim")),
      ""
    );

    const stuck = await core.explore(code);
    await plans.decline(id);
    const after = await core.explore(code);

    expect(!stuck.ok && stuck.error).toMatch(
      new RegExp(`pinfold decline ${id}`)
    );
    expect(after).toMatchObject({ ok: true, status: "declined" });
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
  });

  it("never sends a plan once a decline succeeded, even racing an approval", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(triage));
    const plans = openPlans(ws.dir);

    const [, declined] = await Promise.allSettled([
      plans.approve(id),
      plans.decline(id),
    ]);

    expect(declined.status).toBe("fulfilled");
    expect(await core.explore(triage)).toMatchObject({
      ok: true,
      status: "declined",
    });
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
  });

  it("keeps working when one plan file is unreadable", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(triage));
    await writeFile(
      join(ws.dir, ".pinfold", "plans", "broken.json"),
      "{ not json"
    );

    const plans = openPlans(ws.dir);

    expect((await plans.pending()).map((plan) => plan.id)).toEqual([id]);
    await plans.approve(id);
    expect(await core.explore(triage)).toMatchObject({
      ok: true,
      status: "applied",
    });
  });

  it("keeps one pending record when two runs of new code race", async () => {
    const core = await openTriage();

    const results = await Promise.all([
      core.explore(triage),
      core.explore(triage),
      core.explore(triage),
    ]);

    expect(results.every((r) => r.ok && r.status === "pending")).toBe(true);
    expect(await openPlans(ws.dir).pending()).toHaveLength(1);
  });

  it("applies an approved plan built from the time and Math.random", async () => {
    const core = await openTriage();
    const stamped = {
      code: `export async function main() {
        const ticket = await sdk.linear.createIssue({
          title: "At " + new Date().toISOString() + " " + Date.now(),
          description: String(Math.random()),
        });
        return ticket.identifier;
      }`,
    };
    const first = await core.explore(stamped);
    await openPlans(ws.dir).approve(planId(first));

    const second = await core.explore(stamped);

    expect(second).toMatchObject({
      ok: true,
      status: "applied",
      plan: { id: planId(first) },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual([
      {
        tool: "createIssue",
        arguments: first.ok && first.plan.writes[0]!.arguments,
      },
    ]);
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

// Four writes; the last one uses the first one's real result.
const fourWrites = {
  code: `export async function main() {
    const first = await sdk.linear.createIssue({ title: "One" });
    await sdk.linear.createIssue({ title: "Two" });
    await sdk.linear.createIssue({ title: "Three" });
    await sdk.linear.createIssue({ title: "Four", description: first.url });
  }`,
};

/** The run ID that a stopped Apply tells the developer to resume. */
function stoppedRun(result: ExploreResult): string {
  if (result.ok) throw new Error(`run ${result.status}, not stopped`);
  const run = /`pinfold resume (\S+)`/.exec(result.error)?.[1];
  if (run === undefined) throw new Error(result.error);
  return run;
}

async function sentTitles(): Promise<unknown[]> {
  const writes = await ws.control("linear").receivedWrites();
  return writes.map((write) => write.arguments.title);
}

describe("Apply Journal and resume", () => {
  it("stops at the first failed write and says which writes were sent", async () => {
    const core = await openTriage();
    await openPlans(ws.dir).approve(planId(await core.explore(fourWrites)));
    await ws.control("linear").failWrite(3);

    const result = await core.explore(fourWrites);

    expect(!result.ok && result.error).toMatch(
      /^Apply stopped at write 3 of 4 \(linear\.createIssue\): .*Sent: writes 1–2\. Not sent: writes 3–4\. `pinfold resume \S+` sends the writes not sent\.$/s
    );
    expect(await sentTitles()).toEqual(["One", "Two"]);
  });

  it("resumes a stopped run by sending only the writes not sent", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(fourWrites));
    await openPlans(ws.dir).approve(id);
    await ws.control("linear").failWrite(3);
    const run = stoppedRun(await core.explore(fourWrites));

    const resumed = await core.resume(run);

    expect(resumed).toMatchObject({ run, plan: { id }, sent: [3, 4] });
    const writes = await ws.control("linear").receivedWrites();
    expect(writes.map((write) => write.arguments)).toEqual([
      { title: "One" },
      { title: "Two" },
      { title: "Three" },
      { title: "Four", description: "https://linear.example/issue/ENG-102" },
    ]);
  });

  it("stops a resumed run again at its next failed write", async () => {
    const core = await openTriage();
    await openPlans(ws.dir).approve(planId(await core.explore(fourWrites)));
    await ws.control("linear").failWrite(2);
    const run = stoppedRun(await core.explore(fourWrites));
    await ws.control("linear").failWrite(2);

    await expect(core.resume(run)).rejects.toThrow(
      /Apply stopped at write 3 of 4 .*Sent: writes 1–2\. Not sent: writes 3–4\./s
    );
    expect(await core.resume(run)).toMatchObject({ sent: [3, 4] });
    expect(await sentTitles()).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("sends nothing when resuming a run that was fully applied", async () => {
    const core = await openTriage();
    await openPlans(ws.dir).approve(planId(await core.explore(fourWrites)));
    await ws.control("linear").failWrite(4);
    const run = stoppedRun(await core.explore(fourWrites));
    await core.resume(run);

    const again = await core.resume(run);

    expect(again).toMatchObject({ run, sent: [] });
    expect(await sentTitles()).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("sends each write once when two resumes race", async () => {
    const core = await openTriage();
    await openPlans(ws.dir).approve(planId(await core.explore(fourWrites)));
    await ws.control("linear").failWrite(1);
    const run = stoppedRun(await core.explore(fourWrites));

    await Promise.allSettled([core.resume(run), core.resume(run)]);
    await Promise.allSettled([core.resume(run)]);

    expect(await sentTitles()).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("resumes a run whose Apply stopped before it could record the stop", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(fourWrites));
    await openPlans(ws.dir).approve(id);
    // A run that claimed the plan and then died before sending anything.
    const dir = join(ws.dir, ".pinfold", "plans");
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"))!;
    const record = await readFile(join(dir, file), "utf8");
    await writeFile(
      join(dir, file),
      record.replace('"approved"', '"applying"')
    );
    await writeFile(join(dir, file.replace(/\.json$/, ".claim")), "");
    const run = stoppedRun(await core.explore(fourWrites));

    expect(await core.resume(run)).toMatchObject({ sent: [1, 2, 3, 4] });
    expect(await core.explore(fourWrites)).toMatchObject({ status: "pending" });
    expect(await sentTitles()).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("never deduplicates a new run against an earlier one", async () => {
    const core = await openTriage();
    const plans = openPlans(ws.dir);
    const first = planId(await core.explore(fourWrites));
    await plans.approve(first);
    await core.explore(fourWrites);

    const second = await core.explore(fourWrites);
    await plans.approve(planId(second));
    const applied = await core.explore(fourWrites);

    expect(applied).toMatchObject({ ok: true, status: "applied" });
    expect(await sentTitles()).toEqual([
      ...["One", "Two", "Three", "Four"],
      ...["One", "Two", "Three", "Four"],
    ]);
  });

  it("refuses to resume a run it does not know or that never started applying", async () => {
    const core = await openTriage();
    const id = planId(await core.explore(fourWrites));
    const [pending] = await openPlans(ws.dir).pending();

    await expect(core.resume("nope")).rejects.toThrow(/no run nope/);
    await expect(core.resume(pending!.record)).rejects.toThrow(
      new RegExp(`Write Plan ${id} is pending; there is nothing to resume`)
    );
    expect(await sentTitles()).toEqual([]);
  });
});

describe("Declining a Write Plan that is being applied", () => {
  it("stops the Apply before its next write, for good", async () => {
    const gate = join(ws.dir, "gate");
    await mkdir(gate);
    const core = await ws.open({
      servers: {
        gated: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("gated-server.ts", import.meta.url)),
            gate,
          ],
        },
      },
      classification: {},
    });
    const code = {
      code: `export async function main() {
        for (let n = 1; n <= 3; n++) await sdk.gated.send({ n });
      }`,
    };
    const plans = openPlans(ws.dir);
    const id = planId(await core.explore(code));
    await plans.approve(id);
    const release = (n: number) => writeFile(join(gate, `release-${n}`), "");
    const until = async (file: string) => {
      while (!existsSync(join(gate, file))) await sleep(10);
    };

    const applying = core.explore(code);
    await release(1);
    await until("started-2");
    const declined = await plans.decline(id);
    await release(2);
    await release(3);
    const result = await applying;

    expect(declined.previous).toBe("applying");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^The developer declined this Write Plan, so the Apply stopped before write 3 of 3\. Sent: writes 1–2\. Not sent: write 3\.$/
      ),
    });
    expect(existsSync(join(gate, "sent-3"))).toBe(false);
    expect((await plans.pending()).map((plan) => plan.id)).not.toContain(id);
    await expect(core.resume(`${id}-1`)).rejects.toThrow(
      `Write Plan ${id} is declined; there is nothing to resume.`
    );
    expect(await core.explore(code)).toMatchObject({ status: "declined" });
    expect(existsSync(join(gate, "sent-3"))).toBe(false);
  });
});
