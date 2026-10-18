// MCP client sessions to the configured Downstream Servers.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerConfig } from "./config.ts";

export type DownstreamTool = {
  server: string;
  name: string;
  call(args: unknown): Promise<unknown>;
};

export type Downstream = {
  tools: DownstreamTool[];
  close(): Promise<void>;
};

export async function connectDownstream(
  servers: Record<string, ServerConfig>
): Promise<Downstream> {
  const sessions = await Promise.allSettled(
    Object.entries(servers).map(([name, config]) => connect(name, config))
  );
  const connected = sessions.flatMap((s) =>
    s.status === "fulfilled" ? [s.value] : []
  );
  const close = async () => {
    await Promise.all(connected.map(({ client }) => client.close()));
  };
  const failures = sessions.flatMap((s) =>
    s.status === "rejected" ? [s.reason as Error] : []
  );
  if (failures.length > 0) {
    await close();
    throw new Error(failures.map((error) => error.message).join("\n"));
  }
  return { tools: connected.flatMap(({ tools }) => tools), close };
}

async function connect(server: string, config: ServerConfig) {
  const client = new Client({ name: "pinfold", version: "0.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
      })
    );
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      client,
      tools: tools.map((tool): DownstreamTool => ({
        server,
        name: tool.name,
        call: (args) => callTool(client, server, tool.name, args),
      })),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(
      `Downstream Server "${server}" could not be started: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

async function callTool(
  client: Client,
  server: string,
  name: string,
  args: unknown
): Promise<unknown> {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  if (result.isError) throw new Error(`${server}.${name} failed: ${text}`);
  return result.structuredContent ?? text;
}
