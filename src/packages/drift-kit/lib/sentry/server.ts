import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { listed, structured } from "../reply.ts";
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

/**
 * The Drift Scenarios of the Sentry server. Each changes the issues that
 * listIssues and getIssue return:
 * - rename: count becomes eventCount;
 * - wrap: the response moves under data;
 * - type-change: count becomes a string;
 * - enum-change: status unresolved, resolved and ignored become open, closed
 *   and muted;
 * - removed-field: userCount is gone;
 * - pagination: listIssues returns its first 2 issues as results, with a
 *   cursor for the rest, which no Response Adapter can fetch.
 */
export const sentryDriftScenarios = [
  "rename",
  "wrap",
  "type-change",
  "enum-change",
  "removed-field",
  "pagination",
] as const;

export function createSentryWorld(): World<SentryState> {
  return createWorld(
    () => ({
      issues: structuredClone([...seedIssues]),
      events: structuredClone([...seedEvents]),
      projects: structuredClone([...seedProjects]),
    }),
    sentryDriftScenarios
  );
}

const driftedStatus = {
  unresolved: "open",
  resolved: "closed",
  ignored: "muted",
} as const;

// An issue as the server answers with its Drift Scenarios on.
function driftIssue(
  drift: ReadonlySet<string>,
  issue: SentryIssue
): Record<string, unknown> {
  const { count, userCount, status, ...rest } = issue;
  const counted = drift.has("type-change") ? String(count) : count;
  return {
    ...rest,
    ...(drift.has("rename") ? { eventCount: counted } : { count: counted }),
    ...(!drift.has("removed-field") && { userCount }),
    status: drift.has("enum-change") ? driftedStatus[status] : status,
  };
}

// A whole response, as the server answers with its Drift Scenarios on.
function driftResponse(
  drift: ReadonlySet<string>,
  output: Record<string, unknown>
): Record<string, unknown> {
  return drift.has("wrap") ? { data: output } : output;
}

export function createSentryServer(world: World<SentryState>): McpServer {
  const server = new McpServer({ name: "drift-kit-sentry", version: "0.0.0" });

  server.registerTool(
    "listIssues",
    {
      description: "List the issues of a Sentry project.",
      inputSchema: z.object({ project: z.string() }),
      outputSchema: listed(z.object({ issues: z.array(issueSchema) }), world),
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      const { drift } = world;
      const issues = world.state.issues
        .filter((issue) => issue.project === project)
        .map((issue) => driftIssue(drift, issue));
      const pageSize = 2;
      const output = drift.has("pagination")
        ? {
            results: issues.slice(0, pageSize),
            nextCursor: issues.length > pageSize ? String(pageSize) : null,
          }
        : { issues };
      return structured(driftResponse(drift, output));
    }
  );

  server.registerTool(
    "getIssue",
    {
      description: "Get one Sentry issue by its id.",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: listed(issueSchema, world),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const issue = world.state.issues.find((candidate) => candidate.id === id);
      if (issue === undefined) {
        return {
          content: [{ type: "text", text: `issue ${id} not found` }],
          isError: true,
        };
      }
      return structured(
        driftResponse(world.drift, driftIssue(world.drift, issue))
      );
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
      const members = seedTeams[slug];
      return {
        content: [{ type: "text", text: JSON.stringify({ slug, members }) }],
      };
    }
  );

  return server;
}
