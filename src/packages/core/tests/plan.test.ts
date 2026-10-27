import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPlan, type Core } from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

// Sentry and Linear, where only linear.createIssue is a Write Tool.
function openTriage(): Promise<Core> {
  return ws.open({
    servers: { sentry: ws.sentry(), linear: ws.linear() },
    classification: {
      ...sentryReads,
      linear: { searchIssues: "read", createIssue: "write" },
    },
  });
}

const triage = `
  export async function main(input: { project: string; minEvents: number }) {
    const { issues } = await sdk.sentry.listIssues({ project: input.project });
    const frequent = issues.filter(
      (i) => i.count >= input.minEvents && i.status === "unresolved"
    );
    const created = [];
    for (const issue of frequent) {
      const { issues: existing } = await sdk.linear.searchIssues({ query: issue.culprit });
      if (existing.length > 0) continue;
      const ticket = await sdk.linear.createIssue({
        title: "[Sentry] " + issue.title,
        description: issue.culprit,
      });
      created.push(ticket.id);
    }
    return { checked: frequent.length, created };
  }
`;

describe("Plan", () => {
  it("runs Read Tools live, records Write Tool calls in order and sends none", async () => {
    const core = await openTriage();

    const result = await core.explore({
      code: triage,
      input: { project: "web", minEvents: 50 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        checked: 2,
        created: [
          { write: 1, path: ["id"] },
          { write: 2, path: ["id"] },
        ],
      },
      plan: {
        id: expect.stringMatching(/^[0-9a-f]{12}$/),
        writes: [
          {
            tool: "linear.createIssue",
            arguments: {
              title:
                "[Sentry] TypeError: Cannot read properties of undefined (reading 'total')",
              description: "checkout.ts in computeTotal",
            },
          },
          {
            tool: "linear.createIssue",
            arguments: {
              title: "[Sentry] TimeoutError: sync-worker exceeded 30000ms",
              description: "sync-worker.ts in flushQueue",
            },
          },
        ],
      },
    });
    expect(await ws.control("linear").receivedWrites()).toEqual([]);
  });

  it("lets a Placeholder pass from one write into the next", async () => {
    const core = await openTriage();

    const result = await core.explore({
      code: `export async function main() {
        const parent = await sdk.linear.createIssue({ title: "Parent" });
        await sdk.linear.createIssue({ title: "Child", description: parent.url });
      }`,
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        writes: [
          { arguments: { title: "Parent" } },
          {
            arguments: {
              title: "Child",
              description: { write: 1, path: ["url"] },
            },
          },
        ],
      },
    });
  });

  it("treats a Tool the developer has not classified as a Write Tool", async () => {
    const core = await ws.open({ classification: {} });

    const result = await core.explore({
      code: `export async function main() {
        return sdk.sentry.listIssues({ project: "web" });
      }`,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { write: 1, path: [] },
      plan: {
        writes: [{ tool: "sentry.listIssues", arguments: { project: "web" } }],
      },
    });
    // Never called, so never pinned.
    await expect(
      readdir(join(ws.dir, ".workflows", "baselines"))
    ).rejects.toThrow(/ENOENT/);
  });

  it("never lets reads see the run's own writes", async () => {
    const core = await openTriage();

    const result = await core.explore({
      code: `export async function main() {
        await sdk.linear.createIssue({ title: "Fix checkout totals" });
        const planned = await sdk.linear.searchIssues({ query: "checkout" });
        const existing = await sdk.linear.searchIssues({ query: "deadlock" });
        return [planned.issues.length, existing.issues.length];
      }`,
    });

    expect(result).toMatchObject({ ok: true, value: [0, 1] });
  });
});

describe("Write Tools in the SDK", () => {
  it("says in a Write Tool's signature that the call is recorded, not sent", async () => {
    const core = await openTriage();

    const [create] = core.searchSdk("create a linear issue");
    const [search] = core.searchSdk("search linear issues");

    expect(create).toMatch(
      /^\/\*\* Create a Linear issue\. Write Tool: a run records this call in its Write Plan instead of sending it, and gets a Placeholder back\. \*\/\nsdk\.linear\.createIssue\(/
    );
    expect(search).toMatch(/^\/\*\* Search Linear issues [^*]*\*\/\n/);
  });
});

describe("Placeholder rules", () => {
  it.each([
    [
      "compares",
      "return ticket.title.length > 5;",
      "read, compared or formatted",
    ],
    [
      "formats",
      "return `#${ticket.identifier}`;",
      "read, compared or formatted",
    ],
    ["converts", "return String(ticket.id);", "read, compared or formatted"],
    // JSON.stringify calls the Placeholder's toJSON, which is itself one.
    ["serializes", "return JSON.stringify(ticket);", "called"],
    ["lists the keys of", "return Object.keys(ticket);", "inspected"],
    ["tests a key of", 'return "id" in ticket;', "inspected"],
    [
      "catches the error after it reads",
      "try { return `${ticket.id}`; } catch { return 'escaped'; }",
      "read, compared or formatted",
    ],
    ["calls a method of", "return ticket.title.toUpperCase();", "called"],
    [
      "catches the error after it calls",
      "try { return ticket.title.toUpperCase(); } catch { return 'escaped'; }",
      "called",
    ],
  ])(
    "fails the Plan at the line that %s a Placeholder",
    async (_, use, operation) => {
      const core = await openTriage();

      const result = await core.explore({
        code: [
          "export async function main() {",
          '  const ticket = await sdk.linear.createIssue({ title: "T" });',
          `  ${use}`,
          "}",
        ].join("\n"),
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(
        new RegExp(
          `^PlaceholderError: a Placeholder cannot be ${operation} during a Plan.*\\n\\s+at main \\(program\\.ts:3:\\d+\\)`
        )
      );
    }
  );

  it.each([
    ["an if", "if (ticket.id) return 1; return 2;"],
    ["a conditional expression", "return ticket.id ? 1 : 2;"],
    ["a negation", "return !ticket;"],
    ["an &&", "return ticket.id && 1;"],
    ["a comparison", 'return ticket.identifier === "ENG-1";'],
    ["a typeof", "return typeof ticket.id;"],
    ["a switch", "switch (ticket.id) { default: return 1; }"],
  ])(
    "refuses code where a Placeholder decides %s, before it runs",
    async (_, use) => {
      const core = await openTriage();

      const result = await core.explore({
        code: [
          "export async function main() {",
          '  const ticket = await sdk.linear.createIssue({ title: "T" });',
          `  ${use}`,
          "}",
        ].join("\n"),
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(
        /A Placeholder cannot decide a condition, be compared or have its typeof taken[^\n]*\n\s+at program\.ts:3:\d+/
      );
      expect(await ws.control("linear").receivedWrites()).toEqual([]);
    }
  );

  it("types a Write Tool's result as a Placeholder in its signature", async () => {
    const core = await openTriage();

    const [create] = core.searchSdk("create a linear issue");

    expect(create).toMatch(/\): Promise<Placeholder<\{/);
  });

  it("fails the Plan when a Placeholder is passed to a Read Tool", async () => {
    const core = await openTriage();

    const result = await core.explore({
      code: [
        "export async function main() {",
        '  const ticket = await sdk.linear.createIssue({ title: "T" });',
        "  await sdk.linear.searchIssues({ query: ticket.title });",
        "}",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /^PlaceholderError: a Placeholder cannot be passed to the Read Tool linear\.searchIssues\n\s+at main \(program\.ts:3:\d+\)/
    );
  });
});

describe("Data that looks like a Placeholder", () => {
  it("stays data, so no program can forge a Placeholder", async () => {
    const core = await openTriage();
    const lookalike = {
      $placeholder: [7],
      $$placeholder: [8],
      "$pinfold:placeholder": [9],
      placeholder: [1],
    };

    const result = await core.explore({
      code: `export async function main() {
        const lookalike = ${JSON.stringify(lookalike)};
        await sdk.linear.createIssue({ title: "T", description: JSON.stringify(lookalike) });
        return lookalike;
      }`,
    });

    expect(result).toMatchObject({ ok: true, value: lookalike });
    if (!result.ok) throw new Error(result.error);
    expect(result.plan.writes).toEqual([
      {
        tool: "linear.createIssue",
        arguments: { description: JSON.stringify(lookalike), title: "T" },
      },
    ]);
  });
});

describe("The readable Write Plan", () => {
  it("shows data that looks like a Placeholder as data", async () => {
    const core = await openTriage();
    const lookalike = "\u0000placeholder 0\u0000";

    const result = await core.explore({
      code: `export async function main() {
        const parent = await sdk.linear.createIssue({ title: "Parent" });
        await sdk.linear.createIssue({
          assigneeEmail: ${JSON.stringify(lookalike)},
          title: "Child",
          description: parent.url,
        });
        // @ts-expect-error -- a path that String.replace would garble
        await sdk.linear.createIssue({ title: "Odd", description: parent["$&"] });
      }`,
    });
    if (!result.ok) throw new Error(result.error);

    expect(formatPlan(result.plan)).toBe(
      [
        `Write Plan ${result.plan.id}: 3 writes, none sent yet`,
        '  1. linear.createIssue {"title":"Parent"}',
        `  2. linear.createIssue {"assigneeEmail":${JSON.stringify(lookalike)},"description":<write 1>.url,"title":"Child"}`,
        '  3. linear.createIssue {"description":<write 1>.$&,"title":"Odd"}',
      ].join("\n")
    );
  });
});

describe("Servers named like Object members", () => {
  it("work like any other server and leave Object alone", async () => {
    const core = await ws.open({
      servers: { constructor: ws.sentry("ctor") },
      classification: { constructor: sentryReads.sentry },
    });

    const result = await core.explore({
      code: `export async function main() {
        const { issues } = await sdk.constructor.listIssues({ project: "api" });
        return issues.map((issue) => issue.shortId);
      }`,
    });

    expect(result).toMatchObject({ ok: true, value: ["API-2A"] });
    expect(Object.hasOwn(Object, "listIssues")).toBe(false);
  });
});

describe("Write Plan identity", () => {
  const plan = async (core: Core, args: string) => {
    const result = await core.explore({
      code: `export async function main() {
        await sdk.linear.createIssue(${args});
      }`,
    });
    if (!result.ok) throw new Error(result.error);
    return result.plan.id;
  };

  it("derives the same plan ID from the same writes, whatever the key order", async () => {
    const core = await openTriage();

    const a = await plan(core, '{ title: "T", description: "D" }');
    const b = await plan(core, '{ description: "D", title: "T" }');
    const c = await plan(core, '{ title: "T", description: "other" }');

    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("tells a Placeholder apart from data that looks like one", async () => {
    const core = await openTriage();
    const second = async (description: string) => {
      const result = await core.explore({
        code: `export async function main() {
          const first = await sdk.linear.createIssue({ title: "A" });
          // @ts-expect-error -- description is a string; this test needs any value
          await sdk.linear.createIssue({ title: "B", description: ${description} });
        }`,
      });
      if (!result.ok) throw new Error(result.error);
      return result.plan.id;
    };

    const ids = await Promise.all([
      second("first"),
      second("{ placeholder: [1] }"),
      second("{ $placeholder: [1] }"),
    ]);

    expect(new Set(ids).size).toBe(3);
  });
});
