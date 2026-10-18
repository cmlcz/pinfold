// Runs the Gateway over stdio: `node bin.ts [--config pinfold.json]`.
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig, openCore } from "../core/index.ts";
import { createGateway } from "./index.ts";

const { values } = parseArgs({
  options: { config: { type: "string", default: "pinfold.json" } },
});

const core = await openCore(await loadConfig(values.config), {
  root: dirname(resolve(values.config)),
});
const transport = new StdioServerTransport();
transport.onclose = () => void core.close();
await createGateway(core).connect(transport);
