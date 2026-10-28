// What an agent Arm gives its agent: MCP servers over HTTP, and for A3 a
// saved program and the instruction line that points to it. Any driver,
// the minimal loop or a real CLI, connects to the same surface.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { openPlans } from "../../core/index.ts";
import { serveMcpHttp } from "../../drift-kit/index.ts";
import { createGateway } from "../../gateway/index.ts";
import type { Bench } from "./bench.ts";
import type { Task } from "./tasks.ts";

export type AgentArm = "A1" | "A2" | "A3";

export type Surface = {
  /** The MCP servers the agent has, by name, as Streamable HTTP URLs. */
  servers: Record<string, string>;
  /** Files for the agent's working directory, by relative path. */
  files: Record<string, string>;
  /** Lines for the instruction file the agent's client reads. */
  instructions: string | undefined;
  /** Write Plans approved on the developer's behalf so far. */
  approvals(): number;
  /** Time spent approving, to leave out of the wall time. */
  pausedMs(): number;
  close(): Promise<void>;
};

/**
 * A1 gets the Drift Kit servers themselves, with every Tool loaded. A2 and
 * A3 get pinfold's Gateway, behind a proxy that approves each Write Plan
 * the moment it waits, as a developer would, and makes the same call again:
 * the agent sees only the applied result. A3 also gets the task's program,
 * saved, and one line telling it to reuse that.
 */
export async function openSurface(
  bench: Bench,
  arm: AgentArm,
  task: Task
): Promise<Surface> {
  if (arm === "A1") {
    await bench.reset();
    return {
      servers: Object.fromEntries(
        Object.entries(bench.config.servers).map(([name, server]) => [
          name,
          (server as { url: string }).url,
        ])
      ),
      files: {},
      instructions: undefined,
      approvals: () => 0,
      pausedMs: () => 0,
      close: async () => {},
    };
  }
  const { core, root } = await bench.fresh();
  const { server } = createGateway(core, { root });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const gateway = new Client({ name: "pinfold-bench", version: "0.0.0" });
  await gateway.connect(clientEnd);
  const { tools } = await gateway.listTools();
  let approvals = 0;
  let pausedMs = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await gateway.callTool({ name, arguments: args });
    if (name !== "run_sandbox") return result;
    const paused = Date.now();
    const pending = await openPlans(root).pending();
    if (pending.length === 0) return result;
    for (const plan of pending) await openPlans(root).approve(plan.id);
    approvals += pending.length;
    pausedMs += Date.now() - paused;
    return gateway.callTool({ name, arguments: args });
  };
  const proxy = await serveMcpHttp(() => {
    const proxied = new Server(
      { name: "pinfold", version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    proxied.setRequestHandler("tools/list", () => ({ tools }));
    proxied.setRequestHandler("tools/call", (request) =>
      call(request.params.name, request.params.arguments ?? {})
    );
    return proxied;
  });
  const skill = `skills/${task.name}.ts`;
  return {
    servers: { pinfold: proxy.url },
    files: arm === "A3" ? { [skill]: task.program } : {},
    instructions:
      arm === "A3"
        ? `\`${skill}\` is a saved program for the task you will be given: run it with run_sandbox, passing the task's values as its \`input\`, instead of writing a new program.`
        : undefined,
    approvals: () => approvals,
    pausedMs: () => pausedMs,
    async close() {
      await proxy.close();
      await gateway.close();
    },
  };
}
