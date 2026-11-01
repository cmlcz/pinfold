// Write Plans: the ordered Write Tool calls a Plan recorded instead of sending.
import { createHash } from "node:crypto";
import { encodeValue, Placeholder } from "../../sandbox/index.ts";

export type PlannedWrite = {
  /** The Tool as `server.tool`. */
  tool: string;
  /** Canonical arguments: keys sorted, Placeholders kept as they are. */
  arguments: unknown;
};

export type WritePlan = {
  /**
   * Derived from the run's code and input, its writes and its Adapters. A
   * run of the same code and input that rebuilds the plan gets the same ID,
   * and approving a plan approves the Adapters it was built through too.
   * A run of other code or input never gets the ID, so it never takes
   * another run's Approval (#54).
   */
  id: string;
  writes: PlannedWrite[];
  /**
   * The digest of each Response Adapter the run's Tools went through, by
   * Tool as `server.tool`. A plan without writes may still wait for
   * Approval of changed Adapters.
   */
  adapters: Record<string, string>;
};

export function writePlan(
  /** The run key: its code and input, as a hash. */
  run: string,
  writes: PlannedWrite[],
  adapters: Record<string, string>
): WritePlan {
  const id = shortHash(
    encodeValue({ run, writes, adapters: canonicalize(adapters) })
  );
  return { id, writes, adapters };
}

/** A short, stable ID for a text. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** A copy whose object keys are sorted, so equal arguments serialize equally. */
export function canonicalize(value: unknown): unknown {
  if (
    value instanceof Placeholder ||
    typeof value !== "object" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}

export function containsPlaceholder(value: unknown): boolean {
  if (value instanceof Placeholder) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsPlaceholder);
}
