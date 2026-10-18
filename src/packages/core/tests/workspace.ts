import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectControl,
  driftKitCommand,
  type ControlClient,
  type DriftKitServerName,
} from "../../drift-kit/index.ts";
import {
  openCore,
  type Core,
  type PinfoldConfig,
  type ServerConfig,
} from "../index.ts";

/** The Sentry server's Tools, all classified as Read Tools. */
export const sentryReads = {
  sentry: {
    listIssues: "read",
    getIssue: "read",
    listIssueEvents: "read",
    listProjects: "read",
  },
} as const;

/** A temporary project directory whose cores talk to Drift Kit servers. */
export type Workspace = {
  dir: string;
  /** A Sentry-shaped Drift Kit server, distinct per name. */
  sentry(name?: string): ServerConfig;
  /** A Linear-shaped Drift Kit server, distinct per name. */
  linear(name?: string): ServerConfig;
  /** The control channel of the server started under that name. */
  control(name: string): ControlClient;
  /**
   * Opens a core on this directory. By default it has one Sentry server
   * whose Tools are all Read Tools.
   */
  open(config?: Partial<PinfoldConfig>): Promise<Core>;
  close(): Promise<void>;
};

export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "pinfold-core-"));
  const cores: Core[] = [];
  const socket = (name: string) => join(dir, `${name}.sock`);
  const server = (kind: DriftKitServerName) => (name: string) =>
    driftKitCommand(kind, { control: socket(name) });
  const sentry = (name = "sentry") => server("sentry")(name);
  return {
    dir,
    sentry,
    linear: (name = "linear") => server("linear")(name),
    control: (name) => connectControl(socket(name)),
    async open(config = {}) {
      const core = await openCore(
        {
          servers: { sentry: sentry() },
          classification: sentryReads,
          ...config,
        },
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
