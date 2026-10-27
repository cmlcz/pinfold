import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectControl,
  driftKitCommand,
  serveDriftKitHttp,
  type ControlClient,
  type DriftKitServerName,
  type HttpDriftKitServer,
} from "../../drift-kit/index.ts";
import {
  openCore,
  type Core,
  type ModelClient,
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
    getProjectTeam: "read",
  },
} as const;

/** A temporary project directory whose cores talk to Drift Kit servers. */
export type Workspace = {
  dir: string;
  /** A Sentry-shaped Drift Kit server, distinct per name. */
  sentry(name?: string): ServerConfig;
  /**
   * A Linear-shaped Drift Kit server, distinct per name, with these Drift
   * Scenarios on from its start.
   */
  linear(name?: string, drift?: readonly string[]): ServerConfig;
  /**
   * Starts a Drift Kit server over Streamable HTTP, distinct per name, that
   * asks for the token when given one. Returns its URL.
   */
  serveHttp(
    kind: DriftKitServerName,
    options?: { name?: string; token?: string }
  ): Promise<string>;
  /** The control channel of the server started under that name. */
  control(name: string): ControlClient;
  /**
   * Opens a core on this directory. By default it has one Sentry server
   * whose Tools are all Read Tools.
   */
  open(
    config?: Partial<PinfoldConfig>,
    options?: { model?: ModelClient }
  ): Promise<Core>;
  close(): Promise<void>;
};

export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "pinfold-core-"));
  const cores: Core[] = [];
  const httpServers: HttpDriftKitServer[] = [];
  const socket = (name: string) => join(dir, `${name}.sock`);
  const server = (kind: DriftKitServerName) => (name: string) =>
    driftKitCommand(kind, { control: socket(name) });
  const sentry = (name = "sentry") => server("sentry")(name);
  return {
    dir,
    sentry,
    linear: (name = "linear", drift = []) =>
      driftKitCommand("linear", { control: socket(name), drift }),
    async serveHttp(kind, { name = kind, token } = {}) {
      const server = await serveDriftKitHttp(kind, {
        control: socket(name),
        ...(token !== undefined && { token }),
      });
      httpServers.push(server);
      return server.url;
    },
    control: (name) => connectControl(socket(name)),
    async open(config = {}, options = {}) {
      const core = await openCore(
        {
          servers: { sentry: sentry() },
          classification: sentryReads,
          ...config,
        },
        { root: dir, ...options }
      );
      cores.push(core);
      return core;
    },
    async close() {
      try {
        await Promise.allSettled(cores.map((core) => core.close()));
        await Promise.allSettled(httpServers.map((server) => server.close()));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
