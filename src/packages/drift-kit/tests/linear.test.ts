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
  client = new Client({ name: "drift-kit-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport(
      driftKitCommand("linear", { control: controlPath })
    )
  );
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

describe("Linear-shaped Drift Kit server", () => {
  it("offers a read and a write Tool, annotated as such", async () => {
    const { tools } = await client.listTools();
    expect(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])
    ).toEqual([
      ["searchIssues", true],
      ["createIssue", false],
    ]);
  });

  it("finds issues by a query in their title or description", async () => {
    const { issues } = await call("searchIssues", { query: "deadlock" });
    expect(issues).toEqual([
      expect.objectContaining({ identifier: "ENG-101" }),
    ]);
    expect(await call("searchIssues", { query: "checkout" })).toEqual({
      issues: [],
    });
  });

  it("creates an issue, logs the write and finds the issue afterwards", async () => {
    const created = await call("createIssue", {
      title: "[Sentry] TypeError in checkout.ts",
      assigneeEmail: "ana@example.com",
    });
    expect(created).toEqual({
      id: "lin-2",
      identifier: "ENG-102",
      title: "[Sentry] TypeError in checkout.ts",
      url: "https://linear.example/issue/ENG-102",
    });

    const control = connectControl(controlPath);
    expect(await control.receivedWrites()).toEqual([
      {
        tool: "createIssue",
        arguments: {
          title: "[Sentry] TypeError in checkout.ts",
          assigneeEmail: "ana@example.com",
        },
      },
    ]);
    const { issues } = await call("searchIssues", { query: "checkout" });
    expect(issues).toEqual([
      expect.objectContaining({ identifier: "ENG-102" }),
    ]);

    await control.reset();
    expect(await control.receivedWrites()).toEqual([]);
    expect(await call("searchIssues", { query: "checkout" })).toEqual({
      issues: [],
    });
  });

  it("fails a chosen write with an error and does not take it", async () => {
    const control = connectControl(controlPath);
    await control.failWrite(2);

    await call("createIssue", { title: "First" });
    const failed = await client.callTool({
      name: "createIssue",
      arguments: { title: "Second" },
    });
    await call("createIssue", { title: "Third" });

    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([
      { type: "text", text: "Drift Kit failed this write on request" },
    ]);
    expect((await control.receivedWrites()).map((w) => w.arguments)).toEqual([
      { title: "First" },
      { title: "Third" },
    ]);
  });
});

describe("The control channel", () => {
  it("is never taken over by a second server on the same socket", async () => {
    const second = new Client({ name: "second", version: "0.0.0" });
    const started = second.connect(
      new StdioClientTransport({
        ...driftKitCommand("linear", { control: controlPath }),
        stderr: "ignore",
      })
    );

    await expect(started).rejects.toThrow();
    await call("createIssue", { title: "Kept" });
    const writes = await connectControl(controlPath).receivedWrites();
    expect(writes.map((write) => write.arguments.title)).toEqual(["Kept"]);
  });

  it("refuses to fail a write that is not ahead", async () => {
    const control = connectControl(controlPath);

    await expect(control.failWrite(0)).rejects.toThrow(
      "failWrite takes a call from 1, not 0"
    );
  });
});
