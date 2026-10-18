import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driftKitCommand } from "../../drift-kit/index.ts";

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
      "run_sandbox",
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
      content: [{ type: "text", text: "3" }],
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
          String.raw`Then call run_sandbox again with the same code and input to apply it\.$`,
        ].join("\n")
      )
    );
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
