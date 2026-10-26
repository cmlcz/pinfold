// Approval asked for and answered outside the terminal, in a dialog of the
// developer's MCP client.
import {
  reviewPlan,
  writeCount,
  type Failed,
  type PlanOutcome,
} from "./outcome.ts";
import type { PlanStore } from "./plans.ts";

/** A run's outcome that waits for Approval: its status pending or changed. */
export type PausedOutcome = PlanOutcome & { approvalReason?: string };

/** The developer's answer in an Approval dialog. */
export type ApprovalAnswer = "approve" | "decline" | "dismiss";

/**
 * What an answer decided: approved, so the same request running again
 * sends the plan if it rebuilds it, or else what to tell the agent.
 */
export type AnswerResult =
  | Failed
  | { ok: true; approved: true }
  | { ok: true; approved: false; text: string };

/**
 * What an Approval dialog shows: why the run paused, the Write Plan and the
 * Repair behind each Response Adapter it was built through.
 */
export async function approvalRequest(
  root: string,
  paused: PausedOutcome
): Promise<string> {
  const { plan } = paused;
  const lines: string[] = [];
  if (paused.approvalReason !== undefined) {
    lines.push(`Paused for Approval: ${paused.approvalReason}.`);
  }
  if (paused.status === "changed") {
    lines.push(
      `The Write Plan changed since the developer approved ${paused.approved.id}.`
    );
  } else if ("declined" in paused && paused.declined) {
    lines.push(`The developer declined Write Plan ${plan.id} before.`);
  }
  lines.push(await reviewPlan(root, plan));
  if (plan.writes.length === 0) {
    lines.push(
      "Approve to accept the Response Adapters it names and release the result built through them; decline and the result stays held back."
    );
  } else {
    const writes =
      plan.writes.length === 1 ? "this write" : `these ${writeCount(plan)}`;
    const through =
      Object.keys(plan.adapters).length > 0
        ? ", through the Response Adapters it names"
        : "";
    lines.push(
      `Approve to send ${writes} now${through}; decline and no run sends this plan.`
    );
  }
  return lines.join("\n\n");
}

/**
 * Takes the developer's answer to an Approval dialog for a Write Plan. A
 * plan already decided the same way, say in a terminal while the dialog was
 * open, counts as answered.
 */
export async function answerApproval(
  plans: PlanStore,
  id: string,
  answer: ApprovalAnswer
): Promise<AnswerResult> {
  if (answer === "dismiss") {
    return {
      ok: true,
      approved: false,
      text: [
        `The developer closed the Approval dialog without deciding, so nothing was sent. Write Plan ${id} waits for Approval in a terminal:`,
        `  pinfold approve ${id}`,
        "Then make the same call again to apply it.",
      ].join("\n"),
    };
  }
  const decided = answer === "approve" ? "approved" : "declined";
  try {
    await (answer === "approve" ? plans.approve(id) : plans.decline(id));
  } catch (error) {
    if ((await plans.latest(id))?.status !== decided) {
      return {
        ok: false,
        error: `The answer to the Approval dialog was not taken: ${(error as Error).message}.`,
      };
    }
  }
  if (answer === "approve") return { ok: true, approved: true };
  return {
    ok: true,
    approved: false,
    text: `The developer declined Write Plan ${id} in the Approval dialog, so nothing was sent. No run sends this plan; a later run that builds the same writes asks for Approval again.`,
  };
}
