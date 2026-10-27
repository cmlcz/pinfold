// Workflow count_unresolved, saved by pinfold from Exploration Run b7f0027c.
// This file is yours to edit. Each Workflow Run runs main(input) as a Plan;
// a Write Plan with more writes than settings.writeBudget waits for Approval.
export const settings = { writeBudget: 10 };

export async function main(input: { project: string }) {
  const { issues } = await sdk.sentry.listIssues(input);
  return issues.filter((issue) => issue.status === "unresolved").length;
}
