// Type checks run in a worker thread, one at a time: a program that keeps the
// checker busy holds up neither the host nor its other requests, and is cut
// off at a time limit. (A heap limit on the worker is no help: when the
// checker reaches it, V8 aborts the whole process.)
import { Worker } from "node:worker_threads";
import type { JsonSchema } from "./signature.ts";

const checkTimeoutMs = 10_000;

type InputSchema =
  { ok: true; schema: JsonSchema } | { ok: false; error: string };
type Outcome = { ok: true; result: unknown } | { ok: false; error: string };

let worker: Worker | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Error messages with positions in program.ts; empty when the program checks. */
export async function typecheck(
  source: string,
  declarations: string
): Promise<string[]> {
  const outcome = await check("typecheck", source, declarations);
  return outcome.ok ? (outcome.result as string[]) : [outcome.error];
}

/**
 * The JSON Schema of the input that the program's exported `main` takes, or
 * why it has none.
 */
export async function mainInputSchema(
  source: string,
  declarations: string
): Promise<InputSchema> {
  const outcome = await check("mainInputSchema", source, declarations);
  return outcome.ok ? (outcome.result as InputSchema) : outcome;
}

function check(
  kind: "typecheck" | "mainInputSchema",
  source: string,
  declarations: string
): Promise<Outcome> {
  const next = queue.then(() => inWorker(kind, source, declarations));
  // A check that failed to start must not hold up the ones after it.
  queue = next.catch(() => {});
  return next;
}

function inWorker(
  kind: "typecheck" | "mainInputSchema",
  source: string,
  declarations: string
): Promise<Outcome> {
  const current = (worker ??= new Worker(
    new URL("./check-worker.ts", import.meta.url)
  ));
  return new Promise((resolve) => {
    // A worker that ran over or failed is dropped; the next check gets a new one.
    const fail = (error: string) => {
      done();
      if (worker === current) worker = undefined;
      void current.terminate();
      resolve({ ok: false, error });
    };
    const timer = setTimeout(
      () =>
        fail(
          `TypeCheckError: the type check exceeded its time limit of ${checkTimeoutMs} ms`
        ),
      checkTimeoutMs
    );
    const onMessage = (result: unknown) => {
      done();
      resolve({ ok: true, result });
    };
    const onError = (error: Error) =>
      fail(`TypeCheckError: the type check failed: ${error.message}`);
    function done() {
      clearTimeout(timer);
      current.off("message", onMessage);
      current.off("error", onError);
      // An idle worker does not keep the host running.
      current.unref();
    }
    current.on("message", onMessage);
    current.on("error", onError);
    current.ref();
    current.postMessage({ kind, source, declarations });
  });
}
