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

    expect(result).toEqual({ ok: true, value: 2 });
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
  });
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

    expect(result).toEqual({ ok: true, value: ["a", "b", [], "undefined"] });
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

    expect(result).toEqual({ ok: true, value: lookalike });
    expect(received).toEqual([lookalike]);
    expect(JSON.stringify(received)).not.toContain("Placeholder");
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
