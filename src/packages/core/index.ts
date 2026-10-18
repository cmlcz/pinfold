import {
  quickJsSandbox,
  type SandboxResult,
  type Sdk,
} from "../sandbox/index.ts";
import { openBaselines } from "./lib/baselines.ts";
import { resolveLimits, type PinfoldConfig } from "./lib/config.ts";
import { connectDownstream } from "./lib/downstream.ts";
import { declarations, searchTools, type SdkTool } from "./lib/sdk.ts";

export {
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
} from "./lib/config.ts";

export type ExploreResult = SandboxResult;

export type Core = {
  /** The TypeScript signatures of the Tools that match a keyword query. */
  searchSdk(query: string): string[];
  /** Runs the agent's program as an Exploration Run. */
  explore(request: { code: string; input?: unknown }): Promise<ExploreResult>;
  close(): Promise<void>;
};

/** Opens a core on a project; `root` is the directory that holds `.workflows/`. */
export async function openCore(
  config: PinfoldConfig,
  options: { root: string }
): Promise<Core> {
  const baselines = await openBaselines(options.root);
  const downstream = await connectDownstream(config.servers);
  // Every Tool is called live until Tool classification arrives.
  const sdk: Sdk = {};
  for (const tool of downstream.tools) {
    (sdk[tool.server] ??= {})[tool.tool] = async (args) => {
      const value = await tool.call(args);
      await baselines.record(tool, value);
      return value;
    };
  }
  // A pinned Tool is described by its Baseline alone, never its live listing.
  const sdkTools = (): SdkTool[] =>
    downstream.tools.map(
      (tool) => baselines.get(tool.server, tool.tool) ?? tool
    );
  const limits = resolveLimits(config);
  return {
    searchSdk: (query) => searchTools(sdkTools(), query),
    explore: ({ code, input }) =>
      quickJsSandbox.run({
        source: code,
        declarations: declarations(sdkTools()),
        input: input ?? {},
        sdk,
        limits,
      }),
    close: downstream.close,
  };
}
