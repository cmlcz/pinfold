import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        sentry: driftKitCommand("sentry", { control: join(dir, "s.sock") }),
        linear: driftKitCommand("linear", { control: join(dir, "l.sock") }),
      },
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

// One row per Tool: name, kind, what its annotations suggest, and "new".
function rows(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
}

describe("pinfold classify", () => {
  it("lists every Tool as a new Write Tool, with the annotations' suggestion", async () => {
    const { code, stdout } = await pinfold("classify");

    expect(code).toBe(0);
    expect(rows(stdout)).toEqual([
      ["sentry.listIssues", "write", "read", "new"],
      ["sentry.getIssue", "write", "read", "new"],
      ["sentry.listIssueEvents", "write", "read", "new"],
      ["sentry.listProjects", "write", "write", "new"],
      ["sentry.getProjectTeam", "write", "read", "new"],
      ["linear.searchIssues", "write", "read", "new"],
      ["linear.createIssue", "write", "write", "new"],
    ]);
  });

  it("records the developer's choices in the config file, asking before marking Read Tools", async () => {
    const { code, output } = await pinfoldInTerminal([
      "classify",
      "read",
      "sentry.listIssues",
      "linear.searchIssues",
      "--config",
      config,
    ]);
    await pinfold("classify", "write", "linear.createIssue");

    expect(code).toBe(0);
    const [question, ...table] = output.trim().split("\n");
    expect(question).toBe(
      "Mark sentry.listIssues, linear.searchIssues as Read Tools? They run live during every Plan, so a Write Tool among them would send writes no one approved. Type yes to confirm: yes"
    );
    expect(rows(table.join("\n")).slice(0, 1)).toEqual([
      ["sentry.listIssues", "read", "read"],
    ]);
    const saved = JSON.parse(await readFile(config, "utf8"));
    expect(saved.classification).toEqual({
      sentry: { listIssues: "read" },
      linear: { searchIssues: "read", createIssue: "write" },
    });
    expect(saved.servers.sentry).toBeDefined();
    expect(rows((await pinfold("classify")).stdout)).toContainEqual([
      "linear.createIssue",
      "write",
      "write",
    ]);
  });

  it("refuses to mark Read Tools outside an interactive terminal", async () => {
    const { code, stderr } = await pinfold(
      "classify",
      "read",
      "linear.createIssue"
    );

    expect(code).toBe(1);
    expect(stderr).toMatch(
      /^pinfold classify read asks for confirmation in an interactive terminal/
    );
    expect(JSON.parse(await readFile(config, "utf8")).classification).toBe(
      undefined
    );
  });

  it("refuses a Tool that no Downstream Server offers", async () => {
    const { code, stderr } = await pinfold(
      "classify",
      "read",
      "sentry.deleteAll"
    );

    expect(code).toBe(1);
    expect(stderr).toMatch(/no Downstream Server offers sentry\.deleteAll/);
  });
});
