import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type * as z from "zod";
import { applyFieldDrift } from "./field-drift.ts";
import type { World } from "./world.ts";

/** A Tool result carrying its output both as structured content and as text. */
export function structured<Output extends Record<string, unknown>>(
  output: Output
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/** A Tool's result, as the field-level Drift Scenarios now on change it. */
export function respond(
  world: World<unknown>,
  tool: string,
  output: Record<string, unknown>
) {
  return structured(applyFieldDrift(world.drift, tool, output));
}

/** The error result of a write the control channel chose to fail. */
export function failedOnRequest() {
  return {
    content: [
      { type: "text" as const, text: "Drift Kit failed this write on request" },
    ],
    isError: true,
  };
}

/**
 * A Tool's output schema, listed as declared but not enforced while a Drift
 * Scenario is on: like a server changed during a session, the responses
 * leave the listing behind.
 */
export function listed<Schema extends z.ZodType>(
  schema: Schema,
  world: World<unknown>
): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value) =>
        world.drift.size > 0 ? { value } : standard.validate(value),
    },
  } as StandardSchemaWithJSON;
}
