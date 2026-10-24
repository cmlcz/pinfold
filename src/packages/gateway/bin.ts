// Runs the Gateway over stdio: `node bin.ts [--config pinfold.json]`.
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig, openCore, type Core } from "../core/index.ts";
import { createGateway } from "./index.ts";

const { values } = parseArgs({
  options: { config: { type: "string", default: "pinfold.json" } },
});

const root = dirname(resolve(values.config));
let core: Core;
try {
  core = await openCore(await loadConfig(values.config), { root });
} catch (error) {
  // A configuration error, said in a line rather than a stack trace.
  console.error(`pinfold: ${(error as Error).message}`);
  process.exit(1);
}
const transport = new StdioServerTransport();
transport.onclose = () => void core.close();
await createGateway(core, { root }).connect(transport);
