import * as z from "zod";

export const issueSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  project: z.string(),
  title: z.string(),
  culprit: z.string(),
  filename: z.string(),
  lineNumber: z.number(),
  level: z.enum(["fatal", "error", "warning", "info"]),
  status: z.enum(["unresolved", "resolved", "ignored"]),
  count: z.number(),
  userCount: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

export type SentryIssue = z.infer<typeof issueSchema>;

export const seedIssues: readonly SentryIssue[] = [
  {
    id: "4501",
    shortId: "WEB-1A",
    project: "web",
    title: "TypeError: Cannot read properties of undefined (reading 'total')",
    culprit: "checkout.ts in computeTotal",
    filename: "src/checkout.ts",
    lineNumber: 42,
    level: "error",
    status: "unresolved",
    count: 128,
    userCount: 61,
    firstSeen: "2026-10-16T08:12:00Z",
    lastSeen: "2026-10-17T21:40:00Z",
  },
  {
    id: "4502",
    shortId: "WEB-1B",
    project: "web",
    title: "TimeoutError: sync-worker exceeded 30000ms",
    culprit: "sync-worker.ts in flushQueue",
    filename: "src/sync-worker.ts",
    lineNumber: 117,
    level: "error",
    status: "unresolved",
    count: 73,
    userCount: 12,
    firstSeen: "2026-10-17T02:05:00Z",
    lastSeen: "2026-10-17T22:58:00Z",
  },
  {
    id: "4503",
    shortId: "WEB-1C",
    project: "web",
    title: "Warning: deprecated currency format",
    culprit: "format.ts in formatPrice",
    filename: "src/format.ts",
    lineNumber: 9,
    level: "warning",
    status: "resolved",
    count: 210,
    userCount: 88,
    firstSeen: "2026-10-10T10:00:00Z",
    lastSeen: "2026-10-17T19:30:00Z",
  },
  {
    id: "4601",
    shortId: "API-2A",
    project: "api",
    title: "DatabaseError: deadlock detected",
    culprit: "orders.ts in reserveStock",
    filename: "src/orders.ts",
    lineNumber: 88,
    level: "fatal",
    status: "unresolved",
    count: 54,
    userCount: 30,
    firstSeen: "2026-10-17T06:45:00Z",
    lastSeen: "2026-10-17T23:10:00Z",
  },
];

export const eventSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  timestamp: z.string(),
  release: z.string(),
  message: z.string(),
});

export type SentryEvent = z.infer<typeof eventSchema>;

export const seedEvents: readonly SentryEvent[] = [
  {
    id: "e-9001",
    issueId: "4501",
    timestamp: "2026-10-17T21:40:00Z",
    release: "web@3.4.1",
    message: "Cannot read properties of undefined (reading 'total')",
  },
  {
    id: "e-9002",
    issueId: "4501",
    timestamp: "2026-10-17T20:12:00Z",
    release: "web@3.4.0",
    message: "Cannot read properties of undefined (reading 'total')",
  },
  {
    id: "e-9101",
    issueId: "4601",
    timestamp: "2026-10-17T23:10:00Z",
    release: "api@1.9.0",
    message: "deadlock detected",
  },
];

export type SentryProject = { slug: string; name: string; platform: string };

export const seedProjects: readonly SentryProject[] = [
  { slug: "web", name: "Web storefront", platform: "javascript" },
  { slug: "api", name: "Orders API", platform: "node" },
];
