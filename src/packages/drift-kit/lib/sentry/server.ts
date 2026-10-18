import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createWorld, type World } from "../world.ts";
import { issueSchema, seedIssues, type SentryIssue } from "./seed.ts";

export type SentryState = { issues: SentryIssue[] };

export function createSentryWorld(): World<SentryState> {
  return createWorld(() => ({ issues: structuredClone([...seedIssues]) }));
}

export function createSentryServer(world: World<SentryState>): McpServer {
  const server = new McpServer({ name: "drift-kit-sentry", version: "0.0.0" });

  server.registerTool(
    "listIssues",
    {
      description: "List the issues of a Sentry project.",
      inputSchema: z.object({ project: z.string() }),
      outputSchema: z.object({ issues: z.array(issueSchema) }),
    },
    async ({ project }) => {
      const output = {
        issues: world.state.issues.filter((issue) => issue.project === project),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  );

  return server;
}
