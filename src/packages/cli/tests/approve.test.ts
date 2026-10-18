import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, openCore } from "../../core/index.ts";
import { driftKitCommand } from "../../drift-kit/index.ts";

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

  it("approves a pending plan after showing it, and explains how it gets applied", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, stdout } = await pinfold("approve", id);

    expect(code).toBe(0);
    expect(stdout).toContain('  1. linear.createIssue {"title":"Fix totals"}');
    expect(stdout).toContain(
      `Approved Write Plan ${id}. It is sent when the same code runs again and rebuilds the same plan.`
    );
    expect((await pinfold("plans")).stdout).toBe("No pending Write Plans.\n");
  });

  it("declines a pending plan so that it is never sent", async () => {
    const id = await pendingPlan("Fix totals");

    const { code, stdout } = await pinfold("decline", id);

    expect(code).toBe(0);
    expect(stdout).toContain(
      `Declined Write Plan ${id}. It will never be sent.`
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
