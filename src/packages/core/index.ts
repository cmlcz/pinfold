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
  shortHash,
  writePlan,
  type PlannedWrite,
  type WritePlan,
} from "./lib/plan.ts";
import { declarations, searchTools, type SdkTool } from "./lib/sdk.ts";
import { resolvePlaceholders, sendWrites } from "./lib/apply.ts";
import { openPlanStore, type PlanRecord } from "./lib/plans.ts";
import { writeCount, type ExploreResult } from "./lib/outcome.ts";

export {
  classifyTools,
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
  type ToolKind,
} from "./lib/config.ts";
export type { PlannedWrite, WritePlan } from "./lib/plan.ts";
export {
  openPlans,
  type PlanRecord,
  type Plans,
  type PlanStatus,
} from "./lib/plans.ts";
export {
  formatOutcome,
  formatPlan,
  type ExploreResult,
} from "./lib/outcome.ts";
export type { Placeholder } from "../sandbox/index.ts";

const writeToolNote =
  "Write Tool: a run records this call in its Write Plan instead of sending it, and gets a Placeholder back.";

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
  const classificationOf = (tool: DownstreamTool) => {
    const servers = config.classification ?? {};
    const tools = Object.hasOwn(servers, tool.server)
      ? servers[tool.server]!
      : {};
    return Object.hasOwn(tools, tool.tool) ? tools[tool.tool] : undefined;
  };
  const isRead = (tool: DownstreamTool) => classificationOf(tool) === "read";

  // During a Plan, Read Tools run live and Write Tool calls are recorded.
  function planSdk(writes: PlannedWrite[]): Sdk {
    // No prototype, so a server named like an Object member is just a name.
    const sdk: Sdk = Object.create(null);
    for (const tool of downstream.tools) {
      const name = `${tool.server}.${tool.tool}`;
      if (!Object.hasOwn(sdk, tool.server))
        sdk[tool.server] = Object.create(null);
      sdk[tool.server]![tool.tool] = isRead(tool)
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
  const plans = openPlanStore(options.root);
  const tools = new Map(
    downstream.tools.map((tool) => [`${tool.server}.${tool.tool}`, tool])
  );
  function toolOf(write: PlannedWrite): DownstreamTool {
    const tool = tools.get(write.tool);
    if (tool === undefined) throw new Error(`${write.tool} is not offered`);
    return tool;
  }

  // The plan was rebuilt by this very run, so its reads are fresh.
  async function apply(
    record: PlanRecord,
    plan: WritePlan,
    value: unknown
  ): Promise<ExploreResult> {
    if (!(await plans.claim(record))) {
      return busy(plan);
    }
    let results: unknown[];
    try {
      results = await sendWrites(plan.writes, (write, args) =>
        toolOf(write).call(args)
      );
    } catch (error) {
      await plans.finish(record, "failed");
      return { ok: false, error: (error as Error).message };
    }
    await plans.finish(record, "applied");
    try {
      for (const [index, write] of plan.writes.entries()) {
        await baselines.record(toolOf(write), results[index]);
      }
      return {
        ok: true,
        status: "applied",
        value: resolvePlaceholders(value, results),
        plan,
      };
    } catch (error) {
      return {
        ok: false,
        error: `Applied Write Plan ${plan.id}: ${writeCount(plan)} sent. Its result could not be built: ${(error as Error).message}`,
      };
    }
  }

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
    async explore({ code, input = {} }) {
      const writes: PlannedWrite[] = [];
      const result = await quickJsSandbox.run({
        source: code,
        declarations: declarations(sdkTools()),
        input,
        sdk: planSdk(writes),
        limits,
      });
      if (!result.ok) return result;
      const { value } = result;
      const plan = writePlan(writes);
      if (plan.writes.length === 0)
        return { ok: true, status: "complete", value, plan };

      const run = runKey(code, input);
      const record = await plans.latest(plan.id);
      switch (record?.status) {
        case "declined":
          return { ok: true, status: "declined", value, plan };
        case "approved":
          return apply(record, plan, value);
        case "applying":
          return busy(plan);
        case "failed":
          return {
            ok: false,
            error: `Write Plan ${plan.id} stopped after a failed write and is never sent again by a run; nothing was sent.`,
          };
        case "pending":
          break;
        default:
          // New, or applied before: the developer approves this run afresh.
          await plans.addPending(plan, run);
      }
      const approved = await plans.approvedFor(run);
      return approved === undefined
        ? { ok: true, status: "pending", value, plan }
        : { ok: true, status: "changed", value, plan, approved };
    },
    close: downstream.close,
  };
}

// The same code and input give the same run key.
function runKey(code: string, input: unknown): string {
  return shortHash(JSON.stringify([code, input]));
}

function busy(plan: WritePlan): ExploreResult {
  return {
    ok: false,
    error: `Write Plan ${plan.id} is being applied by another run, or a run applying it stopped; nothing was sent. If no run is applying it, \`pinfold decline ${plan.id}\` gives it up.`,
  };
}
