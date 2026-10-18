// QuickJS compiled to WebAssembly (ADR 0005). Values cross the boundary as
// JSON strings, so the guest never holds a reference to a host object.
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { compile } from "./compile.ts";
import {
  decodeValue,
  encodeValue,
  placeholderMarker,
  PlaceholderError,
} from "./placeholder.ts";
import type { Program, Sandbox } from "./types.ts";

// Deep enough for ordinary code, and well below the host's own stack, which
// unbounded guest recursion would otherwise overflow.
const stackBytes = 256 * 1024;

// Installs `globalThis.sdk` around the host's `call` and `misuse`, which stay
// out of the guest's reach, and returns the function that runs `main`.
//
// A Placeholder is a proxy: reaching into it (`ticket.id`) gives another
// Placeholder, and any attempt to look at or call its value reports misuse.
// No proxy can see strict equality, truthiness or typeof. Values are encoded
// as in ./placeholder.ts.
const prelude = `(call, misuse, names) => {
  const marker = ${JSON.stringify(placeholderMarker)};
  const refs = new WeakMap();

  const fail = (what) => {
    misuse(what, new Error().stack);
    throw new TypeError("a Placeholder cannot be " + what);
  };
  const inspect = () => fail("inspected");
  const change = () => fail("changed");

  function placeholder(ref) {
    const proxy = new Proxy(function () {}, {
      get(_, property) {
        if (property === "then") return undefined;
        if (typeof property === "symbol") fail("read, compared or formatted");
        return placeholder([...ref, property]);
      },
      apply: () => fail("called"),
      construct: () => fail("called"),
      has: inspect,
      ownKeys: inspect,
      getOwnPropertyDescriptor: inspect,
      getPrototypeOf: inspect,
      set: change,
      defineProperty: change,
      deleteProperty: change,
      setPrototypeOf: change,
    });
    refs.set(proxy, ref);
    return proxy;
  }

  function encode(value) {
    const ref = refs.get(value);
    if (ref) return { [marker]: ref };
    if (typeof value !== "object" || value === null) return value;
    if (typeof value.toJSON === "function") return encode(value.toJSON());
    if (Array.isArray(value)) return value.map(encode);
    return Object.fromEntries(
      Object.keys(value).map((field) => [
        field.startsWith("$") ? "$" + field : field,
        encode(value[field]),
      ])
    );
  }

  const decode = (json) =>
    JSON.parse(json, (_, value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
      }
      if (Object.hasOwn(value, marker)) return placeholder(value[marker]);
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field.startsWith("$$") ? field.slice(1) : field,
          item,
        ])
      );
    });

  const sdk = {};
  for (const [namespace, name] of JSON.parse(names)) {
    sdk[namespace] ??= {};
    sdk[namespace][name] = (args) =>
      call(namespace, name, JSON.stringify(encode(args ?? {})), new Error().stack)
        .then(decode);
  }
  globalThis.sdk = sdk;

  return async (input) => {
    if (typeof globalThis.__program?.main !== "function") {
      throw new TypeError("the program must export a main(input) function");
    }
    const value = await globalThis.__program.main(JSON.parse(input));
    return JSON.stringify({ value: encode(value) });
  };
}`;

export const quickJsSandbox: Sandbox = {
  async run(program) {
    const compiled = compile(program.source, program.declarations);
    if (!compiled.ok) return compiled;

    // A fresh module per run, so a fault inside one run cannot outlive it.
    const QuickJS = await newQuickJSWASMModule();
    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    const handles: QuickJSHandle[] = [];
    const pending = new Set<QuickJSDeferredPromise>();
    let finished = false;

    // A failure stops the guest at its next instruction (the interrupt cannot
    // be caught) or, if it is idle, ends the run.
    const { limits } = program;
    let failure: string | undefined;
    let stop!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("run stopped"));
    });
    stopped.catch(() => {});
    const fail = (message: string) => {
      failure ??= message;
      stop();
    };
    const exceed = (limit: string) =>
      fail(`LimitError: the run exceeded ${limit}`);
    const timeLimit = `its time limit of ${limits.timeoutMs} ms`;
    const deadline = Date.now() + limits.timeoutMs;
    const timer = setTimeout(() => exceed(timeLimit), limits.timeoutMs);
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) exceed(timeLimit);
      return failure !== undefined;
    });
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(stackBytes);
    let toolCalls = 0;

    const placeholderError = (message: string, stack: string) =>
      compiled.describe({ name: "PlaceholderError", message, stack });
    // Misuse inside a Proxy trap is only recorded: interrupting the guest
    // there leaks QuickJS memory. The run fails when it ends, and the next
    // Tool call stops it.
    let misused: string | undefined;
    const misuse = (message: string, stack: string) => {
      misused ??= placeholderError(message, stack);
    };
    // Misuse comes first: whatever followed it was the program's reaction.
    const failed = () => misused ?? failure;

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
        const [namespace, name, json, stack] = args.map((h) => vm.getString(h));
        const deferred = vm.newPromise();
        pending.add(deferred);
        if (misused !== undefined) {
          fail(misused);
          return deferred.handle;
        }
        if (++toolCalls > limits.toolCalls) {
          exceed(`its limit of ${limits.toolCalls} Tool calls`);
          return deferred.handle;
        }
        callHost(program, namespace!, name!, json!).then(
          (value) =>
            settle(deferred, () =>
              withHandle(vm.newString(encodeValue(value)), (h) =>
                deferred.resolve(h)
              )
            ),
          (error: unknown) => {
            if (error instanceof PlaceholderError) {
              fail(placeholderError(error.message, stack!));
              return;
            }
            settle(deferred, () =>
              withHandle(vm.newError(messageOf(error)), (h) =>
                deferred.reject(h)
              )
            );
          }
        );
        return deferred.handle;
      })
    );

    const reportMisuse = track(
      vm.newFunction("misuse", (what, stack) => {
        misuse(
          `a Placeholder cannot be ${vm.getString(what)} during a Plan; pass it to a Write Tool or return it`,
          vm.getString(stack)
        );
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
      const run = unwrap(
        vm.callFunction(
          install,
          vm.undefined,
          call,
          reportMisuse,
          track(vm.newString(JSON.stringify(names)))
        )
      );
      unwrap(vm.evalCode(compiled.code, compiled.filename));
      const input = track(vm.newString(JSON.stringify(program.input ?? null)));
      const promise = unwrap(vm.callFunction(run, vm.undefined, input));

      const settled = vm.resolvePromise(promise);
      runtime.executePendingJobs().dispose();
      const json = unwrap(await Promise.race([settled, stopped]));
      const error = failed();
      if (error !== undefined) return { ok: false, error };
      const { value } = decodeValue(vm.getString(json)) as { value: unknown };
      return { ok: true, value };
    } catch (error) {
      if (error instanceof GuestError && isOutOfMemory(error.value)) {
        exceed(`its memory limit of ${limits.memoryBytes} bytes`);
      }
      const reason = failed();
      if (reason !== undefined) return { ok: false, error: reason };
      if (error instanceof GuestError) {
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
  return fn(decodeValue(json));
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

function isOutOfMemory(error: unknown): boolean {
  const { name, message } = (error ?? {}) as Record<string, unknown>;
  return name === "InternalError" && message === "out of memory";
}
