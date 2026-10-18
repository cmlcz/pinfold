import {
  quickJsSandbox,
  type SandboxResult,
  type Sdk,
} from "../sandbox/index.ts";
import { resolveLimits, type PinfoldConfig } from "./lib/config.ts";
import { connectDownstream } from "./lib/downstream.ts";

export {
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
} from "./lib/config.ts";

export type ExploreResult = SandboxResult;

export type Core = {
  /** Runs the agent's program as an Exploration Run. */
  explore(request: { code: string; input?: unknown }): Promise<ExploreResult>;
  close(): Promise<void>;
};

export async function openCore(config: PinfoldConfig): Promise<Core> {
  const downstream = await connectDownstream(config.servers);
  // Every Tool is called live until Tool classification arrives.
  const sdk: Sdk = {};
  for (const tool of downstream.tools) {
    (sdk[tool.server] ??= {})[tool.name] = tool.call;
  }
  const limits = resolveLimits(config);
  return {
    explore: ({ code, input }) =>
      quickJsSandbox.run({ source: code, input: input ?? {}, sdk, limits }),
    close: downstream.close,
  };
}
