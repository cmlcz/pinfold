// The Plan of a run: the agent's or a Workflow's code in the sandbox, with
// Read Tools live and Write Tool calls recorded into a Write Plan.
import { randomInt } from "node:crypto";
import {
  Placeholder,
  PlaceholderError,
  quickJsSandbox,
  type Sdk,
  type SandboxResult,
} from "../../sandbox/index.ts";
import { loadAdapters, type Adapters } from "./adapters.ts";
import { toolName } from "./baselines.ts";
import type { DownstreamTool } from "./downstream.ts";
import { mismatches, touchesContract, type Mismatch } from "./drift.ts";
import {
  canonicalize,
  containsPlaceholder,
  shortHash,
  type PlannedWrite,
} from "./plan.ts";
import type { Project } from "./project.ts";
import type { JsonSchema } from "./schema.ts";
import { declarations } from "./sdk.ts";
import type { RecordedCall } from "./workflows.ts";

/** A Read Tool call as its Downstream Server answered it. */
export type LiveCall = { arguments: unknown; response: unknown };

/**
 * Drift that stopped a Workflow Run: the Tool, as `server.tool`, where its
 * response drifted from its Baseline, and its calls in the run so far.
 */
export type Drift = {
  tool: string;
  offered: DownstreamTool;
  baseline: JsonSchema;
  mismatches: Mismatch[];
  responses: LiveCall[];
};

// During a Plan, Read Tools run live, their responses mapped by their
// Response Adapters, and Write Tool calls are recorded. Read Tool calls are
// kept with their adapted responses, as Fixtures. `check` sees each call as
// the server answered it and its adapted response first, and may stop the
// call.
function planSdk(
  project: Project,
  writes: PlannedWrite[],
  calls: RecordedCall[],
  adapters: Adapters,
  check?: (tool: DownstreamTool, live: LiveCall, response: unknown) => void
): Sdk {
  // No prototype, so a server named like an Object member is just a name.
  const sdk: Sdk = Object.create(null);
  for (const tool of project.downstream.tools) {
    const name = toolName(tool);
    if (!Object.hasOwn(sdk, tool.server))
      sdk[tool.server] = Object.create(null);
    sdk[tool.server]![tool.tool] = project.isRead(tool)
      ? async (args) => {
          if (containsPlaceholder(args)) {
            throw new PlaceholderError(
              `a Placeholder cannot be passed to the Read Tool ${name}`
            );
          }
          const live = { arguments: args, response: await tool.call(args) };
          const value = adapters.adapt(name, live.response);
          check?.(tool, live, value);
          calls.push({ tool: name, arguments: args, response: value });
          await project.baselines.record(tool, value);
          return value;
        }
      : async (args) => {
          writes.push({ tool: name, arguments: canonicalize(args) });
          return new Placeholder(writes.length);
        };
  }
  return sdk;
}

/**
 * Runs code as a Plan. A run after Approval sees the clock the approved run
 * saw, so a plan built from the time or Math.random is rebuilt as it was
 * approved. Given a Contract, the run stops at the first response whose
 * Drift touches it, and fails even if the program catches that.
 */
export async function planRun(
  project: Project,
  code: string,
  input: unknown,
  contract?: Record<string, string[]>
) {
  const { baselines } = project;
  const key = runKey(code, input);
  const approved = await project.plans.approvedFor(key);
  const clock = approved?.clock ?? {
    now: Date.now(),
    seed: randomInt(2 ** 32),
  };
  const writes: PlannedWrite[] = [];
  const calls: RecordedCall[] = [];
  const drift: Drift[] = [];
  // The checked calls of each Tool, and the Tools whose responses all fit
  // their Baselines.
  const checked = new Map<string, LiveCall[]>();
  const fitting = new Set<string>();
  const check = (tool: DownstreamTool, live: LiveCall, response: unknown) => {
    const name = toolName(tool);
    const baseline = baselines.get(tool.server, tool.tool);
    if (contract === undefined || baseline === undefined) return;
    const responses = [...(checked.get(name) ?? []), live];
    checked.set(name, responses);
    const found = mismatches(baseline.outputSchema, response);
    if (found.length === 0) fitting.add(name);
    if (!touchesContract(found, contract, name)) return;
    drift.push({
      tool: name,
      offered: tool,
      baseline: baseline.outputSchema,
      mismatches: found,
      responses,
    });
    throw new Error(`${name} drifted from its Baseline`);
  };
  const loaded = await loadAdapters(project.root).catch(
    (error: unknown) => error as Error
  );
  const result: SandboxResult =
    loaded instanceof Error
      ? { ok: false, error: loaded.message }
      : await quickJsSandbox.run({
          source: code,
          declarations: declarations(project.sdkTools()),
          input,
          sdk: planSdk(project, writes, calls, loaded, check),
          limits: project.limits,
          clock,
        });
  const adapters = loaded instanceof Error ? undefined : loaded;
  return {
    key,
    approved,
    clock,
    writes,
    calls,
    result,
    adapters,
    drift: drift[0],
    fitting,
  };
}

// The same code and input give the same run key, whatever the order of the
// input's fields.
function runKey(code: string, input: unknown): string {
  return shortHash(JSON.stringify([code, canonicalize(input)]));
}
