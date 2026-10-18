import type { McpServer } from "@modelcontextprotocol/server";
import { createLinearServer, createLinearWorld } from "./linear/server.ts";
import { createSentryServer, createSentryWorld } from "./sentry/server.ts";
import type { World } from "./world.ts";

/** Each Drift Kit server, built around a fresh world of seeded state. */
export const servers = {
  sentry: () => serve(createSentryWorld(), createSentryServer),
  linear: () => serve(createLinearWorld(), createLinearServer),
};

export type DriftKitServerName = keyof typeof servers;

function serve<State>(
  world: World<State>,
  create: (world: World<State>) => McpServer
): { world: World<unknown>; server: McpServer } {
  return { world: world as World<unknown>, server: create(world) };
}
