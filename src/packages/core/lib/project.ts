// A project as a core holds it open: its config, its connected Downstream
// Servers and Tools, and the stores of its Baselines, Write Plans, Apply
// Journal and Repairs. The parts of a core all work on one.
import type { Limits } from "../../sandbox/index.ts";
import { openBaselines, toolName, type Baselines } from "./baselines.ts";
import { resolveLimits, type PinfoldConfig, type ToolKind } from "./config.ts";
import {
  connectDownstream,
  type Downstream,
  type DownstreamTool,
} from "./downstream.ts";
import { openJournal, type Journal } from "./journal.ts";
import type { ModelClient } from "./model.ts";
import type { PlannedWrite } from "./plan.ts";
import { openPlanStore, type PlanStore } from "./plans.ts";
import { openRepairs, type Repairs } from "./repair.ts";
import type { SdkTool } from "./sdk.ts";

const writeToolNote =
  "Write Tool: a run records this call in its Write Plan instead of sending it, and gets a Placeholder back.";

export type Project = {
  /** The directory that holds `.workflows/`. */
  root: string;
  config: PinfoldConfig;
  limits: Limits;
  downstream: Downstream;
  /** Every offered Tool, by its name as `server.tool`. */
  tools: Map<string, DownstreamTool>;
  /** The developer's classification of a Tool, if they classified it. */
  classificationOf(tool: DownstreamTool): ToolKind | undefined;
  isRead(tool: DownstreamTool): boolean;
  /** The Tools as the SDK describes them. */
  sdkTools(): SdkTool[];
  /** The offered Tool a write calls; throws if none is offered. */
  toolOf(write: PlannedWrite): DownstreamTool;
  baselines: Baselines;
  plans: PlanStore;
  journal: Journal;
  repairs: Repairs;
  /** The Repair Model, if the developer configured one. */
  model: ModelClient | undefined;
  close(): Promise<void>;
};

export async function openProject(
  config: PinfoldConfig,
  root: string,
  model: ModelClient | undefined
): Promise<Project> {
  const baselines = await openBaselines(root);
  const downstream = await connectDownstream(config.servers, root);
  const classificationOf = (tool: DownstreamTool) => {
    const servers = config.classification ?? {};
    const tools = Object.hasOwn(servers, tool.server)
      ? servers[tool.server]!
      : {};
    return Object.hasOwn(tools, tool.tool) ? tools[tool.tool] : undefined;
  };
  const isRead = (tool: DownstreamTool) => classificationOf(tool) === "read";
  const tools = new Map(downstream.tools.map((tool) => [toolName(tool), tool]));
  const journal = openJournal(root);
  return {
    root,
    config,
    limits: resolveLimits(config),
    downstream,
    tools,
    classificationOf,
    isRead,
    // A pinned Tool is described by its Baseline alone, never its live
    // listing. Write Tools say so, since a run only records their calls.
    sdkTools: () =>
      downstream.tools.map((tool) => {
        const known = baselines.get(tool.server, tool.tool) ?? tool;
        if (isRead(tool)) return known;
        const parts = [known.description, writeToolNote].filter(Boolean);
        return { ...known, description: parts.join(" "), write: true };
      }),
    toolOf(write) {
      const tool = tools.get(write.tool);
      if (tool === undefined) throw new Error(`${write.tool} is not offered`);
      return tool;
    },
    baselines,
    plans: openPlanStore(root),
    journal,
    repairs: openRepairs(root),
    model,
    async close() {
      journal.close();
      await downstream.close();
    },
  };
}
