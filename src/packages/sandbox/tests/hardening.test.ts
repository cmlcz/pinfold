import { describe, expect, it } from "vitest";
import { Placeholder, quickJsSandbox, type Sdk } from "../index.ts";

const declarations = "declare const sdk: any;\n";

function run(source: string, sdk: Sdk = {}, limits = {}) {
  return quickJsSandbox.run({
    source,
    declarations,
    input: {},
    sdk,
    limits: {
      timeoutMs: 5000,
      memoryBytes: 64 * 1024 * 1024,
      toolCalls: 10,
      ...limits,
    },
  });
}

describe("Host results", () => {
  it("fails the call, not the process, when a result cannot cross into the guest", async () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    const sdk = {
      s: { deep: async () => deep, big: async () => BigInt(1) },
    };

    const result = await run(
      `export async function main() {
        const caught: string[] = [];
        for (const call of [sdk.s.deep, sdk.s.big]) {
          try { await call(); } catch (error) { caught.push(String(error)); }
        }
        return caught.length;
      }`,
      sdk
    );

    expect(result).toMatchObject({ ok: true, value: 2 });
  });
});

describe("Built-ins", () => {
  it("returns an error, not a crash, when a built-in overflows the stack", async () => {
    const result = await run(`export async function main() {
      let nested: unknown[] = [];
      for (let i = 0; i < 20000; i++) nested = [nested];
      return JSON.stringify(nested).length;
    }`);

    expect(result.ok).toBe(false);
  });

  it("returns an error, not a crash, when a built-in overflows the stack after a Tool call", async () => {
    const sdk = { s: { read: async () => 1 } };
    const result = await run(
      `export async function main() {
        await sdk.s.read();
        let nested: unknown[] = [];
        for (let i = 0; i < 20000; i++) nested = [nested];
        return JSON.stringify(nested).length;
      }`,
      sdk
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^InternalError: the program exhausted the stack inside a built-in function/
      ),
    });
  });

  // The built-in cannot be interrupted, so the test waits it out; under a
  // loaded machine that takes longer than the default test timeout.
  it("reports the time limit when one built-in call overruns it", async () => {
    const result = await run(
      `export async function main() {
        return new Array(30_000_000).join("ab").length;
      }`,
      {},
      { timeoutMs: 50, memoryBytes: 512 * 1024 * 1024 }
    );

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its time limit of 50 ms",
    });
  }, 30_000);
});

describe("The sdk object", () => {
  it("keeps namespaces and Tools named like Object members to themselves", async () => {
    const sdk = {
      constructor: { list: async () => "a" },
      s: { toString: async () => "b" },
    };

    const result = await run(
      `export async function main() {
        return [
          await sdk.constructor.list(),
          await sdk.s.toString(),
          Object.keys(({}).constructor),
          typeof (Object.prototype as any).list,
        ];
      }`,
      sdk
    );

    expect(result).toMatchObject({
      ok: true,
      value: ["a", "b", [], "undefined"],
    });
  });

  it("cannot be made to forge a Placeholder by tampering with built-ins", async () => {
    const received: unknown[] = [];
    const sdk = {
      s: {
        write: async (args: unknown) => {
          received.push(args);
          return null;
        },
      },
    };
    const lookalike = { $placeholder: [5, "id"] };

    const result = await run(
      `export async function main() {
        const strip = (entries: Iterable<[string, unknown]>) =>
          [...entries].map(([k, v]) => [k.startsWith("$$") ? k.slice(1) : k, v]);
        const fromEntries = Object.fromEntries;
        Object.fromEntries = ((entries: Iterable<[string, unknown]>) =>
          fromEntries(strip(entries))) as typeof Object.fromEntries;
        const stringify = JSON.stringify;
        JSON.stringify = ((value: unknown) =>
          stringify(value).replaceAll("$$", "$")) as typeof JSON.stringify;
        String.prototype.startsWith = () => false;
        Array.prototype.map = function () { return []; };
        WeakMap.prototype.get = () => [9, "x"];
        await sdk.s.write(${JSON.stringify(lookalike)});
        return ${JSON.stringify(lookalike)};
      }`,
      sdk
    );

    expect(result).toMatchObject({ ok: true, value: lookalike });
    expect(received).toEqual([lookalike]);
    expect(JSON.stringify(received)).not.toContain("Placeholder");
    expect(received[0]).not.toBeInstanceOf(Placeholder);
  });

  it("cannot forge a Placeholder or hide its reads with a toJSON on a prototype", async () => {
    const received: unknown[] = [];
    const sdk = {
      s: {
        read: async () => ({ secret: 1 }),
        write: async (args: unknown) => {
          received.push(args);
          return null;
        },
      },
    };

    const result = await run(
      `export async function main() {
        const { secret } = await sdk.s.read();
        const bare = (fields: object) =>
          Object.assign(Object.create(null), fields);
        const forged = bare({
          value: bare({ $placeholder: "7" }),
          reads: bare({}),
        });
        (Object.prototype as any).toJSON = () => forged;
        await sdk.s.write({ body: secret });
        return [secret];
      }`,
      sdk
    );

    expect(result).toMatchObject({
      ok: true,
      reads: { "s.read": ["secret"] },
    });
    const { value } = result as { value: unknown };
    expect(value).not.toBeInstanceOf(Placeholder);
    expect(JSON.stringify([value, received])).not.toMatch(/Placeholder/);
    expect(received).toHaveLength(1);
    expect(received[0]).not.toBeInstanceOf(Placeholder);
  });
});

describe("The type check", () => {
  it("reports syntax errors at character columns after non-ASCII text", async () => {
    const result = await run(`const s = "ééé€"; let = ;`);

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("at program.ts:1:25"),
    });
  });

  it("does not load libraries beyond the standard ES library", async () => {
    const result = await run(`/// <reference lib="dom" />
      export async function main() {
        return typeof fetch;
      }`);

    expect(result.ok).toBe(false);
  });

  it("does not resolve imports to files on the host", async () => {
    const result =
      await run(`import type { Plans } from "${process.cwd()}/src/packages/core/lib/plans.ts";
      export async function main() {
        const plans: Plans | null = null;
        return plans;
      }`);

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("TS2307"),
    });
  });
});

describe("The clock", () => {
  const clocked = (seed: number) =>
    quickJsSandbox.run({
      source: `export async function main() {
        return [Date.now(), new Date().getTime(), Date(), new Date(0).getTime(), Math.random(), Math.random()];
      }`,
      declarations,
      input: {},
      sdk: {},
      limits: { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024, toolCalls: 10 },
      clock: { now: 1_700_000_000_000, seed },
    });

  it("gives the run the clock's time and seeded random numbers", async () => {
    const first = await clocked(7);
    const again = await clocked(7);
    const other = await clocked(8);

    if (!first.ok) throw new Error(first.error);
    const [now, constructed, text, epoch, a, b] = first.value as unknown[];
    expect([now, constructed, epoch]).toEqual([
      1_700_000_000_000, 1_700_000_000_000, 0,
    ]);
    expect(text).toMatch(/^\w{3} Nov 1[45] 2023 /);
    expect(a).not.toBe(b);
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });
});

describe("Field reads", () => {
  it("reports the result fields the program read, by Tool", async () => {
    const issues = {
      issues: [
        { id: "1", count: 60, culprit: "a.ts", "weird key": 1, meta: { x: 1 } },
        { id: "2", count: 3, culprit: "b.ts", "weird key": 2, meta: { x: 2 } },
      ],
      total: 2,
    };
    const sdk = {
      sentry: { listIssues: async () => issues, other: async () => [{ a: 1 }] },
    };

    const result = await run(
      `export async function main() {
        const { issues } = await sdk.sentry.listIssues({});
        const [first] = await sdk.sentry.other({});
        const frequent = issues.filter((i: any) => i.count >= 50);
        return { ids: frequent.map((i: any) => i.id), weird: issues[0]["weird key"], first };
      }`,
      sdk
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ ids: ["1"], weird: 1, first: { a: 1 } });
    expect(Object.keys(result.reads).sort()).toEqual([
      "sentry.listIssues",
      "sentry.other",
    ]);
    expect([...result.reads["sentry.listIssues"]!].sort()).toEqual([
      "issues",
      "issues[]",
      "issues[].count",
      "issues[].id",
      'issues[]["weird key"]',
    ]);
    expect([...result.reads["sentry.other"]!].sort()).toEqual(["[]", "[].a"]);
  });
});
