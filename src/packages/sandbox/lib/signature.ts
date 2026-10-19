// The input a program's main takes, as a JSON Schema, from its type.
import ts from "typescript";
import { checkedProgram } from "./typecheck.ts";

export type JsonSchema = Record<string, unknown>;

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
  const module = checker.getSymbolAtLocation(file);
  const main = module && checker.tryGetMemberInModuleExports("main", module);
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
  return { ok: true, schema: schemaOf(checker, type, 0) };
}

// Covers the types an input is written with: primitives, literals, unions,
// arrays and object types. Anything else, or anything nested too deeply,
// accepts any value.
function schemaOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number
): JsonSchema {
  if (depth > 16) return {};
  const { flags } = type;
  if (flags & ts.TypeFlags.StringLiteral)
    return { const: (type as ts.StringLiteralType).value };
  if (flags & ts.TypeFlags.NumberLiteral)
    return { const: (type as ts.NumberLiteralType).value };
  if (flags & ts.TypeFlags.BooleanLiteral)
    return { const: checker.typeToString(type) === "true" };
  if (flags & ts.TypeFlags.String) return { type: "string" };
  if (flags & ts.TypeFlags.Number) return { type: "number" };
  if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (flags & ts.TypeFlags.Null) return { type: "null" };
  if (type.isUnion()) {
    // An optional field's type includes undefined, which JSON cannot hold.
    const options = type.types.filter(
      (option) => !(option.flags & ts.TypeFlags.Undefined)
    );
    if (options.length === 1) return schemaOf(checker, options[0]!, depth + 1);
    // TypeScript spells boolean as true | false.
    const booleans = options.filter(
      (option) => option.flags & ts.TypeFlags.BooleanLiteral
    );
    const schemas = options
      .filter((option) => booleans.length !== 2 || !booleans.includes(option))
      .map((option) => schemaOf(checker, option, depth + 1));
    if (booleans.length === 2) schemas.push({ type: "boolean" });
    if (schemas.length === 1) return schemas[0]!;
    if (schemas.every((schema) => "const" in schema)) {
      return { enum: schemas.map((schema) => schema.const) };
    }
    return { anyOf: schemas };
  }
  if (checker.isArrayType(type)) {
    const [item] = checker.getTypeArguments(type as ts.TypeReference);
    return {
      type: "array",
      items: item ? schemaOf(checker, item, depth + 1) : {},
    };
  }
  if (flags & ts.TypeFlags.Object) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      properties[property.name] = schemaOf(
        checker,
        checker.getTypeOfSymbol(property),
        depth + 1
      );
      if (!(property.flags & ts.SymbolFlags.Optional))
        required.push(property.name);
    }
    const values = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return {
      type: "object",
      properties,
      required,
      additionalProperties: values
        ? schemaOf(checker, values, depth + 1)
        : false,
    };
  }
  return {};
}
