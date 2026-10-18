// The pinfold CLI:
//   node bin.ts classify [--config pinfold.json]
//   node bin.ts classify read|write <server.tool>... [--config pinfold.json]
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  classifyTools,
  loadConfig,
  openCore,
  type Core,
  type ToolKind,
} from "../core/index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: "string", default: "pinfold.json" } },
});
const [command, kind, ...names] = positionals;

if (
  command !== "classify" ||
  (kind !== undefined && kind !== "read" && kind !== "write") ||
  (kind !== undefined && names.length === 0)
) {
  console.error(
    "usage: pinfold classify [read|write <server.tool>...] [--config <path>]"
  );
  process.exit(2);
}
const choice = kind as ToolKind | undefined;

const open = async () =>
  openCore(await loadConfig(values.config), {
    root: dirname(resolve(values.config)),
  });

process.exitCode = await withCore(await open(), async (core) => {
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
