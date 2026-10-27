// Runs a Drift Kit server over stdio:
//   node bin.ts <server> --control <path> [--drift <scenario>...]
// A scenario given at startup is on from the first listing of the Tools.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serveControl } from "./lib/control.ts";
import { servers } from "./lib/servers.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    control: { type: "string" },
    drift: { type: "string", multiple: true },
  },
});

const name = positionals[0];
if (
  name === undefined ||
  !Object.hasOwn(servers, name) ||
  values.control === undefined
) {
  console.error(
    `usage: bin.ts <${Object.keys(servers).join("|")}> --control <socket path>`
  );
  process.exit(2);
}

const { world, server } = servers[name as keyof typeof servers]();
for (const scenario of values.drift ?? []) {
  if (!world.setDrift(scenario, true)) {
    console.error(`no Drift Scenario ${scenario} on the ${name} server`);
    process.exit(2);
  }
}
// Listen before the MCP handshake, so the channel is up once a client connects.
const control = await serveControl(values.control, world);
const transport = new StdioServerTransport();
transport.onclose = () => control.close();
await server().connect(transport);
