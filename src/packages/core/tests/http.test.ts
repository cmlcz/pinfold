import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, openCore, type ServerConfig } from "../index.ts";
import { createWorkspace, sentryReads, type Workspace } from "./workspace.ts";

const token = "drift-kit-secret-token";

let ws: Workspace;

beforeEach(async () => {
  ws = await createWorkspace();
  vi.stubEnv("SENTRY_TOKEN", token);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ws.close();
});

const listIssues = `
  export async function main() {
    const { issues } = await sdk.sentry.listIssues({ project: "web" });
    return issues.map((issue: { shortId: string }) => issue.shortId);
  }
`;

function open(sentry: ServerConfig) {
  return openCore(
    { servers: { sentry }, classification: sentryReads },
    { root: ws.dir }
  );
}

// An address nothing listens on: a port that was free a moment ago.
async function closedUrl(): Promise<string> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

describe("Streamable HTTP Downstream Servers", () => {
  it("runs an Exploration Run against an HTTP server with a bearer token from the environment", async () => {
    const url = await ws.serveHttp("sentry", { token });
    const core = await open({
      url,
      headers: { Authorization: "Bearer ${SENTRY_TOKEN}" },
    });
    try {
      const result = await core.explore({ code: listIssues });
      expect(result).toMatchObject({
        ok: true,
        value: ["WEB-1A", "WEB-1B", "WEB-1C"],
      });
    } finally {
      await core.close();
    }
  });

  it("loads an HTTP server from a config file", async () => {
    const url = await ws.serveHttp("sentry", { token });
    const path = join(ws.dir, "pinfold.json");
    await writeFile(
      path,
      JSON.stringify({
        servers: {
          sentry: { url, headers: { Authorization: "Bearer ${SENTRY_TOKEN}" } },
        },
      })
    );

    const config = await loadConfig(path);
    const core = await openCore(
      { ...config, classification: sentryReads },
      { root: ws.dir }
    );
    try {
      expect(await core.explore({ code: listIssues })).toMatchObject({
        ok: true,
      });
    } finally {
      await core.close();
    }
  });

  it("names the server and the variable when an environment variable is not set", async () => {
    const url = await ws.serveHttp("sentry", { token });

    await expect(
      open({ url, headers: { Authorization: "Bearer ${MISSING_TOKEN}" } })
    ).rejects.toThrow(
      'Downstream Server "sentry" needs the environment variable MISSING_TOKEN, which is not set.'
    );
  });

  it("names the server it cannot reach", async () => {
    await expect(open({ url: await closedUrl() })).rejects.toThrow(
      /^Downstream Server "sentry" could not connect: fetch failed \(.*ECONNREFUSED/
    );
  });

  it("names the server that rejects its token, without the token", async () => {
    const url = await ws.serveHttp("sentry", { token: "another-token" });

    const error = await open({
      url,
      headers: { Authorization: "Bearer ${SENTRY_TOKEN}" },
    }).then(
      () => expect.fail("connected"),
      (error: unknown) => error as Error
    );

    expect(error).toMatchObject({
      message:
        'Downstream Server "sentry" could not connect: the server rejected its credentials (HTTP 401)',
    });
  });

  it("keeps a secret the server echoes back out of the error and its cause", async () => {
    const echo = createServer((req, res) => {
      res.writeHead(500).end(`bad header: ${req.headers["x-api-key"]}`);
    }).listen(0, "127.0.0.1");
    await once(echo, "listening");
    const { port } = echo.address() as AddressInfo;
    try {
      const error = await open({
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "X-Api-Key": "${SENTRY_TOKEN}" },
      }).then(
        () => expect.fail("connected"),
        (error: unknown) => error as Error
      );

      expect(error.message).toMatch(
        /^Downstream Server "sentry" could not connect: .*\[secret\]/
      );
      expect(error.message).not.toContain(token);
      expect(error.cause).toBeUndefined();
    } finally {
      echo.close();
    }
  });
});

describe("HTTP server configuration", () => {
  async function load(sentry: unknown) {
    const path = join(ws.dir, "pinfold.json");
    await writeFile(path, JSON.stringify({ servers: { sentry } }));
    return loadConfig(path);
  }

  it("refuses credentials written into the URL", async () => {
    await expect(
      load({ url: "https://user:secret@sentry.example/mcp" })
    ).rejects.toThrow(/servers\.sentry\.url/);
  });

  it("refuses a header value with a malformed variable reference", async () => {
    await expect(
      load({ url: "https://sentry.example/mcp", headers: { A: "${1TOKEN}" } })
    ).rejects.toThrow(/as \$\{NAME\}/);
  });

  it("refuses a server that is both stdio and HTTP", async () => {
    await expect(
      load({ command: "node", url: "https://sentry.example/mcp" })
    ).rejects.toThrow(/servers\.sentry/);
  });
});
