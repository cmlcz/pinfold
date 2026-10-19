// The pinfold CLI:
//   node bin.ts classify [read|write <server.tool>...] [--config pinfold.json]
//   node bin.ts plans [--config pinfold.json]
//   node bin.ts approve|decline <plan-id> [--config pinfold.json]
//   node bin.ts resume <run-id> [--config pinfold.json]
//   node bin.ts list [--config pinfold.json]
//   node bin.ts run <workflow> [--<input> <value>...] [--config pinfold.json]
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  classifyTools,
  formatPlan,
  formatResume,
  formatWorkflowRun,
  formatWorkflows,
  inputFromFlags,
  listWorkflows,
  loadConfig,
  openCore,
  openPlans,
  type Core,
  type ToolKind,
} from "../core/index.ts";

const usage = `usage:
  pinfold classify [read|write <server.tool>...] [--config <path>]
  pinfold plans [--config <path>]
  pinfold approve|decline <plan-id> [--config <path>]
  pinfold resume <run-id> [--config <path>]
  pinfold list [--config <path>]
  pinfold run <workflow> [--<input> <value>...] [--config <path>]

pinfold run exits with 3 when the run pauses for Approval.`;

// A Workflow Run that pauses for Approval exits with this code, so that cron
// or CI can tell it from a failure.
const pausedExitCode = 3;

// \`run\` takes the Workflow's input as flags of its own, so they are set
// aside before the options are parsed.
const args = process.argv.slice(2);
const [options, inputFlags] =
  args[0] === "run" ? splitRunFlags(args) : [args, {}];

const { positionals, values } = parseArgs({
  args: options,
  allowPositionals: true,
  options: { config: { type: "string", default: "pinfold.json" } },
});
const [command, ...rest] = positionals;
const root = dirname(resolve(values.config));

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

async function main(): Promise<number> {
  switch (command) {
    case "classify":
      return classify(rest);
    case "plans": {
      const plans = openPlans(root);
      for (const file of await plans.unreadable()) {
        console.error(`Skipped unreadable Write Plan file ${file}`);
      }
      const pending = await plans.pending();
      if (pending.length === 0) console.log("No pending Write Plans.");
      for (const plan of pending) console.log(formatPlan(plan));
      return 0;
    }
    case "approve": {
      const [id] = rest;
      if (id === undefined || rest.length > 1) return fail();
      const plans = openPlans(root);
      const plan = await plans.approve(id);
      console.log(formatPlan(plan));
      console.log(
        `Approved Write Plan ${id}. It is sent when the same code runs again and rebuilds the same plan.`
      );
      return 0;
    }
    case "decline": {
      const [id] = rest;
      if (id === undefined || rest.length > 1) return fail();
      const plans = openPlans(root);
      const { previous } = await plans.decline(id);
      if (previous === "applying") {
        console.log(
          `Declined Write Plan ${id}. A run applying it stops before its next write, and no run sends it again; writes already sent stay sent.`
        );
      } else {
        console.log(`Declined Write Plan ${id}. It will never be sent.`);
      }
      return 0;
    }
    case "resume": {
      const [run] = rest;
      if (run === undefined || rest.length > 1) return fail();
      return withCore(await openProjectCore(), async (core) => {
        console.log(formatResume(await core.resume(run)));
        return 0;
      });
    }
    case "list":
      if (rest.length > 0) return fail();
      console.log(formatWorkflows(await listWorkflows(root)));
      return 0;
    case "run": {
      const [name] = rest;
      if (name === undefined || rest.length > 1) return fail();
      return withCore(await openProjectCore(), async (core) => {
        const saved = (await listWorkflows(root)).find(
          (workflow) => workflow.name === name
        );
        const input = inputFromFlags(saved?.input ?? {}, inputFlags);
        const result = await core.runWorkflow({ name, input });
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(formatWorkflowRun(result));
        switch (result.status) {
          case "pending":
          case "changed":
            return pausedExitCode;
          case "declined":
            return 1;
          default:
            return 0;
        }
      });
    }
    default:
      return fail();
  }
}

// Splits `run`'s arguments into the CLI's own, the command, the Workflow
// and --config, and the input flags: `--name value`, `--name=value`, or a
// bare `--name` for true.
function splitRunFlags(
  args: string[]
): [string[], Record<string, string | true>] {
  const own: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      own.push(arg);
      continue;
    }
    const [name, inline] = splitOnce(arg.slice(2), "=");
    if (name === "config") {
      own.push(arg);
      if (inline === undefined && index + 1 < args.length) {
        own.push(args[++index]!);
      }
      continue;
    }
    const next = args[index + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index++;
    } else flags[name] = true;
  }
  return [own, flags];
}

function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + 1)];
}

async function classify([kind, ...names]: string[]): Promise<number> {
  if (kind !== undefined && kind !== "read" && kind !== "write") return fail();
  if (kind !== undefined && names.length === 0) return fail();
  const choice = kind as ToolKind | undefined;

  return withCore(await openProjectCore(), async (core) => {
    if (choice === undefined) return show(core);
    const tools = core.toolClassifications();
    const choices = [];
    for (const name of names) {
      const match = tools.find(
        (tool) => `${tool.server}.${tool.tool}` === name
      );
      if (match === undefined) {
        console.error(`no Downstream Server offers ${name}`);
        return 1;
      }
      choices.push({ server: match.server, tool: match.tool, kind: choice });
    }
    await classifyTools(values.config, choices);
    return withCore(await openProjectCore(), show);
  });
}

function fail(): number {
  console.error(usage);
  return 2;
}

async function openProjectCore(): Promise<Core> {
  return openCore(await loadConfig(values.config), { root });
}

async function withCore(
  core: Core,
  use: (core: Core) => Promise<number> | number
): Promise<number> {
  try {
    return await use(core);
  } finally {
    await core.close();
  }
}

function show(core: Core): number {
  const rows = core
    .toolClassifications()
    .map((tool) => [
      `${tool.server}.${tool.tool}`,
      tool.kind,
      tool.suggestion,
      tool.classified ? "" : "new",
    ]);
  const table = [["Tool", "Kind", "Suggested", ""], ...rows];
  const width = Math.max(...table.map(([name]) => name!.length));
  for (const [name, toolKind, suggestion, status] of table) {
    console.log(
      `${name!.padEnd(width)}  ${toolKind!.padEnd(5)}  ${suggestion!.padEnd(9)}  ${status}`.trimEnd()
    );
  }
  return 0;
}
