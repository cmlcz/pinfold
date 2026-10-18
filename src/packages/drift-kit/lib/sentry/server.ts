import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createWorld, type World } from "../world.ts";
import {
  eventSchema,
  issueSchema,
  seedEvents,
  seedIssues,
  seedProjects,
  type SentryEvent,
  type SentryIssue,
  type SentryProject,
} from "./seed.ts";

export type SentryState = {
  issues: SentryIssue[];
  events: SentryEvent[];
  projects: SentryProject[];
};

export function createSentryWorld(): World<SentryState> {
  return createWorld(() => ({
    issues: structuredClone([...seedIssues]),
    events: structuredClone([...seedEvents]),
    projects: structuredClone([...seedProjects]),
  }));
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

  server.registerTool(
    "getIssue",
    {
      description: "Get one Sentry issue by its id.",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: issueSchema,
    },
    async ({ id }) => {
      const issue = world.state.issues.find((issue) => issue.id === id);
      if (issue === undefined) {
        return {
          content: [{ type: "text", text: `issue ${id} not found` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(issue) }],
        structuredContent: issue,
      };
    }
  );

  server.registerTool(
    "listIssueEvents",
    {
      description: "List the events recorded for a Sentry issue, newest first.",
      inputSchema: z.object({ issueId: z.string() }),
      outputSchema: z.object({ events: z.array(eventSchema) }),
    },
    async ({ issueId }) => {
      const output = {
        events: world.state.events.filter((event) => event.issueId === issueId),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  );

  // No outputSchema and text-only JSON, as many real servers answer.
  server.registerTool(
    "listProjects",
    { description: "List the Sentry projects of the organization." },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ projects: world.state.projects }),
        },
      ],
    })
  );

  return server;
}
