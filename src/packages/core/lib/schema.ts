/** A JSON Schema, as MCP Tools declare them. */
export type JsonSchema = Record<string, unknown>;

/** The JSON Schema of a value's shape, for Tools that declare no output schema. */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items = value.map(inferSchema).reduce(mergeSchemas, undefined);
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

/** Whether every array in a shape has shown what it holds. */
export function isFullyObserved(schema: JsonSchema): boolean {
  if (schema.type === "array") {
    const items = schema.items as JsonSchema;
    return !isUnobserved(items) && isFullyObserved(items);
  }
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const options = (schema.anyOf ?? []) as JsonSchema[];
  return [...Object.values(properties), ...options].every(isFullyObserved);
}

/** The shape to pin: a value only ever seen as null says nothing of its type. */
export function forPinning(schema: JsonSchema): JsonSchema {
  if (schema.type === "null") return {};
  if (schema.type === "array") {
    return { ...schema, items: forPinning(schema.items as JsonSchema) };
  }
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, JsonSchema>;
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, field]) => [
          key,
          forPinning(field),
        ])
      ),
    };
  }
  return schema;
}

// An empty schema stands for a value not observed yet, such as the items of
// an empty array.
function isUnobserved(schema: JsonSchema): boolean {
  return Object.keys(schema).length === 0;
}

/** One shape covering everything two observations showed. */
export function mergeSchemas(
  a: JsonSchema | undefined,
  b: JsonSchema
): JsonSchema {
  // Fields every observation has stay required.
  if (a === undefined || isUnobserved(a)) return b;
  if (isUnobserved(b) || JSON.stringify(a) === JSON.stringify(b)) return a;
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
          pa[key] && pb[key]
            ? mergeSchemas(pa[key], pb[key])
            : (pa[key] ?? pb[key]),
        ])
      ),
      required: (a.required as string[]).filter((key) => rb.includes(key)),
    };
  }
  if (a.type === "array" && b.type === "array") {
    return {
      type: "array",
      items: mergeSchemas(a.items as JsonSchema, b.items as JsonSchema),
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
