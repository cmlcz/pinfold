import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type ServerConfig } from "../index.ts";
import { createWorkspace, type Workspace } from "./workspace.ts";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
  vi.stubEnv("ENV_SERVER_TOKEN", "stdio-secret-token");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ws.close();
});

const envServer = (config: Partial<ServerConfig> = {}): ServerConfig => ({
  command: process.execPath,
  args: [fileURLToPath(new URL("env-server.ts", import.meta.url))],
  ...config,
});

const whoami = `export async function main() {
  return await sdk.env.whoami({});
}`;

function open(env: ServerConfig) {
  return ws.open({
    servers: { env },
    classification: { env: { whoami: "read" } },
  });
}

describe("stdio Downstream Servers", () => {
  it("passes environment variables, by value and by reference, and runs in cwd", async () => {
    await mkdir(join(ws.dir, "server"));
    const core = await open(
      envServer({
        env: { TOKEN: "${ENV_SERVER_TOKEN}", PLAIN: "plain value" },
        cwd: "server",
      })
    );

    expect(await core.explore({ code: whoami })).toMatchObject({
      ok: true,
      value: {
        cwd: await realpath(join(ws.dir, "server")),
        token: "stdio-secret-token",
        plain: "plain value",
      },
    });
  });

  it("passes no variable that is not configured", async () => {
    vi.stubEnv("TOKEN", "from the parent");
    const core = await open(envServer());

    expect(await core.explore({ code: whoami })).toMatchObject({
      ok: true,
      value: { token: null, plain: null },
    });
  });

  it("names the server and the variable when an environment variable is not set", async () => {
    await expect(
      open(envServer({ env: { TOKEN: "${MISSING_TOKEN}" } }))
    ).rejects.toThrow(
      'Downstream Server "env" needs the environment variable MISSING_TOKEN, which is not set.'
    );
  });

  it("names the server whose cwd is not a directory", async () => {
    await expect(open(envServer({ cwd: "missing" }))).rejects.toThrow(
      `Downstream Server "env" could not be started: its cwd ${join(ws.dir, "missing")} is not a directory`
    );
  });

  it("refuses an environment value with a malformed variable reference", async () => {
    const path = join(ws.dir, "pinfold.json");
    await writeFile(
      path,
      JSON.stringify({
        servers: { env: { command: "node", env: { TOKEN: "${1TOKEN}" } } },
      })
    );
    await expect(loadConfig(path)).rejects.toThrow(/as \$\{NAME\}/);
  });
});
