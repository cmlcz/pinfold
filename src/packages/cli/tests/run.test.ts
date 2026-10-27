import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, openCore } from "../../core/index.ts";
import { driftKitCommand } from "../../drift-kit/index.ts";
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

function pinfold(...args: string[]) {
  return pinfoldExactly(...args, "--config", config);
}

/**
 * Runs the CLI with these arguments only, --config included. Node 22
 * warns that node:sqlite is experimental; the flag keeps that out of the
 * stderr the tests compare exactly.
 */
async function pinfoldExactly(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", bin, ...args],
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

    expect(
      (await pinfoldInTerminal(["approve", id, "--config", config])).code
    ).toBe(0);
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

  it("takes --config before the command too", async () => {
    await saveWorkflow();

    const { code, stdout } = await pinfoldExactly(
      "--config",
      config,
      "run",
      "file_issue",
      "--title=--draft"
    );

    expect(code).toBe(3);
    expect(stdout).toContain('linear.createIssue {"title":"--draft"}');
  });

  it("refuses unclear arguments with the usage and exit code 2", async () => {
    await saveWorkflow();

    const repeated = await pinfold(
      "run",
      "file_issue",
      "--title",
      "A",
      "--title",
      "B"
    );
    const dashes = await pinfold("run", "file_issue", "--", "--title", "A");
    const unknown = await pinfold("plans", "--bogus");
    const short = await pinfold("run", "file_issue", "-v");
    const bareConfig = await pinfoldExactly("plans", "--config");

    for (const result of [repeated, dashes, unknown, short, bareConfig]) {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
    expect(repeated.stderr).toMatch(/^--title is given more than once\n/);
  });
});

describe("pinfold baseline migrate", () => {
  it("says when a Tool's Baseline is its live shape already", async () => {
    const core = await openCore(await loadConfig(config), { root: dir });
    try {
      const result = await core.explore({
        code: `export async function main() {
          const { issues } = await sdk.linear.searchIssues({ query: "" });
          return issues.length;
        }`,
      });
      if (!result.ok) throw new Error(result.error);
      // The Fixtures of a saved Workflow hold the calls a migration repeats.
      await core.saveWorkflow({
        run: result.exploration,
        name: "count_issues",
        confirmed: true,
      });
    } finally {
      await core.close();
    }

    const { code, stdout } = await pinfold(
      "baseline",
      "migrate",
      "linear.searchIssues",
      "--yes"
    );

    expect(code).toBe(0);
    expect(stdout).toBe(
      "The Baseline of linear.searchIssues is the shape its server gives it now already; nothing to migrate.\n"
    );
  });

  it("fails with the reason when the Tool has no Baseline", async () => {
    const { code, stderr } = await pinfold(
      "baseline",
      "migrate",
      "linear.searchIssues"
    );

    expect(code).toBe(1);
    expect(stderr).toBe(
      "Baseline of linear.searchIssues not migrated: it has no Baseline yet; the first run that calls it pins one.\n"
    );
  });

  it("refuses options other than --yes with the usage and exit code 2", async () => {
    const results = [
      await pinfold("baseline", "migrate"),
      await pinfold("baseline", "migrate", "linear.searchIssues", "--force"),
      await pinfold("baseline", "migrate", "linear.searchIssues", "--yes=1"),
      await pinfold(
        "baseline",
        "optional",
        "linear.searchIssues",
        "a",
        "--yes"
      ),
      await pinfold("plans", "--yes"),
    ];

    for (const result of results) {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
  });
});
