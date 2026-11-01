import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, openCore, openPlans } from "../../core/index.ts";
import { connectControl, driftKitCommand } from "../../drift-kit/index.ts";
import { pinfoldInTerminal } from "./terminal.ts";

const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
let dir: string;
let config: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pinfold-cli-"));
  config = join(dir, "pinfold.json");
  await writeFile(
    config,
    JSON.stringify({
      servers: {
        linear: driftKitCommand("linear", { control: join(dir, "l.sock") }),
      },
      classification: { linear: { searchIssues: "read" } },
    })
  );
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function pinfold(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [bin, ...args, "--config", config],
      { timeout: 30_000 }
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const { code, stdout, stderr } = error as {
      code: number;
      stdout: string;
      stderr: string;
    };
    return { code, stdout, stderr };
  }
}

/** Leaves a pending Write Plan behind, as an agent's run_sandbox call would. */
async function pendingPlan(title: string): Promise<string> {
  const core = await openCore(await loadConfig(config), { root: dir });
  try {
    const result = await core.explore({
      code: `export async function main() {
        await sdk.linear.createIssue({ title: ${JSON.stringify(title)} });
      }`,
    });
    if (!result.ok) throw new Error(result.error);
    return result.plan.id;
  } finally {
    await core.close();
  }
}

describe("pinfold plans, approve and decline", () => {
  it("lists pending Write Plans with their IDs and writes", async () => {
    expect((await pinfold("plans")).stdout).toBe("No pending Write Plans.\n");
    const id = await pendingPlan("Fix totals");

    const { code, stdout } = await pinfold("plans");

    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        `Write Plan ${id}: 1 write, none sent yet`,
        '  1. linear.createIssue {"title":"Fix totals"}',
        "",
      ].join("\n")
    );
  });

  it("approves a pending plan after showing it and asking, and explains how it gets applied", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, output } = await pinfoldInTerminal([
      "approve",
      id,
      "--config",
      config,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(
      [
        '  1. linear.createIssue {"title":"Fix totals"}',
        `Approve Write Plan ${id}? Type yes to confirm: yes`,
        `Approved Write Plan ${id}. It is sent when the same code runs again and rebuilds the same plan.`,
      ].join("\n")
    );
    expect((await pinfold("plans")).stdout).toBe("No pending Write Plans.\n");
  });

  it("leaves a plan pending when the developer does not confirm", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, output } = await pinfoldInTerminal(
      ["approve", id, "--config", config],
      "no"
    );

    expect(code).toBe(1);
    expect(output).toContain("Nothing changed.");
    expect((await pinfold("plans")).stdout).toContain(`Write Plan ${id}`);
  });

  it("refuses to approve outside an interactive terminal, as from an agent's shell", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, stderr } = await pinfold("approve", id);

    expect(code).toBe(1);
    expect(stderr).toBe(
      "pinfold approve asks for confirmation in an interactive terminal, so that an agent cannot run it for the developer. Run it yourself in a terminal.\n"
    );
    expect((await pinfold("plans")).stdout).toContain(`Write Plan ${id}`);
  });

  it("declines a pending plan so that it is never sent", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, stdout } = await pinfold("decline", id);

    expect(code).toBe(0);
    expect(stdout).toContain(
      `Declined Write Plan ${id}. It will never be sent; a later run that builds the same plan asks for Approval again.`
    );
    expect((await pinfold("approve", id)).stderr).toMatch(
      /is declined, not pending/
    );
  });

  it("fails clearly for an unknown plan ID", async () => {
    const { code, stderr } = await pinfold("approve", "000000000000");

    expect(code).toBe(1);
    expect(stderr).toMatch(/no Write Plan 000000000000/);
  });
});

/** Leaves a run whose Apply stopped at its first write, and returns its ID. */
async function stoppedRun(): Promise<{ run: string; id: string }> {
  const core = await openCore(await loadConfig(config), { root: dir });
  try {
    const code = `export async function main() {
      await sdk.linear.createIssue({ title: "Fix totals" });
    }`;
    const planned = await core.explore({ code });
    if (!planned.ok) throw new Error(planned.error);
    await openPlans(dir).approve(planned.plan.id);
    await connectControl(join(dir, "l.sock")).failWrite(1);
    const stopped = await core.explore({ code });
    const run =
      !stopped.ok && /`pinfold resume (\S+)`/.exec(stopped.error)?.[1];
    if (!run) throw new Error("the Apply did not stop");
    return { run, id: planned.plan.id };
  } finally {
    await core.close();
  }
}

describe("pinfold resume", () => {
  it("sends the writes a stopped run did not send, then does nothing", async () => {
    const { run, id } = await stoppedRun();

    const inDoubt = await pinfold("resume", run);
    const refused = await pinfold("resolve", run, "1", "not-sent");
    const resolved = await pinfoldInTerminal([
      "resolve",
      run,
      "1",
      "not-sent",
      "--config",
      config,
    ]);
    const resumed = await pinfold("resume", run);
    const again = await pinfold("resume", run);

    expect(inDoubt.code).toBe(1);
    expect(inDoubt.stderr).toContain(`pinfold resolve ${run} 1 not-sent`);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(
      /^pinfold resolve asks for confirmation in an interactive terminal/
    );
    expect(resolved.code).toBe(0);
    expect(resolved.output).toContain(
      `Record write 1 of run ${run} as not sent, so that the next resume sends it? Type yes to confirm: yes\nRecorded write 1 of run ${run} as not sent. \`pinfold resume ${run}\` sends it and the writes after it.\n`
    );
    expect(resumed).toMatchObject({
      code: 0,
      stdout: `Resumed run ${run}: sent write 1 of Write Plan ${id}.\n`,
    });
    expect(again).toMatchObject({
      code: 0,
      stdout: `Run ${run} had already applied Write Plan ${id} in full; nothing was sent.\n`,
    });
  });

  it("fails clearly for an unknown run ID", async () => {
    const { code, stderr } = await pinfold("resume", "nope");

    expect(code).toBe(1);
    expect(stderr).toMatch(/no run nope/);
  });
});

describe("pinfold baseline optional", () => {
  it("asks for confirmation in an interactive terminal only", async () => {
    const { code, stderr } = await pinfold(
      "baseline",
      "optional",
      "linear.createIssue",
      "url"
    );

    expect(code).toBe(1);
    expect(stderr).toMatch(
      /^pinfold baseline optional asks for confirmation in an interactive terminal/
    );
  });

  it("names a Tool that has no Baseline", async () => {
    const { code, output } = await pinfoldInTerminal([
      "baseline",
      "optional",
      "linear.createIssue",
      "url",
      "--config",
      config,
    ]);

    expect(code).toBe(1);
    expect(output).toContain(
      "Make url of linear.createIssue optional in its Baseline? Workflows that read it then run, and may send writes, when it is missing or null. Type yes to confirm: yes\nlinear.createIssue has no Baseline\n"
    );
  });
});

describe("pinfold list", () => {
  it("lists the saved Workflows", async () => {
    expect((await pinfold("list")).stdout).toBe("No saved Workflows.\n");
    const core = await openCore(await loadConfig(config), { root: dir });
    try {
      const result = await core.explore({
        code: `export async function main(input: { title: string }) {
          return sdk.linear.createIssue({ title: input.title });
        }`,
        input: { title: "Fix totals" },
      });
      if (!result.ok) throw new Error(result.error);
      await core.saveWorkflow({
        run: result.exploration,
        name: "file_issue",
        confirmed: true,
      });
    } finally {
      await core.close();
    }

    const { code, stdout } = await pinfold("list");

    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        "file_issue",
        "  inputs: title: string",
        "  tools: linear.createIssue",
        "  last run: never",
        "  status: ready",
        "",
      ].join("\n")
    );
  });
});
