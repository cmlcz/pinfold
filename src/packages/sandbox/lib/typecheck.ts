// Type-checks the agent's program against the SDK declarations, in memory.
import { basename } from "node:path";
import ts from "typescript";

const programFile = "/pinfold/program.ts";
const sdkFile = "/pinfold/sdk.d.ts";

// Plain strict mode. Turning off noImplicitAny would type `const xs = []` as
// never[] and break the most common way of collecting results.
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  types: [],
};

const defaultHost = ts.createCompilerHost(options);
// The standard library files never change, so parse them once. Only the files
// the configured library is built from are served: a triple-slash reference
// to another library, such as dom, finds nothing.
const libraryFiles = new Map(
  ts
    .createProgram([programFile], options, {
      ...defaultHost,
      getSourceFile: (fileName, languageVersion) =>
        fileName === programFile
          ? ts.createSourceFile(fileName, "", languageVersion)
          : defaultHost.getSourceFile(fileName, languageVersion),
    })
    .getSourceFiles()
    .filter((file) => file.fileName !== programFile)
    .map((file) => [file.fileName, file])
);

/** Error messages with positions in program.ts; empty when the program checks. */
export function typecheck(source: string, declarations: string): string[] {
  const program = checkedProgram(source, declarations);
  const errors = ts.getPreEmitDiagnostics(program).map(describeDiagnostic);
  return errors.length > 0 ? errors : placeholderConditions(program);
}

/**
 * Where a value typed as a Placeholder decides a condition, is compared, or
 * has its typeof taken. At run time a Placeholder cannot see any of these,
 * so a Plan would silently take one branch that Apply might not (#29).
 */
function placeholderConditions(
  program: ts.Program & { programFile: string }
): string[] {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(program.programFile)!;
  const found: string[] = [];
  const check = (expression: ts.Expression | undefined) => {
    if (expression === undefined) return;
    const type = checker.getTypeAtLocation(expression);
    const types = type.isUnion() ? type.types : [type];
    if (!types.some((member) => member.getProperty("__placeholder"))) return;
    const { line, character } = file.getLineAndCharacterOfPosition(
      expression.getStart(file)
    );
    found.push(
      `A Placeholder cannot decide a condition, be compared or have its typeof taken: its value is known only after Apply, so the Plan would take one branch blindly. Use it only as an argument to a Write Tool or in main's return value.\n    at program.ts:${line + 1}:${character + 1}`
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node)
    ) {
      check(node.expression);
    } else if (ts.isForStatement(node)) {
      check(node.condition);
    } else if (ts.isConditionalExpression(node)) {
      check(node.condition);
    } else if (ts.isTypeOfExpression(node)) {
      check(node.expression);
    } else if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      check(node.operand);
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (deciding.has(operator)) check(node.left);
      if (comparing.has(operator)) {
        check(node.left);
        check(node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(found)];
}

// Operators whose left operand decides what the expression yields.
const deciding = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const comparing = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** The program and the SDK, as the type checker sees them. */
export function checkedProgram(
  source: string,
  declarations: string
): ts.Program & { programFile: string } {
  const files = new Map([
    [
      programFile,
      ts.createSourceFile(programFile, source, ts.ScriptTarget.ES2023),
    ],
    [
      sdkFile,
      ts.createSourceFile(sdkFile, declarations, ts.ScriptTarget.ES2023),
    ],
  ]);
  // The program sees only itself, the SDK and the library, never the host's
  // files, so an import cannot reveal what a file on the host declares.
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName) =>
      files.get(fileName) ?? libraryFiles.get(fileName),
    fileExists: (fileName) => files.has(fileName),
    readFile: () => undefined,
    directoryExists: () => false,
    getDirectories: () => [],
    realpath: (path) => path,
    writeFile: () => {},
  };
  const program = ts.createProgram([programFile, sdkFile], options, host);
  return Object.assign(program, { programFile });
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  if (diagnostic.file === undefined || diagnostic.start === undefined)
    return message;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start
  );
  return `${message}\n    at ${basename(diagnostic.file.fileName)}:${line + 1}:${character + 1}`;
}
