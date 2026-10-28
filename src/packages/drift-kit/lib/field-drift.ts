// Field-level Drift Scenarios, named `<kind>:<tool>[:<path>]`, that change
// one Tool's responses in one place. Any field of any Tool can drift, so a
// grid of scenarios can be generated rather than hand-written.
//
//   rename:listIssues:issues[].count       count becomes issueCount
//   type-change:listIssues:issues[].count  128 becomes "128"
//   enum-change:listIssues:issues[].status unresolved becomes open
//   removed-field:getBlame:authorEmail     the field is gone
//   wrap:getBlame                          the response moves under data
//   pagination:listIssues                  its list comes 2 at a time
//
// A path names fields from the response's root, with [] for each element
// of an array.

export const fieldDriftKinds = [
  "rename",
  "type-change",
  "enum-change",
  "removed-field",
] as const;

export const responseDriftKinds = ["wrap", "pagination"] as const;

type FieldDrift = {
  kind: (typeof fieldDriftKinds)[number];
  tool: string;
  path: string[];
};
type ResponseDrift = {
  kind: (typeof responseDriftKinds)[number];
  tool: string;
};

/** A field-level scenario by its name, or undefined if it names none. */
export function parseFieldDrift(
  name: string
): FieldDrift | ResponseDrift | undefined {
  const [kind, tool, path, ...rest] = name.split(":");
  if (tool === undefined || tool === "" || rest.length > 0) return undefined;
  if ((responseDriftKinds as readonly string[]).includes(kind!)) {
    return path === undefined
      ? { kind: kind as ResponseDrift["kind"], tool }
      : undefined;
  }
  if (
    !(fieldDriftKinds as readonly string[]).includes(kind!) ||
    path === undefined ||
    !/^[A-Za-z_]\w*(\[\])?(\.[A-Za-z_]\w*(\[\])?)*$/.test(path)
  ) {
    return undefined;
  }
  return { kind: kind as FieldDrift["kind"], tool, path: path.split(".") };
}

/** A Tool's response as the field-level scenarios now on change it. */
export function applyFieldDrift(
  drift: ReadonlySet<string>,
  tool: string,
  output: Record<string, unknown>
): Record<string, unknown> {
  let response = output;
  // Fields first, then the response's shape, so paths name the original
  // shape whatever else is on.
  const scenarios = [...drift]
    .map(parseFieldDrift)
    .filter((scenario) => scenario?.tool === tool)
    .sort((a, b) => Number("path" in b!) - Number("path" in a!));
  for (const scenario of scenarios) {
    if (scenario === undefined) continue;
    if ("path" in scenario) {
      const { kind, path } = scenario;
      response = atPath(response, path, (parent, key) =>
        changeField(kind, parent, key, renamed(path))
      ) as Record<string, unknown>;
    } else if (scenario.kind === "wrap") {
      response = { data: response };
    } else {
      response = paged(response);
    }
  }
  return response;
}

/**
 * The new name of a renamed field: camelCase becomes snake_case, as when an
 * API moves to another convention; a one-word field of array elements takes
 * the element's noun, as `issues[].count` becomes `issueCount`; any other
 * one-word field gains a `Value` suffix.
 */
export function renamed(path: readonly string[]): string {
  const key = path.at(-1)!.replace("[]", "");
  if (/[a-z][A-Z]/.test(key)) {
    return key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  }
  const parent = path.at(-2);
  if (parent?.endsWith("[]")) {
    const noun = parent.slice(0, -2).replace(/s$/, "");
    return `${noun}${key[0]!.toUpperCase()}${key.slice(1)}`;
  }
  return `${key}Value`;
}

const enumChanges: Record<string, string> = {
  unresolved: "open",
  resolved: "closed",
  ignored: "muted",
  Todo: "Backlog",
  Done: "Completed",
};

// Changes one field of one object, in place on a copy of it.
function changeField(
  kind: FieldDrift["kind"],
  parent: Record<string, unknown>,
  key: string,
  newName: string
): Record<string, unknown> {
  if (!Object.hasOwn(parent, key)) return parent;
  const { [key]: value, ...rest } = parent;
  switch (kind) {
    case "rename":
      return { ...rest, [newName]: value };
    case "removed-field":
      return rest;
    case "type-change":
      return { ...parent, [key]: changedType(value) };
    case "enum-change":
      return {
        ...parent,
        [key]:
          typeof value === "string" ? (enumChanges[value] ?? value) : value,
      };
  }
}

// A number becomes text; an ISO date becomes epoch milliseconds.
function changedType(value: unknown): unknown {
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return Date.parse(value);
  }
  return value;
}

// Calls change on the object holding the last field of the path, in every
// element the path's arrays lead to. Returns a changed copy.
function atPath(
  value: unknown,
  path: readonly string[],
  change: (
    parent: Record<string, unknown>,
    key: string
  ) => Record<string, unknown>
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const object = value as Record<string, unknown>;
  const [step, ...rest] = path;
  const key = step!.replace("[]", "");
  if (rest.length === 0) {
    return step!.endsWith("[]") ? object : change(object, key);
  }
  if (!Object.hasOwn(object, key)) return object;
  const inner = object[key];
  const next = (item: unknown) => atPath(item, rest, change);
  return {
    ...object,
    [key]:
      step!.endsWith("[]") && Array.isArray(inner)
        ? inner.map(next)
        : next(inner),
  };
}

// The response's first array, two elements at a time.
function paged(output: Record<string, unknown>): Record<string, unknown> {
  const entry = Object.entries(output).find(([, value]) =>
    Array.isArray(value)
  );
  if (entry === undefined) return output;
  const [key, items] = entry as [string, unknown[]];
  const rest = { ...output };
  delete rest[key];
  return {
    ...rest,
    results: items.slice(0, 2),
    nextCursor: items.length > 2 ? "2" : null,
  };
}
