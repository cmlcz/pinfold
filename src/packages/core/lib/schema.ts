/** A JSON Schema, as MCP Tools declare them. */
export type JsonSchema = Record<string, unknown>;

/** The JSON Schema of a value's shape, for Tools that declare no output schema. */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items = value.map(inferSchema).reduce(merge, undefined);
    return { type: "array", items: items ?? {} };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, field]) => [key, inferSchema(field)])
      ),
      required: entries.map(([key]) => key),
    };
  }
  return { type: typeof value === "bigint" ? "number" : typeof value };
}

// The shape of array items: fields every item has stay required.
function merge(a: JsonSchema | undefined, b: JsonSchema): JsonSchema {
  if (a === undefined || JSON.stringify(a) === JSON.stringify(b)) return b;
  if (a.type === "object" && b.type === "object") {
    const pa = a.properties as Record<string, JsonSchema>;
    const pb = b.properties as Record<string, JsonSchema>;
    const keys = [...new Set([...Object.keys(pa), ...Object.keys(pb)])];
    const rb = b.required as string[];
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          pa[key] && pb[key] ? merge(pa[key], pb[key]) : (pa[key] ?? pb[key]),
        ])
      ),
      required: (a.required as string[]).filter((key) => rb.includes(key)),
    };
  }
  if (a.type === "array" && b.type === "array") {
    return {
      type: "array",
      items: merge(a.items as JsonSchema, b.items as JsonSchema),
    };
  }
  const options = [a, b].flatMap(
    (s) => (s.anyOf as JsonSchema[] | undefined) ?? [s]
  );
  const unique = [
    ...new Map(options.map((s) => [JSON.stringify(s), s])).values(),
  ];
  return { anyOf: unique };
}
