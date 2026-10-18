import {
  Placeholder,
  PlaceholderError,
  quickJsSandbox,
  type Sdk,
} from "../sandbox/index.ts";
import { openBaselines } from "./lib/baselines.ts";
import {
  resolveLimits,
  type PinfoldConfig,
  type ToolKind,
} from "./lib/config.ts";
import { connectDownstream, type DownstreamTool } from "./lib/downstream.ts";
import {
  canonicalize,
  containsPlaceholder,
  writePlan,
  type PlannedWrite,
  type WritePlan,
} from "./lib/plan.ts";
import { declarations, searchTools, type SdkTool } from "./lib/sdk.ts";

export {
  classifyTools,
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
  type ToolKind,
} from "./lib/config.ts";
export type { PlannedWrite, WritePlan } from "./lib/plan.ts";
export { formatOutcome } from "./lib/format.ts";
export type { Placeholder } from "../sandbox/index.ts";

const writeToolNote =
  "Write Tool: a run records this call in its Write Plan instead of sending it, and gets a Placeholder back.";

/** An Exploration Run ran as a Plan: its result, and the writes it would send. */
export type ExploreResult =
  { ok: true; value: unknown; plan: WritePlan } | { ok: false; error: string };

/** How a Tool is treated, and what its server's annotations suggest. */
export type ToolClassification = {
  server: string;
  tool: string;
  kind: ToolKind;
  suggestion: ToolKind;
  /** False for a Tool the developer has not classified yet. */
  classified: boolean;
};

export type Core = {
  /** Every Tool of every Downstream Server, with its classification. */
  toolClassifications(): ToolClassification[];
  /** The TypeScript signatures of the Tools that match a keyword query. */
  searchSdk(query: string): string[];
  /** Runs the agent's program as an Exploration Run, which is a Plan. */
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
  const classificationOf = (tool: DownstreamTool) =>
    config.classification?.[tool.server]?.[tool.tool];
  const isRead = (tool: DownstreamTool) => classificationOf(tool) === "read";

  // During a Plan, Read Tools run live and Write Tool calls are recorded.
  function planSdk(writes: PlannedWrite[]): Sdk {
    const sdk: Sdk = {};
    for (const tool of downstream.tools) {
      const name = `${tool.server}.${tool.tool}`;
      (sdk[tool.server] ??= {})[tool.tool] = isRead(tool)
        ? async (args) => {
            if (containsPlaceholder(args)) {
              throw new PlaceholderError(
                `a Placeholder cannot be passed to the Read Tool ${name}`
              );
            }
            const value = await tool.call(args);
            await baselines.record(tool, value);
            return value;
          }
        : async (args) => {
            writes.push({ tool: name, arguments: canonicalize(args) });
            return new Placeholder(writes.length);
          };
    }
    return sdk;
  }

  // A pinned Tool is described by its Baseline alone, never its live listing.
  // Write Tools say so, since a run only records their calls.
  const sdkTools = (): SdkTool[] =>
    downstream.tools.map((tool) => {
      const known = baselines.get(tool.server, tool.tool) ?? tool;
      if (isRead(tool)) return known;
      const description = [known.description, writeToolNote].filter(Boolean);
      return { ...known, description: description.join(" ") };
    });
  const limits = resolveLimits(config);
  return {
    toolClassifications: () =>
      downstream.tools.map((tool) => ({
        server: tool.server,
        tool: tool.tool,
        kind: isRead(tool) ? "read" : "write",
        suggestion: tool.readOnlyHint ? "read" : "write",
        classified: classificationOf(tool) !== undefined,
      })),
    searchSdk: (query) => searchTools(sdkTools(), query),
    async explore({ code, input }) {
      const writes: PlannedWrite[] = [];
      const result = await quickJsSandbox.run({
        source: code,
        declarations: declarations(sdkTools()),
        input: input ?? {},
        sdk: planSdk(writes),
        limits,
      });
      return result.ok ? { ...result, plan: writePlan(writes) } : result;
    },
    close: downstream.close,
  };
}
