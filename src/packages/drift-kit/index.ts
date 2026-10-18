import { fileURLToPath } from "node:url";

export type DriftKitServerName = "sentry";

/** The command that runs a Drift Kit server as a stdio MCP Downstream Server. */
export function driftKitCommand(
  server: DriftKitServerName,
  options: { control: string }
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./bin.ts", import.meta.url)),
      server,
      "--control",
      options.control,
    ],
  };
}

export { connectControl, type ControlClient } from "./lib/control.ts";
export type { ReceivedWrite } from "./lib/world.ts";
