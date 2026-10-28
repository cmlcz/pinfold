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
      driftKitCommand("github", { control: controlPath })
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

describe("GitHub-shaped Drift Kit server", () => {
  it("offers two read Tools", async () => {
    const { tools } = await client.listTools();
    expect(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])
    ).toEqual([
      ["getBlame", true],
      ["listCommits", true],
    ]);
  });

  it("tells who last changed the line a Sentry issue crashes on", async () => {
    expect(
      await call("getBlame", { file: "src/checkout.ts", line: 42 })
    ).toEqual({
      file: "src/checkout.ts",
      line: 42,
      commit: "c0ffee2",
      authorName: "Ana",
      authorEmail: "ana@example.com",
      committedAt: "2026-10-01T12:00:00Z",
    });
    expect(
      await call("getBlame", { file: "src/checkout.ts", line: 3 })
    ).toMatchObject({ authorEmail: "li@example.com" });

    const missing = await client.callTool({
      name: "getBlame",
      arguments: { file: "src/nowhere.ts", line: 1 },
    });
    expect(missing.isError).toBe(true);
  });

  it("lists 480 commits, newest first, in pages of 50", async () => {
    const commits: { committedAt: string }[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await call("listCommits", cursor ? { cursor } : {});
      commits.push(...(page.commits as { committedAt: string }[]));
      cursor = page.nextCursor as string | null;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(10);
    expect(commits).toHaveLength(480);
    const times = commits.map((commit) => commit.committedAt);
    expect(times).toEqual(times.toSorted().reverse());
    expect(new Set(commits.map((commit) => JSON.stringify(commit))).size).toBe(
      480
    );
  });

  it("lists only the commits since a time", async () => {
    const page = await call("listCommits", { since: "2026-10-17T00:00:00Z" });

    expect(page.commits).toHaveLength(8);
    expect(page.nextCursor).toBeNull();
  });

  it("shows its state through the control channel", async () => {
    const state = (await connectControl(controlPath).state()) as {
      commits: unknown[];
    };

    expect(state.commits).toHaveLength(480);
  });
});
