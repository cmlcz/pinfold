// Apply: send an approved Write Plan's writes in order, giving each write the
// real results of the earlier writes its Placeholders stand for.
import { Placeholder } from "../../sandbox/index.ts";
import type { PlannedWrite } from "./plan.ts";

export async function sendWrites(
  writes: PlannedWrite[],
  send: (write: PlannedWrite, args: unknown) => Promise<unknown>
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const [index, write] of writes.entries()) {
    try {
      results.push(
        await send(write, resolvePlaceholders(write.arguments, results))
      );
    } catch (error) {
      throw new Error(
        `Apply stopped at write ${index + 1} of ${writes.length} (${write.tool}): ${(error as Error).message}. ` +
          `Writes sent: ${index}; not sent: ${writes.length - index}.`,
        { cause: error }
      );
    }
  }
  return results;
}

/** A copy of a value with each Placeholder replaced by the real result. */
export function resolvePlaceholders(
  value: unknown,
  results: unknown[]
): unknown {
  if (value instanceof Placeholder) {
    let resolved: unknown = results[value.write - 1];
    for (const step of value.path) {
      if (
        typeof resolved !== "object" ||
        resolved === null ||
        !Object.hasOwn(resolved, step)
      ) {
        throw new Error(`${value} has no value in the real result`);
      }
      resolved = (resolved as Record<string, unknown>)[step];
    }
    return resolved;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value))
    return value.map((item) => resolvePlaceholders(item, results));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolvePlaceholders(item, results),
    ])
  );
}
