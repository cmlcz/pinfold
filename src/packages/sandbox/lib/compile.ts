// Turns the agent's TypeScript into a script for the guest, and guest errors
// back into messages that point at lines of the agent's source.
import { SourceMap } from "node:module";
import { transformSync, type TransformFailure } from "esbuild";
import { typecheck } from "./typecheck.ts";

const sourceFile = "program.ts";
const scriptFile = "program.js";
const scriptPosition = /program\.js:(\d+):(\d+)/;

export type Compiled = {
  ok: true;
  /** A script that leaves the program's exports in `__program`. */
  code: string;
  filename: string;
  /** Describes a guest error with its stack mapped to the agent's source. */
  describe(error: unknown): string;
};

export function compile(
  source: string,
  declarations: string
): Compiled | { ok: false; error: string } {
  let output;
  try {
    output = transformSync(source, {
      loader: "ts",
      format: "iife",
      globalName: "__program",
      target: "es2023",
      sourcefile: sourceFile,
      sourcemap: "external",
    });
  } catch (error) {
    return {
      ok: false,
      error: describeCompileError(error as TransformFailure),
    };
  }
  const typeErrors = typecheck(source, declarations);
  if (typeErrors.length > 0) return { ok: false, error: typeErrors.join("\n") };

  const map = new SourceMap(JSON.parse(output.map));
  const toSourcePosition = (whole: string, line: string, column: string) => {
    const origin = map.findOrigin(Number(line), Number(column));
    if (!("lineNumber" in origin)) return whole;
    return `${sourceFile}:${origin.lineNumber}:${origin.columnNumber}`;
  };

  return {
    ok: true,
    code: output.code,
    filename: scriptFile,
    describe(error) {
      if (typeof error !== "object" || error === null) return String(error);
      const { name, message, stack } = error as Record<string, unknown>;
      const frames = String(stack ?? "")
        .split("\n")
        .filter((frame) => frame.includes(`(${scriptFile}:`))
        .map((frame) => frame.replace(scriptPosition, toSourcePosition));
      const header = `${String(name ?? "Error")}: ${String(message)}`;
      return [header, ...frames].join("\n");
    },
  };
}

function describeCompileError(failure: TransformFailure): string {
  return failure.errors
    .map(({ text, location }) => {
      if (!location) return `SyntaxError: ${text}`;
      const column = characterColumn(location.lineText, location.column) + 1;
      return `SyntaxError: ${text}\n    at ${sourceFile}:${location.line}:${column}`;
    })
    .join("\n");
}

// esbuild counts columns in UTF-8 bytes; the agent's editor counts characters,
// as type errors and stack frames do.
function characterColumn(lineText: string, byteColumn: number): number {
  return Buffer.from(lineText).subarray(0, byteColumn).toString().length;
}
