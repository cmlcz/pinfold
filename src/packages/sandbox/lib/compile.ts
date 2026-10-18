// Turns the agent's TypeScript into a script for the guest, and guest errors
// back into messages that point at lines of the agent's source.
import { SourceMap } from "node:module";
import { transformSync, type TransformFailure } from "esbuild";

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
  source: string
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

  const map = new SourceMap(JSON.parse(output.map));

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
        .map((frame) =>
          frame.replace(
            scriptPosition,
            (whole, line: string, column: string) => {
              const origin = map.findOrigin(Number(line), Number(column));
              return "lineNumber" in origin
                ? `${sourceFile}:${origin.lineNumber}:${origin.columnNumber}`
                : whole;
            }
          )
        );
      return [`${String(name ?? "Error")}: ${String(message)}`, ...frames].join(
        "\n"
      );
    },
  };
}

function describeCompileError(failure: TransformFailure): string {
  return failure.errors
    .map(({ text, location }) =>
      location
        ? `SyntaxError: ${text}\n    at ${sourceFile}:${location.line}:${location.column + 1}`
        : `SyntaxError: ${text}`
    )
    .join("\n");
}
