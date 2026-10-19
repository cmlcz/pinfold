import { createLinearServer, createLinearWorld } from "./linear/server.ts";
import { createSentryServer, createSentryWorld } from "./sentry/server.ts";

/** Each Drift Kit server, built around a fresh world of seeded state. */
export const servers = {
  sentry: () => {
    const world = createSentryWorld();
    return { world, server: createSentryServer(world) };
  },
  linear: () => {
    const world = createLinearWorld();
    return { world, server: createLinearServer(world) };
  },
};

export type DriftKitServerName = keyof typeof servers;
