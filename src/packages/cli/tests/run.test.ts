import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, openCore } from "../../core/index.ts";
import { driftKitCommand } from "../../drift-kit/index.ts";

const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));

// Each test runs the CLI in processes of its own, given up to 30 s each.
vi.setConfig({ testTimeout: 30_000 });
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

/** Saves a Workflow that files one Linear issue titled after its input. */
async function saveWorkflow(): Promise<void> {
  const core = await openCore(await loadConfig(config), { root: dir });
  try {
    const result = await core.explore({
      code: `export async function main(input: { title: string; urgent?: boolean }) {
        const issue = await sdk.linear.createIssue({
          title: (input.urgent ? "[urgent] " : "") + input.title,
        });
        return issue.identifier;
      }`,
      input: { title: "Fix totals" },
    });
    if (!result.ok) throw new Error(result.error);
    const saved = await core.saveWorkflow({
      run: result.exploration,
      name: "file_issue",
      confirmed: true,
    });
    if (!saved.ok) throw new Error(saved.error);
  } finally {
    await core.close();
  }
}

describe("pinfold run", () => {
  it("pauses with exit code 3, then applies once approved", async () => {
    await saveWorkflow();

    const paused = await pinfold(
      "run",
      "file_issue",
      "--title",
      "Fix totals",
      "--urgent"
    );

    expect(paused.code).toBe(3);
    expect(paused.stdout).toContain(
      "Paused for Approval: Workflow file_issue has never been applied."
    );
    expect(paused.stdout).toContain(
      '  1. linear.createIssue {"title":"[urgent] Fix totals"}'
    );
    const id = /pinfold approve (\S+)/.exec(paused.stdout)![1]!;

    expect((await pinfold("approve", id)).code).toBe(0);
    const applied = await pinfold(
      "run",
      "file_issue",
      "--urgent",
      "--title=Fix totals"
    );

    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain(`Applied Write Plan ${id}: 1 write sent.`);
    expect((await pinfold("list")).stdout).not.toContain("last run: never");
  });

  it("fails with the reason when the input does not fit", async () => {
    await saveWorkflow();

    const { code, stderr } = await pinfold("run", "file_issue", "--urgent");

    expect(code).toBe(1);
    expect(stderr).toMatch(
      /^Workflow file_issue not run\. The input does not fit main\(input\)/
    );
  });

  it("fails with the reason when the Workflow is not saved", async () => {
    const { code, stderr } = await pinfold("run", "nothing");

    expect(code).toBe(1);
    expect(stderr).toBe(
      "Workflow nothing not run: there is no saved Workflow by that name.\n"
    );
  });
});
