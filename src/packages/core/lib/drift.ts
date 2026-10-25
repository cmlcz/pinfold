// Drift: where a Tool's adapted response no longer fits its Baseline, and
// whether that touches what a Workflow reads.
import { childPath, redacted } from "./paths.ts";
import type { JsonSchema } from "./schema.ts";

/** A field of the Baseline the response does not fit, and how. */
export type Mismatch = { path: string; problem: string };

const missing = "is missing";

/**
 * Where a response does not fit a Baseline's shape, by field path; `""` is
 * the whole response. Fields the Baseline does not have are not Drift.
 * With `redactedFits`, a `[redacted]` value fits wherever it stands, as it
 * holds the place of a value that was kept out of a recorded response.
 */
export function mismatches(
  schema: JsonSchema,
  value: unknown,
  options: { redactedFits?: boolean } = {}
): Mismatch[] {
  const found = new Map<string, string>();
  const report: Report = (path, problem) => {
    if (!found.has(path)) found.set(path, problem);
  };
  check(schema, value, "", { report, redactedFits: !!options.redactedFits });
  return [...found].map(([path, problem]) => ({ path, problem }));
}

type Report = (path: string, problem: string) => void;

type Checking = { report: Report; redactedFits: boolean };

function check(
  schema: JsonSchema | boolean,
  value: unknown,
  path: string,
  checking: Checking
): void {
  const { report } = checking;
  if (schema === true) return;
  if (checking.redactedFits && value === redacted) return;
  if (schema === false) {
    report(path, `is ${kindOf(value)}, where the Baseline allows no value`);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf;
    const results = options.map((option) => {
      const found: [string, string][] = [];
      check(option, value, path, {
        ...checking,
        report: (inner, problem) => found.push([inner, problem]),
      });
      return found;
    });
    if (results.some((result) => result.length === 0)) return;
    // The option for the value's kind, if any, says best what is wrong.
    const kind = options.findIndex(
      (option) => typeof option === "object" && allows(option.type, value)
    );
    if (kind === -1) {
      report(path, `is ${kindOf(value)}, not ${describe(options)}`);
    } else {
      for (const [inner, problem] of results[kind]!) report(inner, problem);
    }
    return;
  }
  if (schema.type !== undefined && !allows(schema.type, value)) {
    report(path, `is ${kindOf(value)}, not ${describe([schema])}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => equal(e, value))) {
    report(
      path,
      `is ${JSON.stringify(value)}, not one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`
    );
    return;
  }
  if ("const" in schema && !equal(schema.const, value)) {
    report(
      path,
      `is ${JSON.stringify(value)}, not ${JSON.stringify(schema.const)}`
    );
    return;
  }
  if (Array.isArray(value)) {
    // A tuple's elements have a schema each, and items covers the rest.
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, item] of value.entries()) {
      const items = prefix[index] ?? schema.items;
      if (items !== undefined) check(items, item, `${path}[]`, checking);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  for (const [key, field] of Object.entries(properties)) {
    const inner = childPath(path, key);
    if (Object.hasOwn(record, key)) check(field, record[key], inner, checking);
    else if (required.includes(key)) report(inner, missing);
  }
  // The values of a map, keyed by data, are reported at the map.
  const additional = schema.additionalProperties;
  if (typeof additional === "object" && additional !== null) {
    for (const [key, field] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) continue;
      let fits = true;
      check(additional, field, path, {
        ...checking,
        report: () => (fits = false),
      });
      if (!fits) {
        report(path, "holds values that do not fit the Baseline");
        return;
      }
    }
  }
}

/** Whether any mismatch touches a field a Contract reads of the Tool. */
export function touchesContract(
  found: Mismatch[],
  contract: Record<string, string[]>,
  tool: string
): boolean {
  const reads = Object.hasOwn(contract, tool) ? contract[tool]! : [];
  return touching(found, reads).length > 0;
}

/** The mismatches that touch any of these field reads. */
export function touching(found: Mismatch[], reads: string[]): Mismatch[] {
  return found.filter(({ path }) => reads.some((read) => touches(path, read)));
}

/** Whether a mismatch is a field the Baseline requires that is not there. */
export function isMissing(mismatch: Mismatch): boolean {
  return mismatch.problem === missing;
}

/** Whether Drift at one path touches a field read at another. */
export function touches(drifted: string, read: string): boolean {
  return within(drifted, read) || within(read, drifted);
}

// Whether a path is the other path or inside it.
function within(path: string, outer: string): boolean {
  return (
    outer === "" ||
    path === outer ||
    path.startsWith(`${outer}.`) ||
    path.startsWith(`${outer}[`)
  );
}

/** One line per mismatch, as the Drift report shows it. */
export function describeMismatch({ path, problem }: Mismatch): string {
  return `${path === "" ? "the response" : path} ${problem}`;
}

function allows(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((one) => allows(one, value));
  switch (type) {
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value} ${JSON.stringify(value)}`;
}

function describe(options: (JsonSchema | boolean)[]): string {
  const types = options.flatMap((option) =>
    typeof option === "boolean" ? [] : [option.type ?? "any"].flat()
  );
  return [...new Set(types)].join(" or ");
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
