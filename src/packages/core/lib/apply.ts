// Apply: send an approved Write Plan's writes in order, giving each write the
// real results of the earlier writes its Placeholders stand for.
import { Placeholder } from "../../sandbox/index.ts";
import { ToolError } from "./downstream.ts";
import type { RunJournal } from "./journal.ts";
import { span } from "./outcome.ts";
import type { PlannedWrite } from "./plan.ts";

/** An Apply stopped at a write that failed; the report says what was sent. */
export class ApplyStopped extends Error {}

/**
 * Sends the writes the journal has not recorded as sent and returns the
 * results of all writes. Stops at the first write that fails.
 */
export async function sendWrites(
  writes: PlannedWrite[],
  journal: RunJournal,
  send: (write: PlannedWrite, args: unknown) => Promise<unknown>
): Promise<unknown[]> {
  const results = journal.sent();
  for (let index = results.length; index < writes.length; index++) {
    const write = writes[index]!;
    const position = index + 1;
    const stopped = (error: unknown, inDoubt: boolean) =>
      new ApplyStopped(
        `Apply stopped at write ${position} of ${writes.length} (${write.tool}): ${(error as Error).message}. ` +
          `Sent: ${span(1, index)}.` +
          (inDoubt
            ? ` May have been sent: write ${position}. Not sent: ${span(position + 1, writes.length)}. ` +
              `No resume sends this run's writes, since write ${position} may have reached its server.`
            : ` Not sent: ${span(position, writes.length)}. ` +
              `\`pinfold resume ${journal.run}\` sends the writes not sent.`),
        { cause: error }
      );
    let args: unknown;
    try {
      args = resolvePlaceholders(write.arguments, results);
    } catch (error) {
      throw stopped(error, false);
    }
    switch (journal.take(index)) {
      case "busy":
        throw new Error(`Write ${position} is being sent by another Apply.`);
      case "declined":
        throw new ApplyStopped(
          `The developer declined this Write Plan, so the Apply stopped before write ${position} of ${writes.length}. Sent: ${span(1, index)}. Not sent: ${span(position, writes.length)}.`
        );
    }
    try {
      results.push(await send(write, args));
    } catch (error) {
      // A server that answered with an error did not take the write. Any
      // other failure may have reached it, so the write stays taken and is
      // never sent again.
      const refused = error instanceof ToolError;
      if (refused) journal.release(index);
      throw stopped(error, !refused);
    }
    journal.settle(index, results[index]);
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
