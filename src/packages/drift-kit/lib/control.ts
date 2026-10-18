// The control channel: HTTP over a Unix socket,
// kept apart from the MCP Tools so the agent under test cannot reach it.
import { rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { ReceivedWrite, World } from "./world.ts";

export function serveControl(
  path: string,
  world: World<unknown>
): Promise<Server> {
  const server = createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    if (route === "POST /reset") {
      world.reset();
      res.writeHead(204).end();
    } else if (route === "GET /writes") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(world.receivedWrites));
    } else {
      res.writeHead(404).end();
    }
  });
  // A crashed earlier run can leave the socket file behind.
  rmSync(path, { force: true });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

export type ControlClient = {
  /** Restores the server's seeded state and empties its received-writes log. */
  reset(): Promise<void>;
  /** Every write the server has received since it started or was last reset. */
  receivedWrites(): Promise<ReceivedWrite[]>;
};

export function connectControl(path: string): ControlClient {
  return {
    async reset() {
      await send(path, "POST", "/reset");
    },
    async receivedWrites() {
      return JSON.parse(await send(path, "GET", "/writes")) as ReceivedWrite[];
    },
  };
}

function send(path: string, method: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, method, path: url }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
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
