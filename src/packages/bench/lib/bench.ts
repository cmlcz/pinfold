// Drift Kit servers for the benchmark, reset to their seeds before each run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCore, type Core, type PinfoldConfig } from "../../core/index.ts";
import {
  connectControl,
  serveDriftKitHttp,
  type ControlClient,
  type DriftKitServerName,
  type HttpDriftKitServer,
} from "../../drift-kit/index.ts";
import type { Outcome } from "./state.ts";
import { benchClassification } from "./tasks.ts";

export const serverNames = ["sentry", "linear", "github"] as const;

/** Drift Kit servers over HTTP, reset to their seeds for each run. */
export type Bench = {
  config: PinfoldConfig;
  controls: Record<(typeof serverNames)[number], ControlClient>;
  /**
   * Restores every server's seed and turns its Drift Scenarios off, except
   * those kept on.
   */
  reset(): Promise<void>;
  /** Turns a Drift Scenario on, and keeps it on across resets. */
  keepDrift(server: DriftKitServerName, scenario: string): Promise<void>;
  /** Stops keeping Drift Scenarios on, and resets every server. */
  dropDrift(): Promise<void>;
  /** Resets every server and opens a core on a fresh project. */
  fresh(): Promise<{ core: Core; root: string }>;
  outcome(value: unknown): Promise<Outcome>;
  close(): Promise<void>;
};

export async function startBench(): Promise<Bench> {
  const dir = await mkdtemp(join(tmpdir(), "pinfold-h2-"));
  const servers: HttpDriftKitServer[] = [];
  for (const name of serverNames) {
    servers.push(
      await serveDriftKitHttp(name, { control: join(dir, `${name}.sock`) })
    );
  }
  const controls = Object.fromEntries(
    serverNames.map((name) => [name, connectControl(join(dir, `${name}.sock`))])
  ) as Bench["controls"];
  const config: PinfoldConfig = {
    servers: Object.fromEntries(
      serverNames.map((name, index) => [name, { url: servers[index]!.url }])
    ),
    classification: benchClassification,
  };
  const cores: Core[] = [];
  const kept: { server: DriftKitServerName; scenario: string }[] = [];
  const reset = async () => {
    await Promise.all(serverNames.map((name) => controls[name].reset()));
    for (const { server, scenario } of kept) {
      await controls[server as (typeof serverNames)[number]].startDrift(
        scenario
      );
    }
  };
  return {
    config,
    controls,
    reset,
    async dropDrift() {
      kept.length = 0;
      await reset();
    },
    async keepDrift(server, scenario) {
      kept.push({ server, scenario });
      await controls[server as (typeof serverNames)[number]].startDrift(
        scenario
      );
    },
    async fresh() {
      await reset();
      const root = await mkdtemp(join(dir, "run-"));
      const core = await openCore(config, { root });
      cores.push(core);
      return { core, root };
    },
    async outcome(value) {
      const writes = Object.fromEntries(
        await Promise.all(
          serverNames.map(
            async (name) =>
              [name, await controls[name].receivedWrites()] as const
          )
        )
      );
      const state = Object.fromEntries(
        await Promise.all(
          serverNames.map(async (name) => [name, await controls[name].state()])
        )
      ) as Outcome["state"];
      return { value, writes, state };
    },
    async close() {
      await Promise.allSettled(cores.map((core) => core.close()));
      await Promise.allSettled(servers.map((server) => server.close()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
