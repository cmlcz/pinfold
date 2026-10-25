// The input a program's main takes, as a JSON Schema, from its type.
import ts from "typescript";
import { checkedProgram } from "./typecheck.ts";

/**
 * A JSON Schema, with the keywords pinfold walks typed. Where a schema may
 * stand inside one, `true` allows every value and `false` none. Schemas from
 * Downstream Servers are not checked against this type, so code that walks
 * one still checks that a keyword's value is an array before it iterates.
 */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema | boolean>;
  required?: string[];
  patternProperties?: Record<string, JsonSchema | boolean>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema | boolean;
  prefixItems?: (JsonSchema | boolean)[];
  anyOf?: (JsonSchema | boolean)[];
  oneOf?: (JsonSchema | boolean)[];
  allOf?: (JsonSchema | boolean)[];
  enum?: unknown[];
  [keyword: string]: unknown;
};

/**
 * The JSON Schema of the input that the program's exported `main` takes, or
 * why it has none: `main` is missing, or its input is untyped, `any` or
 * `unknown`. A `main` without parameters takes an empty object.
 */
export function mainInputSchema(
  source: string,
  declarations: string
): { ok: true; schema: JsonSchema } | { ok: false; error: string } {
  const program = checkedProgram(source, declarations);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(program.programFile)!;
  const moduleSymbol = checker.getSymbolAtLocation(file);
  const main =
    moduleSymbol && checker.tryGetMemberInModuleExports("main", moduleSymbol);
  if (main === undefined) {
    return { ok: false, error: "the program does not export main" };
  }
  const signatures = checker
    .getTypeOfSymbolAtLocation(main, file)
    .getCallSignatures();
  if (signatures.length !== 1) {
    return { ok: false, error: "main must be a function with one signature" };
  }
  const [input, ...rest] = signatures[0]!.getParameters();
  if (rest.length > 0) {
    return { ok: false, error: "main must take at most one parameter, input" };
  }
  if (input === undefined) {
    return {
      ok: true,
      schema: { type: "object", properties: {}, additionalProperties: false },
    };
  }
  const declaration = input.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isParameter(declaration) ||
    declaration.type === undefined
  ) {
    return { ok: false, error: "main's input has no type annotation" };
  }
  const type = checker.getTypeAtLocation(declaration.type);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return { ok: false, error: "main's input is typed any or unknown" };
  }
  try {
    const walk = { checker, expanding: new Set<ts.Type>(), nodes: 0 };
    return { ok: true, schema: schemaOf(walk, type) };
  } catch (error) {
    if (!(error instanceof UncheckableType)) throw error;
    return { ok: false, error: error.message };
  }
}

// Covers the types an input is written with: primitives, literals, unions,
// intersections, arrays, tuples and object types. `any` and `unknown` accept
// any value, and so does a type where it refers back to itself. Any other
// type cannot be checked, and the input is refused rather than accepted
// unchecked.
const maxNodes = 10_000;
/** The keys of a number index signature, as a patternProperties pattern. */
export const numberKeyPattern = "^-?\\d+(\\.\\d+)?$";

class UncheckableType extends Error {}

type Walk = {
  checker: ts.TypeChecker;
  /** The object types being expanded, outermost first. */
  expanding: Set<ts.Type>;
  nodes: number;
};

function schemaOf(walk: Walk, type: ts.Type): JsonSchema {
  const { checker } = walk;
  if (++walk.nodes > maxNodes) {
    throw new UncheckableType("main's input type is too large to check");
  }
  const { flags } = type;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
  if (flags & ts.TypeFlags.StringLiteral)
    return { const: (type as ts.StringLiteralType).value };
  if (flags & ts.TypeFlags.NumberLiteral)
    return { const: (type as ts.NumberLiteralType).value };
  if (flags & ts.TypeFlags.BooleanLiteral)
    return { const: checker.typeToString(type) === "true" };
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) {
    return { type: "string" };
  }
  if (flags & ts.TypeFlags.Number) return { type: "number" };
  if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (flags & ts.TypeFlags.Null) return { type: "null" };
  if (flags & ts.TypeFlags.NonPrimitive) return { type: "object" };
  if (type.isUnion()) return unionSchema(walk, type);
  if (!(flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) {
    throw new UncheckableType(
      `main's input uses the type ${checker.typeToString(type)}, which cannot be checked`
    );
  }
  // A type met again inside itself, as in a tree, accepts any value there.
  if (walk.expanding.has(type)) return {};
  walk.expanding.add(type);
  try {
    return objectSchema(walk, type);
  } finally {
    walk.expanding.delete(type);
  }
}

function objectSchema(walk: Walk, type: ts.Type): JsonSchema {
  const { checker } = walk;
  if (checker.isTupleType(type))
    return tupleSchema(walk, type as ts.TupleTypeReference);
  if (checker.isArrayType(type)) {
    const [item] = checker.getTypeArguments(type as ts.TypeReference);
    return { type: "array", items: item ? schemaOf(walk, item) : {} };
  }
  if (type.getCallSignatures().length > 0) {
    throw new UncheckableType(
      `main's input uses the function type ${checker.typeToString(type)}, which JSON cannot hold`
    );
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    // A schema with such a field would check it as the object's prototype.
    if (property.name === "__proto__") {
      throw new UncheckableType(
        "main's input has a field named __proto__, which cannot be checked"
      );
    }
    properties[property.name] = schemaOf(
      walk,
      checker.getTypeOfSymbol(property)
    );
    if (!(property.flags & ts.SymbolFlags.Optional))
      required.push(property.name);
  }
  const values = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  // JSON keys are strings: a number index takes the keys that spell numbers.
  const numbered = values
    ? undefined
    : checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return {
    type: "object",
    properties,
    required,
    ...(numbered
      ? { patternProperties: { [numberKeyPattern]: schemaOf(walk, numbered) } }
      : {}),
    additionalProperties: values ? schemaOf(walk, values) : false,
  };
}

function tupleSchema(walk: Walk, tuple: ts.TupleTypeReference): JsonSchema {
  const elements = walk.checker.getTypeArguments(tuple);
  const { elementFlags } = tuple.target;
  const prefixItems: JsonSchema[] = [];
  let rest: JsonSchema | false = false;
  let minItems = 0;
  for (const [index, element] of elements.entries()) {
    const flags = elementFlags[index]!;
    if (flags & ts.ElementFlags.Variable) {
      rest = schemaOf(walk, element);
      continue;
    }
    if (rest !== false) {
      throw new UncheckableType(
        "main's input uses a tuple with elements after its rest element, which cannot be checked"
      );
    }
    prefixItems.push(schemaOf(walk, element));
    if (flags & ts.ElementFlags.Required) minItems = prefixItems.length;
  }
  return {
    type: "array",
    prefixItems,
    items: rest,
    minItems,
    ...(rest === false ? { maxItems: prefixItems.length } : {}),
  };
}

function unionSchema(walk: Walk, union: ts.UnionType): JsonSchema {
  // An optional field's type includes undefined, which JSON cannot hold.
  const options = union.types.filter(
    (option) => !(option.flags & ts.TypeFlags.Undefined)
  );
  if (options.length === 1) return schemaOf(walk, options[0]!);
  // TypeScript spells boolean as true | false.
  const booleans = options.filter(
    (option) => option.flags & ts.TypeFlags.BooleanLiteral
  );
  const others =
    booleans.length === 2
      ? options.filter((option) => !booleans.includes(option))
      : options;
  const schemas = others.map((option) => schemaOf(walk, option));
  if (booleans.length === 2) schemas.push({ type: "boolean" });
  if (schemas.length === 1) return schemas[0]!;
  if (schemas.every((schema) => "const" in schema)) {
    return { enum: schemas.map((schema) => schema.const) };
  }
  return { anyOf: schemas };
}
