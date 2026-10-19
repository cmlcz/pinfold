// Field paths: `issues[].count` names the count of every element of issues.
// A step is `.name`, `["any name"]` or `[]` for every element of an array;
// the first name has no dot. Contracts and redaction rules use them.

type Step = { key: string } | { each: true };

const stepPattern = /\.?([A-Za-z_$][\w$]*)|\[\]|\[("(?:[^"\\]|\\.)*")\]/y;

/** The steps of a field path, or undefined if it is not one. */
export function parsePath(path: string): Step[] | undefined {
  const steps: Step[] = [];
  stepPattern.lastIndex = 0;
  while (stepPattern.lastIndex < path.length) {
    const start = stepPattern.lastIndex;
    const match = stepPattern.exec(path);
    if (match === null) return undefined;
    if (start === 0 && match[0].startsWith(".")) return undefined;
    if (match[1] !== undefined) steps.push({ key: match[1] });
    else if (match[2] !== undefined)
      steps.push({ key: JSON.parse(match[2]) as string });
    else steps.push({ each: true });
  }
  return steps.length > 0 ? steps : undefined;
}

/** Only the deepest paths: `issues` goes when `issues[].count` is there. */
export function deepestPaths(paths: Iterable<string>): string[] {
  const all = [...new Set(paths)].sort();
  return all.filter(
    (path) =>
      !all.some(
        (other) =>
          other !== path &&
          other.startsWith(path) &&
          /^[.[]/.test(other.slice(path.length))
      )
  );
}

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
  if (Array.isArray(value) || !Object.hasOwn(value, step.key)) return value;
  const record = value as Record<string, unknown>;
  record[step.key] = replaceAt(record[step.key], rest);
  return record;
}
