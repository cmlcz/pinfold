import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectControl,
  serveDriftKitHttp,
  type ControlClient,
  type HttpDriftKitServer,
} from "../index.ts";

let dir: string;
let server: HttpDriftKitServer;
let control: ControlClient;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drift-kit-"));
  server = await serveDriftKitHttp("sentry", {
    control: join(dir, "control.sock"),
  });
  control = connectControl(join(dir, "control.sock"));
});

afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

// The web project's first issue, as listIssues answers with these
// scenarios on.
async function firstIssue(...scenarios: string[]) {
  for (const scenario of scenarios) await control.startDrift(scenario);
  const client = new Client({ name: "field-drift-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  try {
    const result = await client.callTool({
      name: "listIssues",
      arguments: { project: "web" },
    });
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

describe("Field-level Drift Scenarios", () => {
  it("rename a field: camelCase to snake_case, one word after its element's noun", async () => {
    const { issues } = (await firstIssue(
      "rename:listIssues:issues[].count",
      "rename:listIssues:issues[].lineNumber"
    )) as { issues: Record<string, unknown>[] };

    expect(issues[0]).toMatchObject({ issueCount: 128, line_number: 42 });
    expect(issues[0]).not.toHaveProperty("count");
    expect(issues[0]).not.toHaveProperty("lineNumber");
  });

  it("change a field's type, an enum's values, or remove the field", async () => {
    const { issues } = (await firstIssue(
      "type-change:listIssues:issues[].count",
      "type-change:listIssues:issues[].firstSeen",
      "enum-change:listIssues:issues[].status",
      "removed-field:listIssues:issues[].culprit"
    )) as { issues: Record<string, unknown>[] };

    expect(issues[0]).toMatchObject({
      count: "128",
      firstSeen: Date.parse("2026-10-16T08:12:00Z"),
      status: "open",
    });
    expect(issues[0]).not.toHaveProperty("culprit");
  });

  it("wrap a response, or page its list, after changing its fields", async () => {
    expect(
      await firstIssue("wrap:listIssues", "rename:listIssues:issues[].count")
    ).toEqual({
      data: {
        issues: expect.arrayContaining([
          expect.objectContaining({ issueCount: 128 }),
        ]),
      },
    });
    await control.reset();

    const paged = await firstIssue("pagination:listIssues");

    expect(paged).toEqual({
      results: [expect.anything(), expect.anything()],
      nextCursor: "2",
    });
  });

  it("refuse a scenario for a Tool the server lacks, or a malformed one", async () => {
    await expect(
      control.startDrift("rename:getBlame:authorEmail")
    ).rejects.toThrow(/404/);
    await expect(control.startDrift("rename:listIssues")).rejects.toThrow(
      /404/
    );
    await expect(
      control.startDrift("rename:listIssues:issues[].count:extra")
    ).rejects.toThrow(/404/);
  });
});
