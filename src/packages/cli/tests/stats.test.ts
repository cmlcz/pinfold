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

describe("pinfold stats", () => {
  it("shows what pinfold measured, as text or as JSON", async () => {
    const core = await openCore(await loadConfig(config), { root: dir });
    try {
      await core.explore({
        code: `export async function main() {
          const { issues } = await sdk.linear.searchIssues({ query: "totals" });
          return issues.length;
        }`,
      });
    } finally {
      await core.close();
    }

    const text = await pinfold("stats");
    const json = await pinfold("stats", "--json");

    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(
      /^Measured by pinfold since .*\n\nExploration Runs: 1 run, \d+\.\d s, 1 Tool call, [\d,]+ bytes of Tool responses\n/
    );
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      explorationRuns: { runs: 1, toolCalls: 1 },
      workflowRuns: { runs: 0 },
      repairs: { pinfold: 0, agent: 0, model: 0, migration: 0 },
    });
  });

  it("refuses options other than --json", async () => {
    const result = await pinfold("stats", "--yes");

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^unknown option --yes\n/);
  });
});
