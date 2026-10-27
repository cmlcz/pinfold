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
  // A batch-jobs project with many issues, two of them regressions that
  // share a culprit with an earlier issue.
  ...(
    [
      ["mailer.ts in sendDigest", "src/jobs/mailer.ts", 31, "unresolved", 412],
      [
        "billing.ts in chargeCard",
        "src/jobs/billing.ts",
        77,
        "unresolved",
        260,
      ],
      ["export.ts in writeCsv", "src/jobs/export.ts", 12, "unresolved", 198],
      ["cleanup.ts in purgeOld", "src/jobs/cleanup.ts", 54, "unresolved", 151],
      ["mailer.ts in sendDigest", "src/jobs/mailer.ts", 31, "unresolved", 133],
      ["sync.ts in pullVendors", "src/jobs/sync.ts", 140, "unresolved", 120],
      ["report.ts in buildWeekly", "src/jobs/report.ts", 66, "unresolved", 97],
      ["billing.ts in refund", "src/jobs/billing.ts", 203, "unresolved", 88],
      ["export.ts in writeCsv", "src/jobs/export.ts", 12, "unresolved", 75],
      ["cleanup.ts in vacuum", "src/jobs/cleanup.ts", 99, "resolved", 64],
      ["sync.ts in pushOrders", "src/jobs/sync.ts", 18, "unresolved", 41],
      ["report.ts in emailPdf", "src/jobs/report.ts", 150, "ignored", 23],
    ] as const
  ).map(
    ([culprit, filename, lineNumber, status, count], index): SentryIssue => ({
      id: String(4701 + index),
      shortId: `JOBS-${(index + 1).toString(36).toUpperCase()}`,
      project: "jobs",
      title: `JobError: ${culprit.split(" in ")[1]} failed`,
      culprit,
      filename,
      lineNumber,
      level: "error",
      status,
      count,
      userCount: 0,
      firstSeen: "2026-10-15T00:00:00Z",
      lastSeen: `2026-10-17T${String(10 + index).padStart(2, "0")}:00:00Z`,
    })
  ),
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
  {
    id: "e-9201",
    issueId: "4701",
    timestamp: "2026-10-17T10:00:00Z",
    release: "jobs@2.1.0",
    message: "SMTP connection reset",
  },
  {
    id: "e-9202",
    issueId: "4701",
    timestamp: "2026-10-16T09:00:00Z",
    release: "jobs@2.0.3",
    message: "SMTP connection reset",
  },
  {
    id: "e-9203",
    issueId: "4702",
    timestamp: "2026-10-17T11:00:00Z",
    release: "jobs@2.1.0",
    message: "card declined: insufficient funds",
  },
];

export type SentryProject = {
  slug: string;
  name: string;
  platform: string;
  team: string | null;
  archivedAt: string | null;
};

export const seedProjects: readonly SentryProject[] = [
  {
    slug: "web",
    name: "Web storefront",
    platform: "javascript",
    team: "storefront",
    archivedAt: null,
  },
  {
    slug: "api",
    name: "Orders API",
    platform: "node",
    team: null,
    archivedAt: null,
  },
  {
    slug: "jobs",
    name: "Batch jobs",
    platform: "node",
    team: null,
    archivedAt: null,
  },
];

export type TeamMember = { name: string; email?: string };

// Shaped to vary between calls: a team that was never set, an empty one, and
// members that differ in which fields they have.
export const seedTeams: Readonly<Record<string, TeamMember[] | null>> = {
  web: [{ name: "Ana", email: "ana@example.com" }, { name: "Li" }],
  api: [],
  legacy: null,
};
