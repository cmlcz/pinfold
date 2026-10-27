// The benchmark's tasks, run against the Drift Kit.
export { tasks, type Task, type TaskInput } from "./lib/tasks.ts";
export type { Outcome, Verdict } from "./lib/state.ts";

/** How the benchmark classifies the Drift Kit servers' Tools. */
export const benchClassification = {
  sentry: {
    listIssues: "read",
    getIssue: "read",
    listIssueEvents: "read",
    listProjects: "read",
    getProjectTeam: "read",
  },
  linear: { searchIssues: "read", createIssue: "write" },
  github: { getBlame: "read", listCommits: "read" },
} as const;
