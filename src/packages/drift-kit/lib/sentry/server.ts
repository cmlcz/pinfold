import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { structured } from "../reply.ts";
import { createWorld, type World } from "../world.ts";
import {
  eventSchema,
  issueSchema,
  seedEvents,
  seedIssues,
  seedProjects,
  seedTeams,
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
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      const output = {
        issues: world.state.issues.filter((issue) => issue.project === project),
      };
      return structured(output);
    }
  );

  server.registerTool(
    "getIssue",
    {
      description: "Get one Sentry issue by its id.",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: issueSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const issue = world.state.issues.find((issue) => issue.id === id);
      if (issue === undefined) {
        return {
          content: [{ type: "text", text: `issue ${id} not found` }],
          isError: true,
        };
      }
      return structured(issue);
    }
  );

  server.registerTool(
    "listIssueEvents",
    {
      description: "List the events recorded for a Sentry issue, newest first.",
      inputSchema: z.object({ issueId: z.string() }),
      outputSchema: z.object({ events: z.array(eventSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ issueId }) => {
      const output = {
        events: world.state.events.filter((event) => event.issueId === issueId),
      };
      return structured(output);
    }
  );

  // No outputSchema and text-only JSON, as many real servers answer.
  server.registerTool(
    "listProjects",
    {
      description: "List the Sentry projects of the organization.",
      inputSchema: z.object({ platform: z.string().optional() }),
    },
    async ({ platform }) => {
      const projects = world.state.projects.filter(
        (project) => platform === undefined || project.platform === platform
      );
      return {
        content: [{ type: "text", text: JSON.stringify({ projects }) }],
      };
    }
  );

  // No outputSchema, and plain text when there is no such project.
  server.registerTool(
    "getProjectTeam",
    {
      description: "Get the members of a Sentry project's team.",
      inputSchema: z.object({ slug: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      if (!Object.hasOwn(seedTeams, slug)) {
        return { content: [{ type: "text", text: `No project ${slug}.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ slug, members: seedTeams[slug] }),
          },
        ],
      };
    }
  );

  return server;
}
