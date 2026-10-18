// The readable form of a Plan's outcome: the result, then the Write Plan.
import { Placeholder } from "../../sandbox/index.ts";
import type { WritePlan } from "./plan.ts";

export function formatOutcome(value: unknown, plan: WritePlan): string {
  const result = formatValue(value);
  if (plan.writes.length === 0) return result;
  const count =
    plan.writes.length === 1 ? "1 write" : `${plan.writes.length} writes`;
  const writes = plan.writes.map(
    (write, index) =>
      `  ${index + 1}. ${write.tool} ${formatValue(write.arguments)}`
  );
  return [
    result,
    "",
    `Write Plan ${plan.id}: ${count}, none sent yet`,
    ...writes,
  ].join("\n");
}

/** JSON, except that a Placeholder reads as `<write 1>.id`. */
function formatValue(value: unknown): string {
  const placeholders: Placeholder[] = [];
  const json =
    JSON.stringify(value, (_, field: unknown) => {
      if (!(field instanceof Placeholder)) return field;
      placeholders.push(field);
      return token(placeholders.length - 1);
    }) ?? "undefined";
  return placeholders.reduce(
    (text, placeholder, index) =>
      text.replace(JSON.stringify(token(index)), String(placeholder)),
    json
  );
}

function token(index: number): string {
  return `\u0000placeholder ${index}\u0000`;
}
