// The outcome of an Exploration Run and its readable form.
import { Placeholder } from "../../sandbox/index.ts";
import type { WritePlan } from "./plan.ts";

/**
 * An Exploration Run ran as a Plan. Without writes it is complete. Otherwise
 * its Write Plan waits for Approval; once approved, the same code running
 * again rebuilds the plan and applies it if nothing changed.
 */
export type ExploreResult =
  | { ok: false; error: string }
  | {
      ok: true;
      status: "complete" | "pending" | "declined";
      /** May hold Placeholders, since nothing was sent. */
      value: unknown;
      plan: WritePlan;
    }
  | {
      ok: true;
      status: "applied";
      /** Placeholders replaced by the real results of the writes. */
      value: unknown;
      plan: WritePlan;
    }
  | {
      ok: true;
      status: "changed";
      value: unknown;
      /** The rebuilt plan, now pending in place of the approved one. */
      plan: WritePlan;
      approved: WritePlan;
    };

/** What the agent reads after a successful run. */
export function formatOutcome(
  result: Extract<ExploreResult, { ok: true }>
): string {
  const value = formatValue(result.value);
  const { plan } = result;
  switch (result.status) {
    case "complete":
      return value;
    case "applied":
      return `${value}\n\nApplied Write Plan ${plan.id}: ${writeCount(plan)} sent.`;
    case "declined":
      return `${value}\n\nThe developer declined Write Plan ${plan.id}; nothing was sent.`;
    case "pending":
      return [value, "", formatPlan(plan), "", approval(plan)].join("\n");
    case "changed":
      return [
        value,
        "",
        `The Write Plan changed since the developer approved ${result.approved.id}, so nothing was sent.`,
        "Approved:",
        ...formatWrites(result.approved),
        "Now:",
        formatPlan(plan),
        "",
        approval(plan),
      ].join("\n");
  }
}

export function formatPlan(plan: WritePlan): string {
  return [
    `Write Plan ${plan.id}: ${writeCount(plan)}, none sent yet`,
    ...formatWrites(plan),
  ].join("\n");
}

function approval(plan: WritePlan): string {
  return [
    "To send these writes, ask the developer to approve the plan in a terminal:",
    `  pinfold approve ${plan.id}`,
    "Then call run_sandbox again with the same code and input to apply it.",
  ].join("\n");
}

function formatWrites(plan: WritePlan): string[] {
  return plan.writes.map(
    (write, index) =>
      `  ${index + 1}. ${write.tool} ${formatValue(write.arguments)}`
  );
}

/** What resuming a stopped run sent. */
export type ResumeResult = {
  run: string;
  plan: WritePlan;
  /** The writes sent now, counted from 1; none if all were sent before. */
  sent: number[];
};

/** What the developer reads after a resume. */
export function formatResume({ run, plan, sent }: ResumeResult): string {
  return sent.length === 0
    ? `Run ${run} had already applied Write Plan ${plan.id} in full; nothing was sent.`
    : `Resumed run ${run}: sent ${span(sent[0]!, sent.at(-1)!)} of Write Plan ${plan.id}.`;
}

/** Writes `from` to `to`, counted from 1. */
export function span(from: number, to: number): string {
  if (from > to) return "none";
  return from === to ? `write ${from}` : `writes ${from}–${to}`;
}

export function writeCount(plan: WritePlan): string {
  return plan.writes.length === 1 ? "1 write" : `${plan.writes.length} writes`;
}

/** JSON, except that a Placeholder reads as `<write 1>.id`. */
function formatValue(value: unknown): string {
  return render(value) ?? "undefined";
}

// Built like JSON.stringify, so that no data can be mistaken for a
// Placeholder however it is spelled.
function render(value: unknown): string | undefined {
  if (value instanceof Placeholder) return String(value);
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === "function") return render(toJSON.call(value));
  if (Array.isArray(value)) {
    return `[${value.map((item) => render(item) ?? "null").join(",")}]`;
  }
  const fields = Object.entries(value).flatMap(([key, field]) => {
    const text = render(field);
    return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`];
  });
  return `{${fields.join(",")}}`;
}
