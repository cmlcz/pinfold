// Values cross the guest boundary as JSON in which a Placeholder is the
// object { "$placeholder": [write, ...path] }. Every data key that starts
// with "$" gains one more "$" on the way, so no data can pose as one.

export const placeholderMarker = "$placeholder";

/** Stands in for the result of a recorded write; `path` reaches into it. */
export class Placeholder {
  readonly write: number;
  readonly path: readonly string[];
  constructor(write: number, path: readonly string[] = []) {
    this.write = write;
    this.path = path;
  }

  /** Reads like `<write 1>.id`. */
  toString(): string {
    const steps = this.path.map((step) =>
      /^\d+$/.test(step) ? `[${step}]` : `.${step}`
    );
    return `<write ${this.write}>${steps.join("")}`;
  }
}

/** Misuse of a Placeholder. Thrown by a host function, it fails the whole run. */
export class PlaceholderError extends Error {
  name = "PlaceholderError";
}

/** JSON that keeps every Placeholder apart from any data. */
export function encodeValue(value: unknown): string {
  return JSON.stringify(toWire(value ?? null));
}

export function decodeValue(json: string): unknown {
  return JSON.parse(json, (_, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    if (Object.hasOwn(value, placeholderMarker)) {
      const [write, ...path] = (value as Record<string, unknown>)[
        placeholderMarker
      ] as [number, ...string[]];
      return new Placeholder(write, path);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key.startsWith("$$") ? key.slice(1) : key,
        field,
      ])
    );
  });
}

function toWire(value: unknown): unknown {
  if (value instanceof Placeholder) {
    return { [placeholderMarker]: [value.write, ...value.path] };
  }
  if (typeof value !== "object" || value === null) return value;
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === "function") return toWire(toJSON.call(value));
  if (Array.isArray(value)) return value.map(toWire);
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key.startsWith("$") ? `$${key}` : key,
      toWire(field),
    ])
  );
}
