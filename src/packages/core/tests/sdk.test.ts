import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

const baselines = () => join(ws.dir, ".workflows", "baselines");

async function readBaseline(tool: string) {
  return JSON.parse(await readFile(join(baselines(), `${tool}.json`), "utf8"));
}

describe("Baselines", () => {
  it("pins a Tool's Baseline in a committed file the first time a run calls it", async () => {
    const core = await ws.open();

    const result = await core.explore({
      code: `export async function main() {
        await sdk.sentry.listIssues({ project: "web" });
        const { projects } = (await sdk.sentry.listProjects()) as {
          projects: { slug: string }[];
        };
        return projects.map((project) => project.slug);
      }`,
    });

    expect(result).toEqual({ ok: true, value: ["web", "api"] });
    expect((await readdir(baselines())).sort()).toEqual([
      "sentry.listIssues.json",
      "sentry.listProjects.json",
    ]);
    expect(await readBaseline("sentry.listIssues")).toMatchObject({
      server: "sentry",
      tool: "listIssues",
      description: "List the issues of a Sentry project.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
      outputSchema: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                shortId: { type: "string" },
                count: { type: "number" },
              },
            },
          },
        },
      },
    });
  });

  it("infers the response shape of a Tool that declares none", async () => {
    const core = await ws.open();

    await core.explore({
      code: "export async function main() { await sdk.sentry.listProjects(); }",
    });

    const project = {
      type: "object",
      properties: {
        slug: { type: "string" },
        name: { type: "string" },
        platform: { type: "string" },
        // Seen as a string and as null.
        team: { anyOf: [{ type: "string" }, { type: "null" }] },
        // Only ever seen as null, so its type is still unknown.
        archivedAt: {},
      },
      required: ["slug", "name", "platform", "team", "archivedAt"],
    };
    expect((await readBaseline("sentry.listProjects")).outputSchema).toEqual({
      type: "object",
      properties: { projects: { type: "array", items: project } },
      required: ["projects"],
    });
  });

  it("waits to pin an inferred shape until a response shows what its arrays hold", async () => {
    const core = await ws.open();
    const listProjects = (platform?: string) =>
      core.explore({
        code: `export async function main(input: { platform?: string }) {
          await sdk.sentry.listProjects(input);
        }`,
        input: platform === undefined ? {} : { platform },
      });

    await listProjects("go");
    await expect(readdir(baselines())).rejects.toThrow(/ENOENT/);

    await listProjects();
    const { outputSchema } = await readBaseline("sentry.listProjects");
    expect(outputSchema.properties.projects.items.properties.slug).toEqual({
      type: "string",
    });
  });

  it("declares a pinned Tool from its Baseline, not from the live listing", async () => {
    // A Baseline the developer narrowed by hand: only shortId survives.
    await mkdir(baselines(), { recursive: true });
    await writeFile(
      join(baselines(), "sentry.listIssues.json"),
      JSON.stringify({
        server: "sentry",
        tool: "listIssues",
        description: "List the issues of a Sentry project.",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"],
        },
        outputSchema: {
          type: "object",
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: { shortId: { type: "string" } },
                required: ["shortId"],
              },
            },
          },
          required: ["issues"],
        },
      })
    );
    const core = await ws.open();

    expect(core.searchSdk("list issues of a project")[0]).toBe(
      [
        "/** List the issues of a Sentry project. */",
        "sdk.sentry.listIssues(args: { project: string }): Promise<{ issues: { shortId: string }[] }>",
      ].join("\n")
    );
  });

  it("does not pin a Tool whose call failed", async () => {
    const core = await ws.open();

    await core.explore({
      code: `export async function main() {
        try { await sdk.sentry.getIssue({ id: "missing" }); } catch {}
      }`,
    });

    await expect(readdir(baselines())).rejects.toThrow(/ENOENT/);
  });
});

describe("Type checking", () => {
  it("reports a type error against the SDK at its line, before the program runs", async () => {
    const core = await ws.open();

    const result = await core.explore({
      code: [
        "export async function main() {",
        '  const issue = await sdk.sentry.getIssue({ id: "4501" });',
        "  return issue.eventCount;",
        "}",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /^TS2339: Property 'eventCount' does not exist on type '.*'\.\n\s+at program\.ts:3:16$/
    );
    // getIssue was never called, so nothing was pinned.
    await expect(readdir(baselines())).rejects.toThrow(/ENOENT/);
  });

  it("reports wrong Tool arguments", async () => {
    const core = await ws.open();

    const result = await core.explore({
      code: [
        "export async function main() {",
        "  return sdk.sentry.listIssues({ project: 42 });",
        "}",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /^TS2322: Type 'number' is not assignable to type 'string'\.\n\s+at program\.ts:2:34$/
    );
  });
});

describe("search_sdk", () => {
  const toolOf = (signature: string) => signature.match(/sdk\.[\w.]+/)![0];

  it("ranks the Tool that matches the task first and leaves out unrelated ones", async () => {
    const core = await ws.open();

    const tools = core.searchSdk("events recorded for an issue").map(toolOf);

    expect(tools[0]).toBe("sdk.sentry.listIssueEvents");
    expect(tools).not.toContain("sdk.sentry.listProjects");
  });

  it("returns nothing when no Tool matches", async () => {
    const core = await ws.open();

    expect(core.searchSdk("deadlock kubernetes")).toEqual([]);
  });

  it("types an unpinned Tool's undeclared response as unknown until a call pins it", async () => {
    const core = await ws.open();
    const listProjects = () =>
      core.searchSdk("projects of the organization")[0]!.split("\n")[1];

    expect(listProjects()).toBe(
      "sdk.sentry.listProjects(args?: { platform?: string }): Promise<unknown>"
    );

    await core.explore({
      code: "export async function main() { await sdk.sentry.listProjects(); }",
    });

    expect(listProjects()).toBe(
      "sdk.sentry.listProjects(args?: { platform?: string }): Promise<{ projects: { slug: string; name: string; platform: string; team: string | null; archivedAt: unknown }[] }>"
    );
  });

  it("keeps same-named Tools of different Downstream Servers apart by namespace", async () => {
    const core = await ws.open({
      servers: { sentry: ws.sentry("sentry"), staging: ws.sentry("staging") },
    });

    expect(
      core.searchSdk("get one issue by id").map(toolOf).slice(0, 2).sort()
    ).toEqual(["sdk.sentry.getIssue", "sdk.staging.getIssue"]);
    const result = await core.explore({
      code: `export async function main() {
        const a = await sdk.sentry.getIssue({ id: "4501" });
        const b = await sdk.staging.getIssue({ id: "4601" });
        return [a.shortId, b.shortId];
      }`,
    });
    expect(result).toEqual({ ok: true, value: ["WEB-1A", "API-2A"] });
  });
});
