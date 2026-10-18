import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectControl, driftKitCommand } from "../index.ts";

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
    expect(tools.map((tool) => tool.name)).toEqual(["listIssues"]);

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

  it("has a control channel that resets state and reads the received writes", async () => {
    const control = connectControl(controlPath);
    expect(await control.receivedWrites()).toEqual([]);

    await control.reset();

    expect(await control.receivedWrites()).toEqual([]);
    const { issues } = await listIssues({ project: "api" });
    expect(issues.map((issue) => issue.shortId)).toEqual(["API-2A"]);
  });
});
