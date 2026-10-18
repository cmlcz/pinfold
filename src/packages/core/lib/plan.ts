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
  /** Derived from the writes alone, so equal Write Plans share an ID. */
  id: string;
  writes: PlannedWrite[];
};

export function writePlan(writes: PlannedWrite[]): WritePlan {
  return { id: shortHash(encodeValue(writes)), writes };
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
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ])
  );
}

export function containsPlaceholder(value: unknown): boolean {
  if (value instanceof Placeholder) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsPlaceholder);
}
