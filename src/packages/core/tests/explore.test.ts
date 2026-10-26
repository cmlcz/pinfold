import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  openCore,
  type Core,
  type PinfoldConfig,
} from "../index.ts";
import { createWorkspace, type Workspace } from "./workspace.ts";

let ws: Workspace;
let core: Core;

async function open(config: Partial<PinfoldConfig> = {}) {
  core = await ws.open(config);
}

beforeEach(async () => {
  ws = await createWorkspace();
});

afterEach(() => ws.close());

describe("Exploration Run", () => {
  it("runs TypeScript that calls a Downstream Server Tool and returns only main's result", async () => {
    await open();

    const result = await core.explore({
      code: `
        type Issue = { shortId: string; count: number };

        export async function main(input: { project: string }) {
          const { issues } = await sdk.sentry.listIssues({ project: input.project });
          return issues
            .filter((issue: Issue) => issue.count >= 100)
            .map((issue: Issue) => issue.shortId);
        }
      `,
      input: { project: "web" },
    });

    expect(result).toMatchObject({ ok: true, value: ["WEB-1A", "WEB-1C"] });
  });
});

describe("Configuration", () => {
  it("loads Downstream Servers and limits from a config file", async () => {
    const path = join(ws.dir, "pinfold.json");
    await writeFile(
      path,
      JSON.stringify({
        servers: { sentry: ws.sentry() },
        limits: { toolCalls: 1 },
      })
    );

    core = await ws.open(await loadConfig(path));
    const result = await core.explore({
      code: `export async function main() {
        await sdk.sentry.listIssues({ project: "web" });
        await sdk.sentry.listIssues({ project: "api" });
      }`,
    });

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its limit of 1 Tool calls",
    });
  });

  it("rejects a config file that does not match the expected shape", async () => {
    const path = join(ws.dir, "pinfold.json");
    await writeFile(
      path,
      JSON.stringify({ servers: { sentry: { args: [] } } })
    );

    await expect(loadConfig(path)).rejects.toThrow(
      /pinfold\.json.*a stdio server with a command.*servers\.sentry/s
    );
  });

  it("names a config file that is not valid JSON", async () => {
    const path = join(ws.dir, "pinfold.json");
    await writeFile(path, "{");

    await expect(loadConfig(path)).rejects.toThrow(
      `${path} is not valid JSON: `
    );
  });

  it("names the Downstream Server that cannot be started", async () => {
    await expect(
      openCore(
        { servers: { broken: { command: join(ws.dir, "missing") } } },
        { root: ws.dir }
      )
    ).rejects.toThrow(/Downstream Server "broken" could not be started/);
  });
});

describe("Exploration isolation", () => {
  it("gives the program no host globals for files, network, environment or processes", async () => {
    await open();

    const result = await core.explore({
      code: `
        export async function main() {
          const g = globalThis as Record<string, unknown>;
          const names = [
            "require", "process", "Deno", "Bun", "std", "os",
            "fetch", "XMLHttpRequest", "WebSocket", "setTimeout",
          ];
          const escaped = Function("return typeof process")();
          return { present: names.filter((name) => name in g), escaped };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { present: [], escaped: "undefined" },
    });
  });

  it.each([
    [
      "the filesystem",
      "readFileSync",
      "node:fs",
      'readFileSync("/etc/hosts", "utf8")',
    ],
    [
      "subprocesses",
      "execSync",
      "node:child_process",
      'execSync("id").toString()',
    ],
    [
      "the network",
      "request",
      "node:http",
      'typeof request("http://example.com")',
    ],
    ["environment variables", "env", "node:process", "env.HOME"],
  ])(
    "cannot import a module that reaches %s",
    async (_, binding, module, use) => {
      await open();

      const result = await core.explore({
        code: `// @ts-expect-error -- skip the type check to reach the runtime
        import { ${binding} } from "${module}";
        export async function main() { return ${use}; }`,
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(
        /^ReferenceError: 'require' is not defined/
      );
    }
  );

  it("cannot load a module with a dynamic import", async () => {
    await open();

    const result = await core.explore({
      code: `
        export async function main() {
          try {
            // @ts-expect-error -- skip the type check to reach the runtime
            const fs = await import("node:fs");
            return Object.keys(fs);
          } catch (error) {
            return "blocked";
          }
        }
      `,
    });

    expect(result).toMatchObject({ ok: true, value: "blocked" });
  });
});

describe("Exploration limits", () => {
  it("stops a busy loop at the time limit, even one inside try/catch", async () => {
    await open({ limits: { timeoutMs: 200 } });

    const result = await core.explore({
      code: `
        export async function main() {
          try { while (true) {} } catch { return "escaped"; }
        }
      `,
    });

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its time limit of 200 ms",
    });
  });

  it("stops an endless chain of promises at the time limit", async () => {
    await open({ limits: { timeoutMs: 200 } });

    const result = await core.explore({
      code: `
        export async function main() {
          while (true) await Promise.resolve();
        }
      `,
    });

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its time limit of 200 ms",
    });
  });

  it("stops a program that allocates past the memory limit", async () => {
    await open({ limits: { memoryBytes: 8 * 1024 * 1024 } });

    const result = await core.explore({
      code: `
        export async function main() {
          const buffers: Uint8Array[] = [];
          while (true) buffers.push(new Uint8Array(1024 * 1024));
        }
      `,
    });

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its memory limit of 8388608 bytes",
    });
  });

  it("stops a program that recurses without end", async () => {
    await open();

    const result = await core.explore({
      code: `
        function down(n: number): number { return down(n + 1) + 1; }
        export async function main() { return down(0); }
      `,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /^InternalError: stack overflow/
    );
  });

  it("stops a program at its Tool-call limit, even one that catches the error", async () => {
    await open({ limits: { toolCalls: 3 } });

    const result = await core.explore({
      code: `
        export async function main() {
          for (let i = 0; ; i++) {
            try { await sdk.sentry.listIssues({ project: "web" }); } catch {}
          }
        }
      `,
    });

    expect(result).toEqual({
      ok: false,
      error: "LimitError: the run exceeded its limit of 3 Tool calls",
    });
  });
});

describe("Exploration errors", () => {
  it("reports a runtime error at its line in the agent's source", async () => {
    await open();

    const result = await core.explore({
      code: [
        "type Issue = { shortId: string };",
        "export async function main() {",
        '  const { issues } = await sdk.sentry.listIssues({ project: "web" });',
        "  const missing: Issue | undefined = issues[99];",
        "  return missing!.shortId;",
        "}",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /^TypeError: cannot read property 'shortId' of undefined\n\s+at main \(program\.ts:5:\d+\)/
    );
  });

  it("reports a syntax error at its line in the agent's source", async () => {
    await open();

    const result = await core.explore({
      code: ["export async function main() {", "  return 1 +;", "}"].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/program\.ts:2:\d+/);
  });

  it("reports a failed Tool call as an error the program can catch", async () => {
    await open();

    const result = await core.explore({
      code: `
        export async function main() {
          try {
            // @ts-expect-error -- send arguments the server rejects
            await sdk.sentry.listIssues({ project: 42 });
            return "no error";
          } catch (error) {
            return String(error);
          }
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: expect.stringMatching(/^Error: sentry\.listIssues failed: /),
    });
  });
});
