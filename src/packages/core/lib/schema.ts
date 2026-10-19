/** A JSON Schema, as MCP Tools declare them. */
export type JsonSchema = Record<string, unknown>;

/** The JSON Schema of a value's shape, for Tools that declare no output schema. */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: mergeAll(value.map(inferSchema)) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    // An object keyed by data, such as email addresses or IDs, is a map: its
    // keys stay out of the committed Baseline.
    if (entries.length > 0 && entries.every(([key]) => isDataKey(key))) {
      return {
        type: "object",
        additionalProperties: mergeAll(
          entries.map(([, field]) => inferSchema(field))
        ),
      };
    }
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
  // In a union, null is one of the observed kinds and stays.
  if (Array.isArray(schema.anyOf)) {
    return {
      anyOf: (schema.anyOf as JsonSchema[]).map((option) =>
        option.type === "null" ? option : forPinning(option)
      ),
    };
  }
  if (schema.type === "array") {
    return { ...schema, items: forPinning(schema.items as JsonSchema) };
  }
  if (schema.type === "object") {
    if (isMap(schema)) {
      return {
        ...schema,
        additionalProperties: forPinning(
          schema.additionalProperties as JsonSchema
        ),
      };
    }
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
  if (a === undefined || isUnobserved(a)) return b;
  if (isUnobserved(b) || JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.type === "object" && b.type === "object") {
    if (isMap(a) || isMap(b)) {
      return {
        type: "object",
        additionalProperties: mergeAll([a, b].flatMap(valuesOf)),
      };
    }
    const propsA = a.properties as Record<string, JsonSchema>;
    const propsB = b.properties as Record<string, JsonSchema>;
    const keys = [...new Set([...Object.keys(propsA), ...Object.keys(propsB)])];
    // Fields every observation has stay required.
    const requiredA = a.required as string[];
    const requiredB = b.required as string[];
    return {
      type: "object",
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          propsA[key] && propsB[key]
            ? mergeSchemas(propsA[key], propsB[key])
            : (propsA[key] ?? propsB[key]),
        ])
      ),
      required: requiredA.filter((key) => requiredB.includes(key)),
    };
  }
  if (a.type === "array" && b.type === "array") {
    return {
      type: "array",
      items: mergeSchemas(a.items as JsonSchema, b.items as JsonSchema),
    };
  }
  // A union keeps one option per kind of value, each merged across
  // observations: null | [] and then [string] give null | string[].
  const options = optionsOf(a);
  for (const option of optionsOf(b)) {
    if (isUnobserved(option)) continue;
    const same = options.findIndex((o) => o.type === option.type);
    if (same === -1) options.push(option);
    else options[same] = mergeSchemas(options[same], option);
  }
  return options.length === 1 ? options[0]! : { anyOf: options };
}

/** One shape covering every observation; `{}` when there are none. */
function mergeAll(schemas: JsonSchema[]): JsonSchema {
  return schemas.reduce<JsonSchema | undefined>(mergeSchemas, undefined) ?? {};
}

/**
 * Whether an object key is data rather than a field name: an email address,
 * a number or an ID, say. Field names may hold hyphens, as in content-type.
 */
export function isDataKey(key: string): boolean {
  return !/^[A-Za-z_$][\w$-]*$/.test(key);
}

function isMap(schema: JsonSchema): boolean {
  return schema.type === "object" && schema.properties === undefined;
}

// The shapes of the values an object holds, whether a map or a record.
function valuesOf(schema: JsonSchema): JsonSchema[] {
  if (isMap(schema)) return [schema.additionalProperties as JsonSchema];
  return Object.values(schema.properties as Record<string, JsonSchema>);
}

function optionsOf(schema: JsonSchema): JsonSchema[] {
  return [...((schema.anyOf as JsonSchema[] | undefined) ?? [schema])];
}
