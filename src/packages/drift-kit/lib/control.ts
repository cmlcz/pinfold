// The control channel: HTTP over a Unix socket,
// kept apart from the MCP Tools so the agent under test cannot reach it.
import { rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import type { ReceivedWrite, World } from "./world.ts";

export async function serveControl(
  path: string,
  world: World<unknown>
): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://control");
    const route = `${req.method} ${url.pathname}`;
    const call = Number(url.searchParams.get("call"));
    if (route === "POST /reset") {
      world.reset();
      res.writeHead(204).end();
    } else if (route === "POST /fail-write") {
      if (!isCall(call)) {
        res.writeHead(400).end("call must be a whole number from 1");
        return;
      }
      world.failWrite(call);
      res.writeHead(204).end();
    } else if (route === "GET /writes") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(world.receivedWrites));
    } else {
      res.writeHead(404).end();
    }
  });
  try {
    await listen(server, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await answers(path)) {
      throw new Error(
        `The control socket ${path} belongs to another running Drift Kit server.`,
        { cause: error }
      );
    }
    // A crashed earlier run left its socket file behind.
    rmSync(path, { force: true });
    await listen(server, path);
  }
  return server;
}

// A write counted from the next one, which is 1.
function isCall(call: number): boolean {
  return Number.isSafeInteger(call) && call >= 1;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// Whether a server is listening on the socket.
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export type ControlClient = {
  /** Restores the server's seeded state and empties its received-writes log. */
  reset(): Promise<void>;
  /** Every write the server has received since it started or was last reset. */
  receivedWrites(): Promise<ReceivedWrite[]>;
  /**
   * Makes the `call`-th write from now on (1 is the next) fail with an error
   * result. A failed write changes nothing and is not logged as received.
   */
  failWrite(call: number): Promise<void>;
};

export function connectControl(path: string): ControlClient {
  return {
    async reset() {
      await send(path, "POST", "/reset");
    },
    async receivedWrites() {
      return JSON.parse(await send(path, "GET", "/writes")) as ReceivedWrite[];
    },
    async failWrite(call) {
      if (!isCall(call)) {
        throw new Error(`failWrite takes a call from 1, not ${call}`);
      }
      await send(path, "POST", `/fail-write?call=${call}`);
    },
  };
}

function send(path: string, method: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, method, path: url }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== undefined && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`control ${method} ${url}: ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
