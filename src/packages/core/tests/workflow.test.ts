import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWorkflows,
  listWorkflows,
  type Core,
  type ExploreResult,
} from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

function openTriage(config = {}): Promise<Core> {
  return ws.open({
    servers: { sentry: ws.sentry(), linear: ws.linear() },
    classification: {
      ...sentryReads,
      linear: { searchIssues: "read", createIssue: "write" },
    },
    ...config,
  });
}

const triage = {
  code: `export async function main(input: { project: string; minEvents?: number }) {
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
  }`,
  input: { project: "web" },
};

function explorationOf(result: ExploreResult): string {
  if (!result.ok) throw new Error(result.error);
  return result.exploration;
}

/** Every file under the workspace's .workflows/, with its contents. */
async function workflowFiles(): Promise<Record<string, string>> {
  const dir = join(ws.dir, ".workflows");
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  for (const name of names) {
    try {
      files[name] = await readFile(join(dir, name), "utf8");
    } catch {
      // A directory.
    }
  }
  return files;
}

async function savedFiles(): Promise<string[]> {
  return Object.keys(await workflowFiles())
    .filter((name) => !name.startsWith("baselines"))
    .sort();
}

describe("save_workflow", () => {
  it("saves a confirmed run as a TypeScript file with its Contract and Fixtures", async () => {
    const core = await openTriage();
    const run = explorationOf(await core.explore(triage));

    const result = await core.saveWorkflow({
      run,
      name: "triage_sentry",
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(await savedFiles()).toEqual([
      "fixtures/.gitignore",
      "fixtures/triage_sentry.json",
      "triage_sentry.json",
      "triage_sentry.ts",
    ]);
    const files = await workflowFiles();
    const source = files["triage_sentry.ts"]!;
    expect(source).toContain("export const settings = { writeBudget: 10 };");
    expect(source).toContain(triage.code);
    expect(files["fixtures/.gitignore"]).toBe("*\n");

    const record = JSON.parse(files["triage_sentry.json"]!);
    expect(record).toMatchObject({
      name: "triage_sentry",
      input: {
        type: "object",
        properties: {
          project: { type: "string" },
          minEvents: { type: "number" },
        },
        required: ["project"],
      },
      tools: ["sentry.listIssues", "linear.createIssue"],
      savedFrom: run,
    });
    expect(record.contract).toEqual({
      "sentry.listIssues": [
        "issues[].count",
        "issues[].culprit",
        "issues[].shortId",
      ],
    });

    const fixtures = JSON.parse(files["fixtures/triage_sentry.json"]!);
    expect(fixtures.input).toEqual(triage.input);
    expect(fixtures.calls).toMatchObject([
      { tool: "sentry.listIssues", arguments: { project: "web" } },
    ]);
    expect(fixtures.calls[0].response.issues[0].culprit).toBe(
      "checkout.ts in computeTotal"
    );
  });

  it("never writes a redacted field to disk", async () => {
    const core = await openTriage({
      redact: {
        sentry: {
          listIssues: ["response.issues[].culprit", "arguments.project"],
        },
      },
    });
    const run = explorationOf(await core.explore(triage));

    await core.saveWorkflow({ run, name: "triage_sentry", confirmed: true });

    const fixtures = JSON.parse(
      (await workflowFiles())["fixtures/triage_sentry.json"]!
    );
    expect(fixtures.calls[0].arguments).toEqual({ project: "[redacted]" });
    expect(
      fixtures.calls[0].response.issues.map(
        (i: { culprit: string }) => i.culprit
      )
    ).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
    const disk = Object.values(await workflowFiles()).join("\n");
    expect(disk).not.toContain("checkout.ts in computeTotal");
    expect(disk).not.toContain("sync-worker.ts in flushQueue");
  });

  it("redacts a field inside an array even when the rule leaves out []", async () => {
    const core = await openTriage({
      redact: { sentry: { listIssues: ["response.issues.culprit"] } },
    });
    const run = explorationOf(await core.explore(triage));

    await core.saveWorkflow({ run, name: "triage_sentry", confirmed: true });

    const disk = Object.values(await workflowFiles()).join("\n");
    expect(disk).not.toContain("checkout.ts in computeTotal");
    expect(disk).toContain('"culprit": "[redacted]"');
  });

  it("refuses a run the developer has not confirmed, and writes nothing", async () => {
    const core = await openTriage();
    const run = explorationOf(await core.explore(triage));

    const result = await core.saveWorkflow({
      run,
      name: "triage_sentry",
      confirmed: false,
    });

    expect(result).toMatchObject({ ok: false, check: "confirmation" });
    expect(await savedFiles()).toEqual([]);
  });

  it("refuses a run it does not know, such as one that failed", async () => {
    const core = await openTriage();
    const failed = await core.explore({
      code: "export async function main() { throw new Error('boom'); }",
    });
    expect(failed.ok).toBe(false);

    const result = await core.saveWorkflow({
      run: "deadbeef",
      name: "boom",
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: false, check: "run" });
    expect(await savedFiles()).toEqual([]);
  });

  it("refuses code whose main(input) is not typed", async () => {
    const core = await openTriage();
    const run = explorationOf(
      await core.explore({
        code: `export async function main(input: any) { return input; }`,
      })
    );

    const result = await core.saveWorkflow({
      run,
      name: "loose",
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: false, check: "main" });
    expect(result.ok || result.error).toMatch(/typed any or unknown/);
    expect(await savedFiles()).toEqual([]);
  });

  it("refuses code that does not type-check as a Workflow", async () => {
    const core = await openTriage();
    const run = explorationOf(
      await core.explore({
        code: `const settings = 1;
        export async function main() { return settings; }`,
      })
    );

    const result = await core.saveWorkflow({
      run,
      name: "clash",
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: false, check: "types" });
    expect(await savedFiles()).toEqual([]);
  });

  it("refuses a bad name, or one already taken", async () => {
    const core = await openTriage();
    const run = explorationOf(await core.explore(triage));

    const bad = await core.saveWorkflow({ run, name: "../x", confirmed: true });
    await core.saveWorkflow({ run, name: "triage", confirmed: true });
    const taken = await core.saveWorkflow({
      run,
      name: "triage",
      confirmed: true,
    });

    expect(bad).toMatchObject({ ok: false, check: "name" });
    expect(taken).toMatchObject({ ok: false, check: "name" });
    expect(await savedFiles()).toEqual([
      "fixtures/.gitignore",
      "fixtures/triage.json",
      "triage.json",
      "triage.ts",
    ]);
  });
  it("derives the input schema from main's parameter type", async () => {
    const core = await openTriage();
    const run = explorationOf(
      await core.explore({
        code: `export async function main(input: {
          dry?: boolean;
          level: "error" | "warning";
          tags: string[];
          limit: number | null;
        }) { return input.level; }`,
        input: { level: "error", tags: [], limit: null },
      })
    );

    await core.saveWorkflow({ run, name: "typed", confirmed: true });

    const [workflow] = await listWorkflows(ws.dir);
    expect(workflow!.input).toEqual({
      type: "object",
      properties: {
        dry: { type: "boolean" },
        level: { enum: ["error", "warning"] },
        tags: { type: "array", items: { type: "string" } },
        limit: { anyOf: [{ type: "null" }, { type: "number" }] },
      },
      required: ["level", "tags", "limit"],
      additionalProperties: false,
    });
  });
});

describe("list_workflows", () => {
  it("shows each Workflow's inputs, Tools, last run and status", async () => {
    const core = await openTriage();
    const run = explorationOf(await core.explore(triage));
    await core.saveWorkflow({ run, name: "triage_sentry", confirmed: true });
    const quiet = explorationOf(
      await core.explore({ code: "export async function main() { return 1; }" })
    );
    await core.saveWorkflow({ run: quiet, name: "noop", confirmed: true });

    const text = formatWorkflows(await listWorkflows(ws.dir));

    expect(text).toBe(
      [
        "noop",
        "  inputs: none",
        "  tools: none",
        "  last run: never",
        "  status: ready",
        "",
        "triage_sentry",
        "  inputs: project: string, minEvents?: number",
        "  tools: sentry.listIssues, linear.createIssue",
        "  last run: never",
        "  status: ready",
      ].join("\n")
    );
  });

  it("shows tuple inputs, whose schemas hold false", async () => {
    const core = await openTriage();
    const run = explorationOf(
      await core.explore({
        code: "export async function main(input: { pair: [string, number]; tags: [string, ...string[]] }) { return input; }",
        input: { pair: ["a", 1], tags: ["b"] },
      })
    );
    await core.saveWorkflow({ run, name: "tuples", confirmed: true });

    expect(formatWorkflows(await listWorkflows(ws.dir))).toContain(
      "  inputs: pair: [string, number], tags: [string, ...string[]]"
    );
  });

  it("says so when there are none", async () => {
    expect(formatWorkflows(await listWorkflows(ws.dir))).toBe(
      "No saved Workflows."
    );
  });

  it("skips a record that is not JSON or not a Workflow record", async () => {
    const core = await openTriage();
    const run = explorationOf(
      await core.explore({ code: "export async function main() { return 1; }" })
    );
    await core.saveWorkflow({ run, name: "noop", confirmed: true });
    await writeFile(join(ws.dir, ".workflows", "broken.json"), "{");
    await writeFile(join(ws.dir, ".workflows", "other.json"), "{}");

    const names = (await listWorkflows(ws.dir)).map(({ name }) => name);

    expect(names).toEqual(["noop"]);
  });
});

describe("exposed Workflows", () => {
  async function save(
    core: Core,
    name: string,
    run: { code: string; input?: unknown },
    settings: string
  ) {
    const exploration = explorationOf(await core.explore(run));
    await core.saveWorkflow({ run: exploration, name, confirmed: true });
    const file = join(ws.dir, ".workflows", `${name}.ts`);
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source.replace("export const settings = { writeBudget: 10 };", settings)
    );
  }

  it("offers the Workflows that set expose: true, with main's input as their arguments", async () => {
    const core = await openTriage();
    await save(
      core,
      "triage_sentry",
      triage,
      "export const settings = { writeBudget: 10, expose: true };"
    );
    await save(
      core,
      "count",
      { code: "export async function main() { return 1; }" },
      "export const settings = { writeBudget: 10 };"
    );

    const { workflows, skipped } = await core.exposedWorkflows();

    expect(skipped).toEqual([]);
    expect(workflows).toEqual([
      {
        name: "triage_sentry",
        description: "Runs Workflow triage_sentry, as run_workflow does.",
        input: expect.objectContaining({
          type: "object",
          required: ["project"],
        }),
      },
    ]);
  });

  it("says why it leaves out an opted-in Workflow it cannot offer", async () => {
    const core = await openTriage();
    await save(
      core,
      "shout",
      {
        code: "export async function main(input: string) { return input.toUpperCase(); }",
        input: "web",
      },
      "export const settings = { writeBudget: 10, expose: true };"
    );
    await save(
      core,
      "unbudgeted",
      { code: "export async function main() { return 1; }" },
      "export const settings = { expose: true };"
    );

    const { workflows, skipped } = await core.exposedWorkflows();

    expect(workflows).toEqual([]);
    expect(skipped).toEqual([
      "Workflow shout not exposed as an MCP tool: its input is not an object, as the arguments of a tool are.",
      expect.stringMatching(
        /^Workflow unbudgeted not run: it must export const settings = .* So it is not exposed as an MCP tool\.$/
      ),
    ]);
  });
});
