import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectControl,
  driftKitCommand,
  sentryDriftScenarios,
} from "../index.ts";

let dir: string;
let controlPath: string;
let client: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drift-kit-"));
  controlPath = join(dir, "control.sock");
  const { command, args } = driftKitCommand("sentry", { control: controlPath });
  client = new Client({ name: "drift-kit-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args }));
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

async function listIssues(args: Record<string, unknown>) {
  const result = await client.callTool({ name: "listIssues", arguments: args });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { issues: Array<Record<string, unknown>> };
}

describe("Sentry-shaped Drift Kit server", () => {
  it("lists its issues to any MCP client over stdio", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "listIssues",
      "getIssue",
      "listIssueEvents",
      "listProjects",
      "getProjectTeam",
    ]);

    const { issues } = await listIssues({ project: "web" });
    expect(issues.map((issue) => issue.shortId)).toEqual([
      "WEB-1A",
      "WEB-1B",
      "WEB-1C",
    ]);
    expect(issues[0]).toMatchObject({
      title: "TypeError: Cannot read properties of undefined (reading 'total')",
      culprit: "checkout.ts in computeTotal",
      filename: "src/checkout.ts",
      lineNumber: 42,
      status: "unresolved",
      count: 128,
    });
  });

  it("looks up one issue, its events and the projects", async () => {
    const issue = await client.callTool({
      name: "getIssue",
      arguments: { id: "4601" },
    });
    expect(issue.structuredContent).toMatchObject({ shortId: "API-2A" });

    const events = await client.callTool({
      name: "listIssueEvents",
      arguments: { issueId: "4501" },
    });
    expect(events.structuredContent).toMatchObject({
      events: [{ issueId: "4501" }, { issueId: "4501" }],
    });

    // Like many real servers, listProjects answers with JSON text only.
    const projects = await client.callTool({
      name: "listProjects",
      arguments: {},
    });
    expect(projects.structuredContent).toBeUndefined();
    expect(projects.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          projects: [
            {
              slug: "web",
              name: "Web storefront",
              platform: "javascript",
              team: "storefront",
              archivedAt: null,
            },
            {
              slug: "api",
              name: "Orders API",
              platform: "node",
              team: null,
              archivedAt: null,
            },
          ],
        }),
      },
    ]);

    const goProjects = await client.callTool({
      name: "listProjects",
      arguments: { platform: "go" },
    });
    expect(goProjects.content).toEqual([
      { type: "text", text: JSON.stringify({ projects: [] }) },
    ]);
  });

  it("has a control channel that resets state and reads the received writes", async () => {
    const control = connectControl(controlPath);
    expect(await control.receivedWrites()).toEqual([]);

    await control.reset();

    expect(await control.receivedWrites()).toEqual([]);
    const { issues } = await listIssues({ project: "api" });
    expect(issues.map((issue) => issue.shortId)).toEqual(["API-2A"]);
  });
});

describe("Sentry Drift Scenarios", () => {
  // A client that takes responses as they come, as pinfold does: telling
  // them from the listing is pinfold's Drift detection.
  async function connectLenient(): Promise<Client> {
    const lenient = new Client(
      { name: "drift-kit-test", version: "0.0.0" },
      {
        jsonSchemaValidator: {
          getValidator: () => (input) => ({
            valid: true,
            data: input as never,
            errorMessage: undefined,
          }),
        },
      }
    );
    const { command, args } = driftKitCommand("sentry", {
      control: join(dir, "lenient.sock"),
    });
    await lenient.connect(new StdioClientTransport({ command, args }));
    return lenient;
  }

  async function listWith(scenarios: string[]): Promise<unknown> {
    const lenient = await connectLenient();
    const control = connectControl(join(dir, "lenient.sock"));
    try {
      for (const scenario of scenarios) await control.startDrift(scenario);
      const result = await lenient.callTool({
        name: "listIssues",
        arguments: { project: "web" },
      });
      expect(result.isError).toBeFalsy();
      return result.structuredContent;
    } finally {
      await lenient.close();
    }
  }

  it("lists its scenarios", () => {
    expect(sentryDriftScenarios).toEqual([
      "rename",
      "wrap",
      "type-change",
      "enum-change",
      "removed-field",
      "pagination",
    ]);
  });

  it("renames, retypes, maps and removes issue fields", async () => {
    const drifted = (await listWith([
      "rename",
      "type-change",
      "enum-change",
      "removed-field",
    ])) as { issues: Array<Record<string, unknown>> };

    expect(drifted.issues[0]).toMatchObject({
      shortId: "WEB-1A",
      eventCount: "128",
      status: "open",
    });
    expect(drifted.issues[0]).not.toHaveProperty("count");
    expect(drifted.issues[0]).not.toHaveProperty("userCount");
  });

  it("wraps the response and pages it", async () => {
    expect(await listWith(["wrap", "pagination"])).toMatchObject({
      data: {
        results: [{ shortId: "WEB-1A" }, { shortId: "WEB-1B" }],
        nextCursor: "2",
      },
    });
  });

  it("turns scenarios off, one by one or all at a reset", async () => {
    const control = connectControl(controlPath);
    await control.startDrift("rename");
    await control.startDrift("wrap");
    await control.stopDrift("wrap");
    const result = await client.callTool({
      name: "getIssue",
      arguments: { id: "4501" },
    });
    expect(result.structuredContent).toMatchObject({
      shortId: "WEB-1A",
      eventCount: 128,
    });

    await control.reset();

    expect(await control.receivedWrites()).toEqual([]);
    const { issues } = await listIssues({ project: "api" });
    expect(issues.map((issue) => issue.shortId)).toEqual(["API-2A"]);
  });
});
