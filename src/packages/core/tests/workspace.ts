import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driftKitCommand } from "../../drift-kit/index.ts";
import {
  openCore,
  type Core,
  type PinfoldConfig,
  type ServerConfig,
} from "../index.ts";

/** A temporary project directory whose cores talk to Drift Kit servers. */
export type Workspace = {
  dir: string;
  /** A Sentry-shaped Drift Kit server, distinct per name. */
  sentry(name?: string): ServerConfig;
  /** Opens a core on this directory; servers default to one Sentry server. */
  open(config?: Partial<PinfoldConfig>): Promise<Core>;
  close(): Promise<void>;
};

export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "pinfold-core-"));
  const cores: Core[] = [];
  const sentry = (name = "sentry") =>
    driftKitCommand("sentry", { control: join(dir, `${name}.sock`) });
  return {
    dir,
    sentry,
    async open(config = {}) {
      const core = await openCore(
        { servers: { sentry: sentry() }, ...config },
        { root: dir }
      );
      cores.push(core);
      return core;
    },
    async close() {
      await Promise.all(cores.map((core) => core.close()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
