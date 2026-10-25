import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlans } from "../../core/index.ts";
import { connectControl, driftKitCommand } from "../../drift-kit/index.ts";

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pinfold-gateway-"));
  const config = join(dir, "pinfold.json");
  const sentry = driftKitCommand("sentry", { control: join(dir, "s.sock") });
  const linear = driftKitCommand("linear", { control: join(dir, "l.sock") });
  await writeFile(
    config,
    JSON.stringify({
      servers: { sentry, linear },
      classification: {
        sentry: { listIssues: "read", listIssueEvents: "read" },
        linear: { searchIssues: "read" },
      },
    })
  );

  client = new Client({ name: "gateway-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../bin.ts", import.meta.url)),
        "--config",
        config,
      ],
    })
  );
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Gateway", () => {
  it("exposes only its own fixed tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_workflows",
      "propose_repair",
      "run_sandbox",
      "run_workflow",
      "save_workflow",
      "search_sdk",
    ]);
  });

  it("returns only the SDK signatures that match a search", async () => {
    const result = await client.callTool({
      name: "search_sdk",
      arguments: { query: "events recorded for an issue" },
    });

    expect(result.isError).toBeFalsy();
    const [content] = result.content as [{ type: "text"; text: string }];
    expect(content.text).toMatch(
      /^\/\*\* List the events recorded for a Sentry issue/
    );
    expect(content.text).toContain(
      "sdk.sentry.listIssueEvents(args: { issueId: string })"
    );
    expect(content.text).not.toContain("listProjects");

    const none = await client.callTool({
      name: "search_sdk",
      arguments: { query: "kubernetes" },
    });
    expect(none.content).toEqual([
      { type: "text", text: 'No Tools match "kubernetes".' },
    ]);
  });

  it("runs an agent's program through run_sandbox and returns only its result", async () => {
    const result = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main(input: { project: string }) {
          const { issues } = await sdk.sentry.listIssues(input);
          return issues.length;
        }`,
        input: { project: "web" },
      },
    });

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringMatching(/^3\n\nExploration Run [0-9a-f]{8}\. /),
        },
      ],
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns the Write Plan of a run that writes, with nothing sent", async () => {
    const result = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main() {
          const ticket = await sdk.linear.createIssue({ title: "Fix totals" });
          await sdk.linear.createIssue({ title: "Follow up", description: ticket.url });
          return { created: ticket.identifier };
        }`,
      },
    });

    expect(result.isError).toBeFalsy();
    const [content] = result.content as [{ type: "text"; text: string }];
    expect(content.text).toMatch(
      new RegExp(
        [
          String.raw`^\{"created":<write 1>\.identifier\}`,
          "",
          String.raw`Write Plan [0-9a-f]{12}: 2 writes, none sent yet`,
          String.raw`  1\. linear\.createIssue \{"title":"Fix totals"\}`,
          String.raw`  2\. linear\.createIssue \{"description":<write 1>\.url,"title":"Follow up"\}`,
          "",
          "To send these writes, ask the developer to approve the plan in a terminal:",
          String.raw`  pinfold approve [0-9a-f]{12}`,
          String.raw`Then call run_sandbox again with the same code and input to apply it\.`,
          "",
          String.raw`Exploration Run [0-9a-f]{8}\. To keep it as a Workflow, .*$`,
        ].join("\n")
      )
    );
  });

  it("applies a plan the developer approved when the agent runs the code again", async () => {
    const run = () =>
      client.callTool({
        name: "run_sandbox",
        arguments: {
          code: `export async function main() {
            const ticket = await sdk.linear.createIssue({ title: "Fix totals" });
            return [ticket.identifier];
          }`,
        },
      });
    const pending = await run();
    const [first] = pending.content as [{ type: "text"; text: string }];
    const id = /pinfold approve ([0-9a-f]{12})/.exec(first.text)![1]!;

    await openPlans(dir).approve(id);
    const applied = await run();

    expect(applied.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          new RegExp(
            String.raw`^\["ENG-102"\]\n\nApplied Write Plan ${id}: 1 write sent\.\n\nExploration Run `
          )
        ),
      },
    ]);
  });

  it("saves a confirmed run as a Workflow and lists it", async () => {
    const run = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main(input: { project: string }) {
          const { issues } = await sdk.sentry.listIssues(input);
          return issues.length;
        }`,
        input: { project: "web" },
      },
    });
    const [content] = run.content as [{ type: "text"; text: string }];
    const exploration = /Exploration Run ([0-9a-f]{8})/.exec(content.text)![1]!;

    const unconfirmed = await client.callTool({
      name: "save_workflow",
      arguments: { run: exploration, name: "count_issues", confirmed: false },
    });
    const saved = await client.callTool({
      name: "save_workflow",
      arguments: { run: exploration, name: "count_issues", confirmed: true },
    });
    const listed = await client.callTool({
      name: "list_workflows",
      arguments: {},
    });

    expect(unconfirmed).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/Failed check: confirmation$/) }],
    });
    expect(saved.isError).toBeFalsy();
    expect(saved.content).toMatchObject([
      {
        text: expect.stringMatching(
          /^Saved Workflow count_issues as \.workflows\/count_issues\.ts\./
        ),
      },
    ]);
    expect(listed.content).toEqual([
      {
        type: "text",
        text: [
          "count_issues",
          "  inputs: project: string",
          "  tools: sentry.listIssues",
          "  last run: never",
          "  status: ready",
        ].join("\n"),
      },
    ]);
  });

  it("runs a saved Workflow through run_workflow", async () => {
    const run = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main(input: { project: string }) {
          const { issues } = await sdk.sentry.listIssues(input);
          return issues.length;
        }`,
        input: { project: "web" },
      },
    });
    const [content] = run.content as [{ type: "text"; text: string }];
    const exploration = /Exploration Run ([0-9a-f]{8})/.exec(content.text)![1]!;
    await client.callTool({
      name: "save_workflow",
      arguments: { run: exploration, name: "count_issues", confirmed: true },
    });

    const ran = await client.callTool({
      name: "run_workflow",
      arguments: { name: "count_issues", input: { project: "web" } },
    });
    const refused = await client.callTool({
      name: "run_workflow",
      arguments: { name: "count_issues", input: {} },
    });

    expect(ran.isError).toBeFalsy();
    expect(ran.content).toEqual([
      { type: "text", text: content.text.split("\n")[0] },
    ]);
    expect(refused).toMatchObject({
      isError: true,
      content: [
        {
          text: expect.stringMatching(
            /^Workflow count_issues not run\. The input does not fit/
          ),
        },
      ],
    });
  });

  it("runs a Workflow whose main takes a string through run_workflow", async () => {
    const run = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main(input: string) {
          return input.toUpperCase();
        }`,
        input: "web",
      },
    });
    const [content] = run.content as [{ type: "text"; text: string }];
    const exploration = /Exploration Run ([0-9a-f]{8})/.exec(content.text)![1]!;
    await client.callTool({
      name: "save_workflow",
      arguments: { run: exploration, name: "shout", confirmed: true },
    });

    const ran = await client.callTool({
      name: "run_workflow",
      arguments: { name: "shout", input: "api" },
    });

    expect(ran.isError).toBeFalsy();
    expect(ran.content).toEqual([{ type: "text", text: '"API"' }]);
  });

  it("says so when there is no pending Drift to repair", async () => {
    const result = await client.callTool({
      name: "propose_repair",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "No pending Drift." },
    ]);
  });

  it("points the agent to pending Drift and takes its Repair through propose_repair", async () => {
    const run = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: `export async function main(input: { project: string }) {
          const { issues } = await sdk.sentry.listIssues(input);
          return issues.reduce((sum, issue) => sum + issue.userCount, 0);
        }`,
        input: { project: "web" },
      },
    });
    const [content] = run.content as [{ type: "text"; text: string }];
    const exploration = /Exploration Run ([0-9a-f]{8})/.exec(content.text)![1]!;
    await client.callTool({
      name: "save_workflow",
      arguments: { run: exploration, name: "count_users", confirmed: true },
    });
    await connectControl(join(dir, "s.sock")).startDrift("removed-field");
    const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as [{ type: "text"; text: string }])[0].text;

    const stopped = await client.callTool({
      name: "run_workflow",
      arguments: { name: "count_users", input: { project: "web" } },
    });
    const listed = await client.callTool({
      name: "list_workflows",
      arguments: {},
    });
    const tasks = await client.callTool({
      name: "propose_repair",
      arguments: {},
    });
    const rejected = await client.callTool({
      name: "propose_repair",
      arguments: { tool: "sentry.listIssues", ops: [{ op: "drop" }] },
    });
    const proposed = await client.callTool({
      name: "propose_repair",
      arguments: {
        tool: "sentry.listIssues",
        ops: [{ op: "default", path: "issues[].userCount", value: 0 }],
      },
    });

    expect(stopped.isError).toBe(true);
    expect(text(stopped)).toContain("propose_repair");
    expect(text(listed)).toContain(
      [
        "Pending Drift, which stops the runs of the Workflows it affects; propose_repair shows it and can repair it:",
        "  sentry.listIssues, found by count_users",
      ].join("\n")
    );
    expect(text(tasks)).toMatch(
      /^Pending Drift of sentry\.listIssues, found by a run of Workflow count_users at /
    );
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toMatch(
      /^Repair of sentry\.listIssues not proposed: the ops are not of the closed set/
    );
    expect(proposed.isError).toBeFalsy();
    expect(text(proposed)).toMatch(
      /^An agent, through propose_repair, repaired the Response Adapter of sentry\.listIssues, now version 1:/
    );
    expect(text(proposed)).toContain("It is not approved");
  });

  it("reports a failed run as a tool error", async () => {
    const result = await client.callTool({
      name: "run_sandbox",
      arguments: {
        code: "export async function main() { throw new Error('boom'); }",
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringMatching(/^Error: boom\n.*program\.ts:1:/),
        },
      ],
    });
  });
});

describe("Gateway startup", () => {
  it("says in one line that the config file does not exist", async () => {
    const missing = join(dir, "missing.json");
    const failed = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../bin.ts", import.meta.url)),
      "--config",
      missing,
    ]).then(
      () => expect.fail("started"),
      (error: unknown) => error as { code: number; stderr: string }
    );

    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(
      `pinfold: ${missing} does not exist; create a pinfold config there, or pass --config <path>\n`
    );
  });
});
