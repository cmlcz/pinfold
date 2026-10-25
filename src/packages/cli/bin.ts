// The pinfold CLI:
//   node bin.ts classify [read|write <server.tool>...] [--config pinfold.json]
//   node bin.ts plans [--config pinfold.json]
//   node bin.ts approve|decline <plan-id> [--config pinfold.json]
//   node bin.ts resume <run-id> [--config pinfold.json]
//   node bin.ts resolve <run-id> <write> sent|not-sent [--config pinfold.json]
//   node bin.ts list [--config pinfold.json]
//   node bin.ts run <workflow> [<value> | --<field> <value>...] [--config pinfold.json]
import { dirname, resolve } from "node:path";
import {
  classifyTools,
  formatResume,
  formatWorkflowRun,
  formatWorkflows,
  listWorkflows,
  loadConfig,
  openCore,
  openPlans,
  reviewPlan,
  type CommandLineInput,
  type Core,
  type ToolKind,
} from "../core/index.ts";

const usage = `usage:
  pinfold classify [read|write <server.tool>...] [--config <path>]
  pinfold plans [--config <path>]
  pinfold approve|decline <plan-id> [--config <path>]
  pinfold resume <run-id> [--config <path>]
  pinfold resolve <run-id> <write> sent|not-sent [--config <path>]
  pinfold list [--config <path>]
  pinfold run <workflow> [<value> | --<field> <value>...] [--config <path>]

pinfold run takes one value for a Workflow whose input is not an object, or
else a flag per input field; a value starting with -- is given as
--<field>=<value>. It exits with 3 when the run pauses for Approval.

pinfold resolve records whether a write that an Apply stopped while sending
reached its server. Check the server first, and only once no Apply is
sending the write.`;

// A Workflow Run that pauses for Approval exits with this code, so that cron
// or CI can tell it from a failure.
const pausedExitCode = 3;

let parsed: ReturnType<typeof parseCommandLine>;
try {
  parsed = parseCommandLine(process.argv.slice(2));
} catch (error) {
  console.error(`${(error as Error).message}\n${usage}`);
  process.exit(2);
}
const { positionals, config, input } = parsed;
const [command, ...rest] = positionals;
const root = dirname(resolve(config));

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
      for (const plan of pending) console.log(await reviewPlan(root, plan));
      return 0;
    }
    case "approve": {
      const [id] = rest;
      if (id === undefined || rest.length > 1) return fail();
      const plans = openPlans(root);
      const plan = await plans.approve(id);
      console.log(await reviewPlan(root, plan));
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
        console.log(
          `Declined Write Plan ${id}. It will never be sent; a later run that builds the same plan asks for Approval again.`
        );
      }
      return 0;
    }
    case "resume": {
      const [run] = rest;
      if (run === undefined || rest.length > 1) return fail();
      return withProjectCore(async (core) => {
        console.log(formatResume(await core.resume(run)));
        return 0;
      });
    }
    case "resolve": {
      const [run, write, outcome] = rest;
      if (run === undefined || rest.length !== 3) return fail();
      if (!/^[1-9]\d*$/.test(write!)) return fail();
      if (outcome !== "sent" && outcome !== "not-sent") return fail();
      await openPlans(root).resolve(run, Number(write), outcome === "sent");
      console.log(
        outcome === "sent"
          ? `Recorded write ${write} of run ${run} as sent; no resume sends it. \`pinfold resume ${run}\` sends the writes after it.`
          : `Recorded write ${write} of run ${run} as not sent. \`pinfold resume ${run}\` sends it and the writes after it.`
      );
      return 0;
    }
    case "list":
      if (rest.length > 0) return fail();
      console.log(formatWorkflows(await listWorkflows(root)));
      return 0;
    case "run": {
      // One value or flags, not both.
      const [name] = rest;
      const flagged = Object.keys(input.flags).length > 0;
      if (name === undefined || rest.length > 2) return fail();
      if (input.value !== undefined && flagged) return fail();
      return withProjectCore(async (core) => {
        const result = await core.runWorkflow({ name, commandLine: input });
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(formatWorkflowRun(result));
        switch (result.status) {
          case "pending":
          case "changed":
            return pausedExitCode;
          default:
            return 0;
        }
      });
    }
    default:
      return fail();
  }
}

// Throws on arguments that make no sense. Only `run` takes options other
// than --config: the Workflow's input, one flag per field, or one value.
function parseCommandLine(args: string[]): {
  positionals: string[];
  config: string;
  input: CommandLineInput;
} {
  const positionals: string[] = [];
  let config = "pinfold.json";
  const flags: Record<string, string | true> = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // A negative number is a value, not an option.
    if (!arg.startsWith("-") || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      throw new Error(`unknown option ${arg}`);
    }
    const [name, inline] = splitOnce(arg.slice(2), "=");
    let value: string | true = inline ?? true;
    const next = args[index + 1];
    if (inline === undefined && next !== undefined && !next.startsWith("--")) {
      value = next;
      index++;
    }
    if (name === "config") {
      if (value === true) throw new Error("--config needs a path");
      config = value;
    } else if (Object.hasOwn(flags, name)) {
      throw new Error(`--${name} is given more than once`);
    } else {
      flags[name] = value;
    }
  }
  const [command, , value] = positionals;
  const [flag] = Object.keys(flags);
  if (command !== "run" && flag !== undefined) {
    throw new Error(`unknown option --${flag}`);
  }
  const input: CommandLineInput = { flags };
  if (command === "run" && value !== undefined) input.value = value;
  return { positionals, config, input };
}

function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + 1)];
}

async function classify([kind, ...names]: string[]): Promise<number> {
  if (kind !== undefined && kind !== "read" && kind !== "write") return fail();
  if (kind !== undefined && names.length === 0) return fail();
  const choice = kind as ToolKind | undefined;

  if (choice === undefined) return withProjectCore(show);
  const tools = await withProjectCore((core) => core.toolClassifications());
  const choices = [];
  for (const name of names) {
    const match = tools.find((tool) => `${tool.server}.${tool.tool}` === name);
    if (match === undefined) {
      console.error(`no Downstream Server offers ${name}`);
      return 1;
    }
    choices.push({ server: match.server, tool: match.tool, kind: choice });
  }
  await classifyTools(config, choices);
  // Opened once the first core has closed: its servers are started afresh.
  return withProjectCore(show);
}

function fail(): number {
  console.error(usage);
  return 2;
}

// Opens a core on the project for one use, and closes it after.
async function withProjectCore<T>(
  use: (core: Core) => Promise<T> | T
): Promise<T> {
  const core = await openCore(await loadConfig(config), { root });
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
