// Field paths: `issues[].count` names the count of every element of issues.
// A step is `.name`, `["any name"]` or `[]` for every element of an array;
// the first name has no dot. Contracts and redaction rules use them.
import { isDataKey, type JsonSchema } from "./schema.ts";

export type Step = { key: string } | { each: true };

/** The steps of a field path, or undefined if it is not one. */
export function parsePath(path: string): Step[] | undefined {
  const stepPattern = /\.?([A-Za-z_$][\w$]*)|\[\]|\[("(?:[^"\\]|\\.)*")\]/y;
  const steps: Step[] = [];
  while (stepPattern.lastIndex < path.length) {
    const match = stepPattern.exec(path);
    if (match === null) return undefined;
    if (steps.length === 0 && match[0].startsWith(".")) return undefined;
    if (match[1] !== undefined) steps.push({ key: match[1] });
    else if (match[2] !== undefined)
      steps.push({ key: JSON.parse(match[2]) as string });
    else steps.push({ each: true });
  }
  return steps.length > 0 ? steps : undefined;
}

/** A field path one field further, written as Contracts write it. */
export function childPath(path: string, key: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path === "" ? key : `${path}.${key}`;
}

/** The field path of some steps; `""` for none, the whole value. */
export function formatPath(steps: Step[]): string {
  return steps.reduce(
    (path, step) => ("each" in step ? `${path}[]` : childPath(path, step.key)),
    ""
  );
}

/**
 * The values a path names, through every element of each array on its way;
 * `""` names the whole value.
 */
export function valuesAt(value: unknown, path: string): unknown[] {
  if (path === "") return [value];
  const found: unknown[] = [];
  const visit = (inner: unknown, steps: Step[]) => {
    const [step, ...rest] = steps;
    if (step === undefined) found.push(inner);
    else if ("each" in step) {
      if (Array.isArray(inner)) for (const item of inner) visit(item, rest);
    } else if (isRecord(inner) && Object.hasOwn(inner, step.key)) {
      visit(inner[step.key], rest);
    }
  };
  visit(value, parsePath(path) ?? []);
  return found;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPrimitive(
  value: unknown
): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

/**
 * A path up to its first key that is data, such as an email address in a
 * map: Contracts are committed, and data must stay out of them. Empty when
 * the path starts with one.
 */
export function withoutDataKeys(path: string): string {
  let kept = "";
  for (const step of parsePath(path) ?? []) {
    if ("each" in step) kept += "[]";
    else if (isDataKey(step.key)) break;
    else if (/^[A-Za-z_$][\w$]*$/.test(step.key))
      kept += kept === "" ? step.key : `.${step.key}`;
    else kept += `[${JSON.stringify(step.key)}]`;
  }
  return kept;
}

/** Only the deepest paths: `issues` goes when `issues[].count` is there. */
export function deepestPaths(paths: Iterable<string>): string[] {
  const all = [...new Set(paths)].sort();
  return all.filter(
    (path) =>
      !all.some(
        (other) => other.startsWith(`${path}.`) || other.startsWith(`${path}[`)
      )
  );
}

/** What a redacted field holds instead of its value. */
export const redacted = "[redacted]";

/** A copy of a value with every field a path names replaced by `[redacted]`. */
export function redact(value: unknown, paths: string[]): unknown {
  let copy = structuredClone(value);
  for (const path of paths) {
    const steps = parsePath(path);
    if (steps !== undefined) copy = replaceAt(copy, steps);
  }
  return copy;
}

function replaceAt(value: unknown, steps: Step[]): unknown {
  if (steps.length === 0) return redacted;
  if (typeof value !== "object" || value === null) return value;
  const [step, ...rest] = steps as [Step, ...Step[]];
  if ("each" in step) {
    return Array.isArray(value)
      ? value.map((item) => replaceAt(item, rest))
      : value;
  }
  // A rule that names a field inside an array without [] still reaches it in
  // every element, rather than redacting nothing.
  if (Array.isArray(value)) return value.map((item) => replaceAt(item, steps));
  if (!Object.hasOwn(value, step.key)) return value;
  const record = value as Record<string, unknown>;
  record[step.key] = replaceAt(record[step.key], rest);
  return record;
}

/**
 * Whether a JSON Schema allows the field a path names, as JSON Schema reads
 * it: an object allows fields it does not list unless its
 * additionalProperties is false, and a part of the shape that says nothing
 * of its type, such as `{}`, allows every field.
 */
export function shapeAllows(schema: JsonSchema, path: string): boolean {
  const steps = parsePath(path);
  return steps !== undefined && hasSteps(schema, steps);
}

function hasSteps(schema: JsonSchema | boolean, steps: Step[]): boolean {
  if (typeof schema === "boolean") return schema;
  const [step, ...rest] = steps;
  if (step === undefined) return true;
  // type: ["object", "null"] is a union of its types.
  if (Array.isArray(schema.type)) {
    return schema.type.some((type) => hasSteps({ ...schema, type }, steps));
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((option) => hasSteps(option, steps));
  }
  if ("each" in step) {
    if (schema.type === undefined) return true;
    // A tuple's elements have a schema each, and items covers the rest.
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    return (
      schema.type === "array" &&
      [...prefix, schema.items ?? true].some((items) => hasSteps(items, rest))
    );
  }
  if (schema.type === undefined) return true;
  if (schema.type !== "object") return false;
  const properties = schema.properties ?? {};
  if (Object.hasOwn(properties, step.key)) {
    return hasSteps(properties[step.key]!, rest);
  }
  return hasSteps(schema.additionalProperties ?? true, rest);
}

/** The schemas a path reaches in a JSON Schema, through unions and arrays. */
export function schemasAt(
  schema: JsonSchema | boolean,
  steps: Step[]
): JsonSchema[] {
  if (typeof schema === "boolean") return [];
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.flatMap((option) => schemasAt(option, steps));
  }
  const [step, ...rest] = steps;
  if (step === undefined) return [schema];
  if ("each" in step) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    return [...prefix, schema.items ?? true].flatMap((items) =>
      schemasAt(items, rest)
    );
  }
  const properties = schema.properties ?? {};
  return schemasAt(
    Object.hasOwn(properties, step.key)
      ? properties[step.key]!
      : (schema.additionalProperties ?? true),
    rest
  );
}
