// A Drift Kit server over Streamable HTTP, on a free port of the loopback host.
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveControl } from "./control.ts";
import { servers, type DriftKitServerName } from "./servers.ts";

export type HttpDriftKitServer = {
  /** The Streamable HTTP endpoint. */
  url: string;
  close(): Promise<void>;
};

export async function serveHttp(
  name: DriftKitServerName,
  options: { control: string; token?: string }
): Promise<HttpDriftKitServer> {
  const { world, server } = servers[name]();
  const handler = createMcpHandler(() => server());
  const http = createServer(async (req, res) => {
    if (
      options.token !== undefined &&
      req.headers.authorization !== `Bearer ${options.token}`
    ) {
      res.writeHead(401).end();
      return;
    }
    const response = await handler.fetch(await toRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  });
  const control = await serveControl(options.control, world);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      http.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => http.close(resolve)),
        new Promise((resolve) => control.close(resolve)),
      ]);
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    for (const item of [value ?? []].flat()) headers.append(key, item);
  }
  return new Request(new URL(req.url ?? "/", "http://127.0.0.1"), {
    method: req.method ?? "GET",
    headers,
    ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
  });
}
