// The pinfold CLI:
//   node bin.ts classify [read|write <server.tool>...] [--config pinfold.json]
//   node bin.ts plans [--config pinfold.json]
//   node bin.ts approve|decline <plan-id> [--config pinfold.json]
//   node bin.ts resume <run-id> [--config pinfold.json]
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  classifyTools,
  formatPlan,
  formatResume,
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
  pinfold resume <run-id> [--config <path>]`;

const { positionals, values } = parseArgs({
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
    case "approve":
    case "decline": {
      const [id] = rest;
      if (id === undefined || rest.length > 1) return fail();
      const plans = openPlans(root);
      if (command === "approve") {
        const plan = await plans.approve(id);
        console.log(formatPlan(plan));
        console.log(
          `Approved Write Plan ${id}. It is sent when the same code runs again and rebuilds the same plan.`
        );
      } else {
        const { previous } = await plans.decline(id);
        console.log(
          previous === "applying"
            ? `Declined Write Plan ${id}. No run will send it again; writes a stopped run already sent stay sent.`
            : `Declined Write Plan ${id}. It will never be sent.`
        );
      }
      return 0;
    }
    case "resume": {
      const [run] = rest;
      if (run === undefined || rest.length > 1) return fail();
      const core = await openCore(await loadConfig(values.config), { root });
      return withCore(core, async () => {
        console.log(formatResume(await core.resume(run)));
        return 0;
      });
    }
    default:
      return fail();
  }
}

async function classify([kind, ...names]: string[]): Promise<number> {
  if (kind !== undefined && kind !== "read" && kind !== "write") return fail();
  if (kind !== undefined && names.length === 0) return fail();
  const choice = kind as ToolKind | undefined;
  const open = async () => openCore(await loadConfig(values.config), { root });

  return withCore(await open(), async (core) => {
    if (choice === undefined) return show(core);
    const tools = core.toolClassifications();
    const choices = [];
    for (const name of names) {
      const tool = tools.find((t) => `${t.server}.${t.tool}` === name);
      if (tool === undefined) {
        console.error(`no Downstream Server offers ${name}`);
        return 1;
      }
      choices.push({ server: tool.server, tool: tool.tool, kind: choice });
    }
    await classifyTools(values.config, choices);
    return withCore(await open(), show);
  });
}

function fail(): number {
  console.error(usage);
  return 2;
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
