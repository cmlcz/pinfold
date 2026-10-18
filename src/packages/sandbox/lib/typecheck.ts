// Type-checks the agent's program against the SDK declarations, in memory.
import { basename } from "node:path";
import ts from "typescript";

const programFile = "/pinfold/program.ts";
const sdkFile = "/pinfold/sdk.d.ts";

// Strict, except that unannotated parameters stay allowed while exploring.
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noImplicitAny: false,
  noEmit: true,
  types: [],
};

const defaultHost = ts.createCompilerHost(options);
// The standard library files never change, so parse them once.
const libraryFiles = new Map<string, ts.SourceFile | undefined>();

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
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile(fileName, languageVersion) {
      const file = files.get(fileName);
      if (file) return file;
      if (!libraryFiles.has(fileName)) {
        libraryFiles.set(
          fileName,
          defaultHost.getSourceFile(fileName, languageVersion)
        );
      }
      return libraryFiles.get(fileName);
    },
    fileExists: (fileName) =>
      files.has(fileName) || defaultHost.fileExists(fileName),
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
