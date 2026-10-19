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
  return ts.getPreEmitDiagnostics(program).map(describeDiagnostic);
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
