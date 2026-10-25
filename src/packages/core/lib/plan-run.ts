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
import {
  mismatches,
  touching,
  uniqueMismatches,
  type Mismatch,
} from "./drift.ts";
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
 * responses drifted from its Baseline, its calls in the run, and the fields
 * the run read of it.
 */
export type Drift = {
  tool: string;
  offered: DownstreamTool;
  baseline: JsonSchema;
  mismatches: Mismatch[];
  responses: LiveCall[];
  reads: string[];
};

/** A Read Tool call of a run. */
export type Observed = {
  tool: DownstreamTool;
  /** The call as its Downstream Server answered it. */
  live: LiveCall;
  /** The response through the Tool's Response Adapter. */
  response: unknown;
  /**
   * Where that response does not fit the Baseline the Tool had at the call;
   * none for a Tool not pinned yet.
   */
  mismatches: Mismatch[];
};

// During a Plan, Read Tools run live, their responses mapped by their
// Response Adapters, and Write Tool calls are recorded. Read Tool calls are
// kept with their adapted responses, as Fixtures, and observed with how
// they fit their Baselines.
function planSdk(
  project: Project,
  writes: PlannedWrite[],
  calls: RecordedCall[],
  observed: Observed[],
  adapters: Adapters
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
          const baseline = project.baselines.get(tool.server, tool.tool);
          observed.push({
            tool,
            live,
            response: value,
            mismatches: baseline
              ? mismatches(baseline.outputSchema, value)
              : [],
          });
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
 * approved.
 */
export async function planRun(project: Project, code: string, input: unknown) {
  const key = runKey(code, input);
  const approved = await project.plans.approvedFor(key);
  const clock = approved?.clock ?? {
    now: Date.now(),
    seed: randomInt(2 ** 32),
  };
  const writes: PlannedWrite[] = [];
  const calls: RecordedCall[] = [];
  const observed: Observed[] = [];
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
          sdk: planSdk(project, writes, calls, observed, loaded),
          limits: project.limits,
          clock,
        });
  const adapters = loaded instanceof Error ? undefined : loaded;
  return { key, approved, clock, writes, calls, observed, result, adapters };
}

/**
 * The first Tool, in the order of the calls, whose responses drifted from
 * its Baseline where the run read them. Fields the run did not read do not
 * matter to it, so Drift there is no Drift of the run.
 */
export function findDrift(
  project: Project,
  observed: Observed[],
  /** The fields the run read, by Tool, as a Contract writes them. */
  reads: Record<string, string[]>
): Drift | undefined {
  for (const name of new Set(observed.map(({ tool }) => toolName(tool)))) {
    const calls = observed.filter(({ tool }) => toolName(tool) === name);
    const found = uniqueMismatches(calls.flatMap((call) => call.mismatches));
    const read = Object.hasOwn(reads, name) ? reads[name]! : [];
    if (touching(found, read).length === 0) continue;
    const offered = calls[0]!.tool;
    return {
      tool: name,
      offered,
      // A call with mismatches had a Baseline.
      baseline: project.baselines.get(offered.server, offered.tool)!
        .outputSchema,
      mismatches: found,
      responses: calls.map((call) => call.live),
      reads: read,
    };
  }
  return undefined;
}

// The same code and input give the same run key, whatever the order of the
// input's fields.
function runKey(code: string, input: unknown): string {
  return shortHash(JSON.stringify([code, canonicalize(input)]));
}
