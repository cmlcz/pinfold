// A local proxy in front of OpenRouter for the CLI drivers. Neither Claude
// Code nor Codex can send OpenRouter's provider preferences, so the proxy
// adds them to every model call: the provider is pinned and fallbacks are
// off, as in the minimal agent loop (ADR 0006).
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type PinProxy = {
  /**
   * Stands in for https://openrouter.ai for one run: append /api or
   * /api/v1. Each run has its own, so that runs at the same time do not
   * take each other's calls.
   */
  url(run: string): string;
  /** The run's model calls answered since its last take. */
  takeCalls(run: string): ProxiedCall[];
  close(): Promise<void>;
};

/** What OpenRouter's answer to one model call said of it. */
export type ProxiedCall = {
  /** In USD, from the answer's usage; undefined if it gave none. */
  cost: number | undefined;
  /** The model and the provider that served it, where named. */
  served: string | undefined;
};

export async function servePinProxy({
  provider,
  upstream = "https://openrouter.ai",
  log = () => {},
}: {
  provider: string;
  upstream?: string;
  /** Gets a line per model call answered, to show a run is alive. */
  log?: (line: string) => void;
}): Promise<PinProxy> {
  // The calls of each run, by the first segment of the path.
  const calls = new Map<string, ProxiedCall[]>();
  const http = createServer(async (req, res) => {
    try {
      const [, run = "", ...path] = (req.url ?? "/").split("/");
      let body = await readBody(req);
      const started = Date.now();
      if (req.method === "POST" && isJson(req)) {
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        if (typeof parsed.model === "string") {
          // Codex always sends it, and endpoints that cannot honour it would
          // otherwise be filtered out by require_parameters.
          delete parsed.parallel_tool_calls;
          parsed.provider = {
            order: [provider],
            allow_fallbacks: false,
            require_parameters: true,
          };
          body = Buffer.from(JSON.stringify(parsed));
        }
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (["host", "content-length", "accept-encoding"].includes(key)) {
          continue;
        }
        for (const item of [value ?? []].flat()) headers.append(key, item);
      }
      const response = await fetch(new URL(`/${path.join("/")}`, upstream), {
        method: req.method ?? "GET",
        headers,
        ...(body.length > 0 && { body }),
      });
      // fetch has decoded the body, so its encoding and length no longer hold.
      const out = Object.fromEntries(
        [...response.headers].filter(
          ([key]) => key !== "content-encoding" && key !== "content-length"
        )
      );
      res.writeHead(response.status, out);
      let text = "";
      if (response.body) {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          res.write(chunk);
          text += decoder.decode(chunk, { stream: true });
        }
      }
      res.end();
      // A refused call is not charged. Claude Code makes some on purpose: it
      // first asks for deferred tool loading, then falls back.
      if (response.ok && response.headers.has("x-generation-id")) {
        const call = readCall(text);
        const ofRun = calls.get(run) ?? [];
        ofRun.push(call);
        calls.set(run, ofRun);
        log(
          `  model call ${ofRun.length}: ${Date.now() - started} ms, $${(call.cost ?? 0).toFixed(5)}`
        );
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String((error as Error).message));
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  return {
    url: (run) => `http://127.0.0.1:${port}/${run}`,
    takeCalls(run) {
      const taken = calls.get(run) ?? [];
      calls.delete(run);
      return taken;
    },
    async close() {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").includes("application/json");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The cost and who served a call, from OpenRouter's answer, a JSON body
 * or a stream of events: the usage it ends with carries a `cost`, and the
 * Messages API also names the `provider`.
 */
export function readCall(text: string): ProxiedCall {
  const cost = [...text.matchAll(/"cost":\s*([0-9.eE+-]+)/g)].at(-1)?.[1];
  const model = /"model":\s*"([^"]+)"/.exec(text)?.[1];
  const provider = /"provider":\s*"([^"]+)"/.exec(text)?.[1];
  return {
    cost: cost === undefined ? undefined : Number(cost),
    served:
      model === undefined
        ? undefined
        : provider === undefined
          ? model
          : `${model}@${provider}`,
  };
}
