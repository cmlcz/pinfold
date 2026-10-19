// The worker thread that type checks for checker.ts.
import { parentPort } from "node:worker_threads";
import { mainInputSchema } from "./signature.ts";
import { typecheck } from "./typecheck.ts";

parentPort!.on(
  "message",
  ({
    kind,
    source,
    declarations,
  }: {
    kind: string;
    source: string;
    declarations: string;
  }) => {
    const result =
      kind === "typecheck"
        ? typecheck(source, declarations)
        : mainInputSchema(source, declarations);
    parentPort!.postMessage(result);
  }
);
