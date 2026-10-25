// The core of pinfold: a project held open, with the Exploration Runs,
// Workflow Runs, Apply and Repair that the Gateway and the CLI offer.
import { randomUUID } from "node:crypto";
import { planOutcome, resume } from "./lib/apply.ts";
import type { PinfoldConfig, ToolKind } from "./lib/config.ts";
import { configuredModel, type ModelClient } from "./lib/model.ts";
import { writePlan } from "./lib/plan.ts";
import { planRun } from "./lib/plan-run.ts";
import { openProject } from "./lib/project.ts";
import { proposeRepair, repairTasks } from "./lib/repair-drift.ts";
import type { PendingDrift, RepairTask } from "./lib/repair.ts";
import { declarations, searchTools } from "./lib/sdk.ts";
import type {
  ExploreResult,
  ProposalResult,
  ResumeResult,
  WorkflowRunResult,
} from "./lib/outcome.ts";
import { runWorkflow } from "./lib/workflow-run.ts";
import {
  saveWorkflow,
  type CommandLineInput,
  type Exploration,
  type SaveResult,
} from "./lib/workflows.ts";

export { opsGuide } from "./lib/adapters.ts";
export { makeFieldOptional } from "./lib/baselines.ts";
export {
  classifyTools,
  loadConfig,
  type PinfoldConfig,
  type ServerConfig,
  type ToolKind,
} from "./lib/config.ts";
export { chatClient, type ModelClient, type ModelUsage } from "./lib/model.ts";
export type { PlannedWrite, WritePlan } from "./lib/plan.ts";
export type { PendingDrift, RepairRecord, RepairTask } from "./lib/repair.ts";
export {
  openPlans,
  type PlanRecord,
  type Plans,
  type PlanStatus,
} from "./lib/plans.ts";
export {
  formatOutcome,
  formatPlan,
  formatProposal,
  formatRepairTasks,
  formatResume,
  formatWorkflowRun,
  reviewPlan,
  type ExploreResult,
  type ProposalResult,
  type ResumeResult,
  type WorkflowRunResult,
} from "./lib/outcome.ts";
export {
  formatWorkflows,
  listWorkflows,
  type SaveCheck,
  type CommandLineInput,
  type SaveResult,
  type WorkflowSummary,
} from "./lib/workflows.ts";
export type { Placeholder } from "../sandbox/index.ts";

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
  /** Sends the writes a stopped run's Apply did not send, and no others. */
  resume(run: string): Promise<ResumeResult>;
  /**
   * Saves a successful Exploration Run of this session as a Workflow, once
   * the developer has confirmed its result.
   */
  saveWorkflow(request: {
    run: string;
    name: string;
    confirmed: boolean;
  }): Promise<SaveResult>;
  /**
   * Runs a saved Workflow, with no LLM: a Plan, then an Apply that runs
   * unattended unless Approval is required. Each run is kept in the run
   * history.
   */
  runWorkflow(
    request: { name: string } & (
      | { input: unknown }
      /** Read against main's input type as the code is now. */
      | { commandLine: CommandLineInput }
    )
  ): Promise<WorkflowRunResult>;
  /** The Drift that deterministic Repair could not settle, by Tool. */
  pendingDrift(): Promise<PendingDrift[]>;
  /**
   * The pending Drift, by Tool, with what an agent needs to propose a
   * Response Adapter for it. Fixture values are redacted.
   */
  repairTasks(): Promise<RepairTask[]>;
  /**
   * Checks ops an agent proposes to add to a Tool's Response Adapter for its
   * pending Drift, as deterministic Repair checks its own, and writes the
   * new Adapter version if they repair it. Like any changed Adapter, it
   * waits for the developer's Approval on the next run of each Workflow
   * that uses the Tool.
   */
  proposeRepair(request: {
    tool: string;
    ops: unknown;
  }): Promise<ProposalResult>;
  close(): Promise<void>;
};

/**
 * Opens a core on a project; `root` is the directory that holds
 * `.workflows/`. `model` stands in for the Repair Model the config names.
 */
export async function openCore(
  config: PinfoldConfig,
  options: { root: string; model?: ModelClient }
): Promise<Core> {
  const project = await openProject(
    config,
    options.root,
    options.model ?? configuredModel(config, process.env)
  );

  // The latest successful Exploration Runs, which save_workflow can save.
  // Kept in memory only, so no unredacted response reaches the disk.
  const explorations = new Map<string, Exploration>();
  const maxExplorations = 20;
  function remember(exploration: Exploration) {
    explorations.set(exploration.run, exploration);
    for (const run of explorations.keys()) {
      if (explorations.size <= maxExplorations) break;
      explorations.delete(run);
    }
  }

  return {
    toolClassifications: () =>
      project.downstream.tools.map((tool) => ({
        server: tool.server,
        tool: tool.tool,
        kind: project.isRead(tool) ? "read" : "write",
        suggestion: tool.readOnlyHint ? "read" : "write",
        classified: project.classificationOf(tool) !== undefined,
      })),
    searchSdk: (query) => searchTools(project.sdkTools(), query),
    async explore({ code, input = {} }) {
      const { key, approved, clock, writes, calls, result, adapters } =
        await planRun(project, code, input);
      if (!result.ok) return { ok: false, error: result.error };
      const tools = [
        ...new Set([...calls, ...writes].map((call) => call.tool)),
      ];
      const plan = writePlan(writes, adapters!.digests(tools));
      const outcome = await planOutcome(project, plan, result.value, {
        key,
        clock,
        approved,
        needsApproval: plan.writes.length > 0,
      });
      if (!outcome.ok) return outcome;
      const run = randomUUID().slice(0, 8);
      remember({
        run,
        code,
        input,
        calls,
        tools,
        reads: result.reads,
        adapters: plan.adapters,
      });
      return { ...outcome, exploration: run };
    },
    runWorkflow: (request) => runWorkflow(project, request),
    pendingDrift: () => project.repairs.pending(),
    repairTasks: () => repairTasks(project),
    proposeRepair: (request) => proposeRepair(project, request),
    resume: (run) => resume(project, run),
    saveWorkflow: ({ run, name, confirmed }) =>
      saveWorkflow(project.root, {
        name,
        run,
        exploration: explorations.get(run),
        confirmed,
        declarations: declarations(project.sdkTools()),
        redact: config.redact ?? {},
      }),
    close: () => project.close(),
  };
}
