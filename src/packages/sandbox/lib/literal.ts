// Constants a program exports as plain literals, read from its source
// without running it.
import ts from "typescript";

/**
 * The value of `export const <name> = <literal>` in the source, where the
 * literal is written like JSON: objects, arrays, strings, numbers, booleans
 * and null. Anything else, computed or missing, is an error.
 */
export function exportedLiteral(
  source: string,
  name: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const file = ts.createSourceFile(
    "program.ts",
    source,
    ts.ScriptTarget.Latest
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    const constant = statement.declarationList.flags & ts.NodeFlags.Const;
    if (!exported || !constant) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== name) continue;
      const value =
        declaration.initializer && literalValue(declaration.initializer);
      if (value === undefined) {
        return {
          ok: false,
          error: `${name} must be written as a literal value`,
        };
      }
      return { ok: true, value: value.value };
    }
  }
  return { ok: false, error: `the program does not export const ${name}` };
}

// Wrapped, so that a literal undefined is told apart from no literal.
function literalValue(node: ts.Expression): { value: unknown } | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return literalValue(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.text };
  }
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { value: -Number(node.operand.text) };
  }
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return { value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { value: false };
    case ts.SyntaxKind.NullKeyword:
      return { value: null };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = [];
    for (const element of node.elements) {
      const item = literalValue(element);
      if (item === undefined) return undefined;
      items.push(item.value);
    }
    return { value: items };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = property.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return undefined;
      const field = literalValue(property.initializer);
      if (field === undefined) return undefined;
      object[key.text] = field.value;
    }
    return { value: object };
  }
  return undefined;
}
