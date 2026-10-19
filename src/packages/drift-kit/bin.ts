// Runs a Drift Kit server over stdio: `node bin.ts <server> --control <path>`.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serveControl } from "./lib/control.ts";
import { servers } from "./lib/servers.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { control: { type: "string" } },
});

const name = positionals[0];
if (name === undefined || !(name in servers) || values.control === undefined) {
  console.error(
    `usage: bin.ts <${Object.keys(servers).join("|")}> --control <socket path>`
  );
  process.exit(2);
}

const { world, server } = servers[name as keyof typeof servers]();
// Listen before the MCP handshake, so the channel is up once a client connects.
const control = await serveControl(values.control, world);
const transport = new StdioServerTransport();
transport.onclose = () => control.close();
await server.connect(transport);
