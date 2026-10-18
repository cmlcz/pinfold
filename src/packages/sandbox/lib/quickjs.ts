// QuickJS compiled to WebAssembly (ADR 0005). Values cross the boundary as
// JSON strings, so the guest never holds a reference to a host object.
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type { Program, Sandbox, SandboxResult } from "./types.ts";
import { compile } from "./compile.ts";

// Deep enough for ordinary code, and well below the host's own stack, which
// unbounded guest recursion would otherwise overflow.
const stackBytes = 256 * 1024;

// Builds `globalThis.sdk` from [namespace, name] pairs around one host `call`,
// which stays out of the guest's reach.
const prelude = `(call, names) => {
  const sdk = {};
  for (const [namespace, name] of JSON.parse(names)) {
    sdk[namespace] ??= {};
    sdk[namespace][name] = (args) =>
      call(namespace, name, JSON.stringify(args ?? {})).then(JSON.parse);
  }
  globalThis.sdk = sdk;
}`;

const runner = `async (input) => {
  if (typeof __program.main !== "function") {
    throw new TypeError("the program must export a main(input) function");
  }
  return JSON.stringify({ value: await __program.main(JSON.parse(input)) });
}`;

export const quickJsSandbox: Sandbox = {
  async run(program) {
    const compiled = compile(program.source);
    if (!compiled.ok) return compiled;

    // A fresh module per run, so a fault inside one run cannot outlive it.
    const QuickJS = await newQuickJSWASMModule();
    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    const handles: QuickJSHandle[] = [];
    const pending = new Set<QuickJSDeferredPromise>();
    let finished = false;

    // A limit, once exceeded, stops the guest at its next instruction
    // (the interrupt cannot be caught) or, if it is idle, ends the run.
    const { limits } = program;
    let exceeded: string | undefined;
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new LimitExceeded());
    });
    stopped.catch(() => {});
    const exceed = (message: string) => {
      exceeded ??= message;
      stop();
    };
    const timeLimit = `the run exceeded its time limit of ${limits.timeoutMs} ms`;
    const deadline = Date.now() + limits.timeoutMs;
    const timer = setTimeout(() => exceed(timeLimit), limits.timeoutMs);
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) exceed(timeLimit);
      return exceeded !== undefined;
    });
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(stackBytes);
    let toolCalls = 0;

    // Settles a guest promise from the host, then resumes the guest.
    const settle = (
      deferred: QuickJSDeferredPromise,
      outcome: (vm: QuickJSContext) => void
    ) => {
      if (finished) return;
      outcome(vm);
      pending.delete(deferred);
      deferred.dispose();
      runtime.executePendingJobs().dispose();
    };

    const call = track(
      vm.newFunction("call", (...args) => {
        const [namespace, name, json] = args.map((h) => vm.getString(h));
        const deferred = vm.newPromise();
        pending.add(deferred);
        if (++toolCalls > limits.toolCalls) {
          exceed(
            `the run exceeded its limit of ${limits.toolCalls} Tool calls`
          );
          return deferred.handle;
        }
        callHost(program, namespace!, name!, json!).then(
          (value) =>
            settle(deferred, () =>
              withHandle(vm.newString(JSON.stringify(value ?? null)), (h) =>
                deferred.resolve(h)
              )
            ),
          (error: unknown) =>
            settle(deferred, () =>
              withHandle(vm.newError(messageOf(error)), (h) =>
                deferred.reject(h)
              )
            )
        );
        return deferred.handle;
      })
    );

    function track(handle: QuickJSHandle): QuickJSHandle {
      handles.push(handle);
      return handle;
    }

    function unwrap(
      result: ReturnType<QuickJSContext["evalCode"]>
    ): QuickJSHandle {
      if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw new GuestError(error);
      }
      return track(result.value);
    }

    try {
      const names = Object.entries(program.sdk).flatMap(([namespace, fns]) =>
        Object.keys(fns).map((name) => [namespace, name])
      );
      const install = unwrap(vm.evalCode(prelude, "pinfold:prelude"));
      unwrap(
        vm.callFunction(
          install,
          vm.undefined,
          call,
          track(vm.newString(JSON.stringify(names)))
        )
      );
      unwrap(vm.evalCode(compiled.code, compiled.filename));
      const run = unwrap(vm.evalCode(runner, "pinfold:runner"));
      const input = track(vm.newString(JSON.stringify(program.input ?? null)));
      const promise = unwrap(vm.callFunction(run, vm.undefined, input));

      const settled = vm.resolvePromise(promise);
      runtime.executePendingJobs().dispose();
      const json = unwrap(await Promise.race([settled, stopped]));
      if (exceeded !== undefined) return limitError(exceeded);
      return { ok: true, value: JSON.parse(vm.getString(json)).value };
    } catch (error) {
      if (exceeded !== undefined) return limitError(exceeded);
      if (error instanceof GuestError) {
        if (isOutOfMemory(error.value)) {
          return limitError(
            `the run exceeded its memory limit of ${limits.memoryBytes} bytes`
          );
        }
        return { ok: false, error: compiled.describe(error.value) };
      }
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      for (const deferred of pending) deferred.dispose();
      for (const handle of handles) handle.dispose();
      vm.dispose();
      runtime.dispose();
    }
  },
};

class LimitExceeded extends Error {}

class GuestError extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super("guest error");
    this.value = value;
  }
}

async function callHost(
  program: Program,
  namespace: string,
  name: string,
  json: string
): Promise<unknown> {
  const fn = program.sdk[namespace]?.[name];
  if (fn === undefined) throw new Error(`sdk.${namespace}.${name} is unknown`);
  return fn(JSON.parse(json));
}

function withHandle(handle: QuickJSHandle, use: (h: QuickJSHandle) => void) {
  try {
    use(handle);
  } finally {
    handle.dispose();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function limitError(message: string): SandboxResult {
  return { ok: false, error: `LimitError: ${message}` };
}

function isOutOfMemory(error: unknown): boolean {
  const { name, message } = (error ?? {}) as Record<string, unknown>;
  return name === "InternalError" && message === "out of memory";
}
