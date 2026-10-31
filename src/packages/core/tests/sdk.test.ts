import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTools, type Core } from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

const baselines = () => join(ws.dir, ".workflows", "baselines");

/** The pinned Baseline of a Tool, named `server.tool`. */
async function readBaseline(tool: string) {
  for (const file of await readdir(baselines())) {
    const baseline = JSON.parse(
      await readFile(join(baselines(), file), "utf8")
    );
    if (`${baseline.server}.${baseline.tool}` === tool) return baseline;
  }
  throw new Error(`no Baseline of ${tool}`);
}

describe("Baselines", () => {
  it("pins a Tool whose name is too long for a file name", async () => {
    // The name of names-server.ts.
    const longName = "問".repeat(100);
    const core = await ws.open({
      servers: {
        names: {
          command: process.execPath,
          args: [fileURLToPath(new URL("names-server.ts", import.meta.url))],
        },
      },
      classification: { names: { [longName]: "read" } },
    });

    const result = await core.explore({
      code: `export async function main() {
        return await (sdk.names as any)[${JSON.stringify(longName)}]({});
      }`,
    });

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    const [file] = await readdir(baselines());
    expect(Buffer.byteLength(file!)).toBeLessThan(100);
    expect(await readBaseline(`names.${longName}`)).toMatchObject({
      tool: longName,
    });
  });

  it("names the Baseline file that is not valid JSON", async () => {
    await mkdir(baselines(), { recursive: true });
    await writeFile(join(baselines(), "sentry.listIssues.json"), "{");

    await expect(ws.open()).rejects.toThrow(
      `${join(baselines(), "sentry.listIssues.json")} is not valid JSON`
    );
  });

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

    expect(result).toMatchObject({ ok: true, value: ["web", "api", "jobs"] });
    expect((await readdir(baselines())).sort()).toEqual([
      expect.stringMatching(/^sentry\.listIssues\.[0-9a-f]{12}\.json$/),
      expect.stringMatching(/^sentry\.listProjects\.[0-9a-f]{12}\.json$/),
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

  it("finds Tools by words in any script, written with or without spaces", async () => {
    await mkdir(baselines(), { recursive: true });
    const describedAs = (tool: string, description: string) =>
      writeFile(
        join(baselines(), `sentry.${tool}.json`),
        JSON.stringify({
          server: "sentry",
          tool,
          description,
          inputSchema: { type: "object" },
          outputSchema: {},
        })
      );
    await describedAs(
      "listProjects",
      "組織のプロジェクトを日本語で一覧表示します"
    );
    await describedAs("listIssues", "Zeigt die Ereignisse für ein Projekt");
    const core = await ws.open();

    expect(core.searchSdk("日本語").map(toolOf)[0]).toBe(
      "sdk.sentry.listProjects"
    );
    expect(core.searchSdk("für").map(toolOf)).toEqual([
      "sdk.sentry.listIssues",
    ]);
  });

  it("folds the plural of a short word", async () => {
    const core = await ws.open();

    expect(core.searchSdk("ids").map(toolOf)).toContain("sdk.sentry.getIssue");
  });

  it("finds a Tool by stopwords when the query holds nothing else", async () => {
    const core = await ws.open();

    expect(core.searchSdk("get").map(toolOf)[0]).toBe("sdk.sentry.getIssue");
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
      classification: { ...sentryReads, staging: sentryReads.sentry },
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
    expect(result).toMatchObject({ ok: true, value: ["WEB-1A", "API-2A"] });
  });
});

describe("Baselines from varying responses", () => {
  const team = (core: Core, slug: string) =>
    core.explore({
      code: `export async function main(input: { slug: string }) {
        await sdk.sentry.getProjectTeam(input);
      }`,
      input: { slug },
    });

  it("pins once a field has been empty, null and then filled", async () => {
    const core = await ws.open();

    await team(core, "missing"); // plain text, no shape to learn from
    await team(core, "api"); // members: []
    await team(core, "legacy"); // members: null
    await expect(readdir(baselines())).rejects.toThrow(/ENOENT/);

    await team(core, "web");

    const member = {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" } },
      required: ["name"],
    };
    expect((await readBaseline("sentry.getProjectTeam")).outputSchema).toEqual({
      type: "object",
      properties: {
        slug: { type: "string" },
        members: {
          anyOf: [{ type: "array", items: member }, { type: "null" }],
        },
      },
      required: ["slug", "members"],
    });
  });

  it("does not pin a shape from a plain text answer", async () => {
    const core = await ws.open();

    await team(core, "missing");

    await expect(readdir(baselines())).rejects.toThrow(/ENOENT/);
    expect(core.searchSdk("members of a project team")[0]!.split("\n")[1]).toBe(
      "sdk.sentry.getProjectTeam(args: { slug: string }): Promise<unknown>"
    );
  });
});

describe("Declarations from unusual schemas", () => {
  it("stay valid TypeScript, so correct code still type-checks", async () => {
    await mkdir(baselines(), { recursive: true });
    const outputSchema = {
      type: "object",
      properties: {
        never: { enum: [] },
        tags: { type: "array", items: { enum: ["a(", "b"] } },
        pair: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          items: false,
        },
        row: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "boolean" },
        },
        mixed: {
          allOf: [
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { type: "object" },
          ],
        },
        extra: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: true,
        },
      },
    };
    await writeFile(
      join(baselines(), "sentry.listIssues.json"),
      JSON.stringify({
        server: "sentry",
        tool: "listIssues",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"],
        },
        outputSchema,
      })
    );
    const core = await ws.open();

    const signature = core.searchSdk("list issues project")[0]!;
    const result = await core.explore({
      code: `export async function main() {
        const r = await sdk.sentry.listIssues({ project: "web" });
        const extra: { a?: string; b?: number } | undefined = r.extra;
        return typeof extra;
      }`,
    });

    expect(signature).toContain("never?: never");
    expect(signature).toContain('tags?: ("a(" | "b")[]');
    expect(signature).toContain("pair?: [string?, number?]");
    expect(signature).toContain("row?: [string?, ...boolean[]]");
    expect(signature).toContain(
      "mixed?: (string | number) & Record<string, unknown>"
    );
    expect(signature).toContain(
      "extra?: { a?: string; [key: string]: unknown }"
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("classifyTools", () => {
  it("records servers and Tools named like Object members", async () => {
    const config = join(ws.dir, "pinfold.json");
    await writeFile(config, JSON.stringify({ servers: {} }));

    await classifyTools(config, [
      { server: "constructor", tool: "toString", kind: "read" },
    ]);

    expect(JSON.parse(await readFile(config, "utf8")).classification).toEqual({
      constructor: { toString: "read" },
    });
  });
});
