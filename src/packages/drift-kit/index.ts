import { fileURLToPath } from "node:url";

import type { DriftKitServerName } from "./lib/servers.ts";

export type { DriftKitServerName };

/** The command that runs a Drift Kit server as a stdio MCP Downstream Server. */
export function driftKitCommand(
  server: DriftKitServerName,
  options: { control: string; drift?: readonly string[] }
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./bin.ts", import.meta.url)),
      server,
      "--control",
      options.control,
      ...(options.drift ?? []).flatMap((scenario) => ["--drift", scenario]),
    ],
  };
}

export { connectControl, type ControlClient } from "./lib/control.ts";
export {
  /** Runs a Drift Kit server as a Streamable HTTP Downstream Server. */
  serveHttp as serveDriftKitHttp,
  type HttpDriftKitServer,
} from "./lib/http.ts";
export type { ReceivedWrite } from "./lib/world.ts";
export { linearDriftScenarios } from "./lib/linear/server.ts";
export { sentryDriftScenarios } from "./lib/sentry/server.ts";
