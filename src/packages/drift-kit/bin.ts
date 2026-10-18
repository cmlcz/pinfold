// Runs a Drift Kit server over stdio: `node bin.ts sentry --control <path>`.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serveControl } from "./lib/control.ts";
import { createSentryServer, createSentryWorld } from "./lib/sentry/server.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { control: { type: "string" } },
});

if (positionals[0] !== "sentry" || values.control === undefined) {
  console.error("usage: bin.ts sentry --control <socket path>");
  process.exit(2);
}

const world = createSentryWorld();
// Listen before the MCP handshake, so the channel is up once a client connects.
const control = await serveControl(values.control, world);
const transport = new StdioServerTransport();
transport.onclose = () => control.close();
await createSentryServer(world).connect(transport);
