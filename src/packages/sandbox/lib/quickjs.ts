// QuickJS compiled to WebAssembly (ADR 0005). Values cross the boundary as
// JSON strings, so the guest never holds a reference to a host object.
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { randomInt } from "node:crypto";
import { compile } from "./compile.ts";
import {
  decodeValue,
  encodeValue,
  placeholderMarker,
  PlaceholderError,
} from "./placeholder.ts";
import type { FieldReads, Program, Sandbox } from "./types.ts";

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
//
// The prelude runs before the program, so it captures every built-in it
// relies on: a program that replaces Object, JSON or a prototype method
// cannot change how values are encoded, nor forge a Placeholder.
//
// Each Tool result reaches the program as a proxy that notes which of its
// fields the program reads, as paths like `issues[].count`. A field counts as
// read when the program gets it, including when a value holding it is passed
// to a Tool or returned.
//
// It also sets the run's clock: `Date` without arguments and `Date.now()`
// give the clock's time, and `Math.random` is a seeded generator (mulberry32).
const prelude = `(call, misuse, names, clock) => {
  const { now, seed } = JSON.parse(clock);
  const { apply, construct, get: reflectGet } = Reflect;
  const { imul } = Math;
  const DateType = Date;
  function FrozenDate(...args) {
    if (new.target === undefined) return new DateType(now).toString();
    return construct(DateType, args.length > 0 ? args : [now], new.target);
  }
  FrozenDate.prototype = DateType.prototype;
  FrozenDate.parse = DateType.parse;
  FrozenDate.UTC = DateType.UTC;
  FrozenDate.now = () => now;
  DateType.prototype.constructor = FrozenDate;
  globalThis.Date = FrozenDate;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const { create, defineProperty, hasOwn, keys } = Object;
  const { parse, stringify } = JSON;
  const { isArray } = Array;
  const ProxyType = Proxy;
  const ErrorType = Error;
  const TypeErrorType = TypeError;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const startsWith = String.prototype.startsWith;
  const slice = String.prototype.slice;
  const then = Promise.prototype.then;
  const marker = ${JSON.stringify(placeholderMarker)};
  const refs = new WeakMap();

  const define = (target, key, value) =>
    defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  const begins = (text, prefix) => apply(startsWith, text, [prefix]);
  const stack = () => new ErrorType().stack;

  const fail = (what) => {
    misuse(what, stack());
    throw new TypeErrorType("a Placeholder cannot be " + what);
  };
  const inspect = () => fail("inspected");
  const change = () => fail("changed");

  function placeholder(ref) {
    const proxy = new ProxyType(function () {}, {
      get(_, property) {
        if (property === "then") return undefined;
        if (typeof property === "symbol") fail("read, compared or formatted");
        const next = [];
        for (let i = 0; i < ref.length; i++) define(next, i, ref[i]);
        define(next, ref.length, property);
        return placeholder(next);
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
    apply(weakSet, refs, [proxy, ref]);
    return proxy;
  }

  // JSON text built by hand: JSON.stringify would look up toJSON on every
  // object it meets, and the program can change their prototypes. Only the
  // program's own values have their toJSON called, as JSON.stringify would.
  function wire(value) {
    const ref = apply(weakGet, refs, [value]);
    if (ref !== undefined) {
      return "{" + stringify(marker) + ":" + wireList(ref) + "}";
    }
    if (typeof value === "bigint") {
      throw new TypeErrorType("a BigInt cannot be passed as JSON");
    }
    if (typeof value !== "object" || value === null) return stringify(value);
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") return wire(apply(toJSON, value, []));
    if (isArray(value)) {
      let items = "";
      for (let i = 0; i < value.length; i++) {
        const item = wire(value[i]);
        items += (i > 0 ? "," : "") + (item === undefined ? "null" : item);
      }
      return "[" + items + "]";
    }
    let fields = "";
    const fieldNames = keys(value);
    for (let i = 0; i < fieldNames.length; i++) {
      const field = wire(value[fieldNames[i]]);
      if (field === undefined) continue;
      fields += (fields === "" ? "" : ",") + wireKey(fieldNames[i]) + ":" + field;
    }
    return "{" + fields + "}";
  }
  const wireKey = (name) => stringify(begins(name, "$") ? "$" + name : name);
  // A list of strings and numbers, which JSON.stringify writes without
  // looking up any toJSON.
  function wireList(items) {
    let text = "";
    for (let i = 0; i < items.length; i++) {
      text += (i > 0 ? "," : "") + stringify(items[i]);
    }
    return "[" + text + "]";
  }

  const decode = (json) =>
    parse(json, (_, value) => {
      if (typeof value !== "object" || value === null || isArray(value)) {
        return value;
      }
      if (hasOwn(value, marker)) return placeholder(value[marker]);
      const copy = {};
      const fields = keys(value);
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const key = begins(field, "$$") ? apply(slice, field, [1]) : field;
        define(copy, key, value[field]);
      }
      return copy;
    });

  const identifier = /^[A-Za-z_$][\\w$]*$/;
  const test = RegExp.prototype.test;
  const reads = create(null);
  const tracked = new WeakMap();
  const note = (tool, path) => {
    if (!hasOwn(reads, tool)) define(reads, tool, create(null));
    define(reads[tool], path, true);
  };
  const step = (path, key) => {
    if (!apply(test, identifier, [key])) {
      return path + "[" + stringify(key) + "]";
    }
    return path === "" ? key : path + "." + key;
  };

  function track(value, tool, path) {
    if (typeof value !== "object" || value === null) return value;
    if (apply(weakGet, refs, [value]) !== undefined) return value;
    const known = apply(weakGet, tracked, [value]);
    if (known !== undefined) return known;
    const list = isArray(value);
    const proxy = new ProxyType(value, {
      get(target, property, receiver) {
        const field = reflectGet(target, property, receiver);
        if (typeof property !== "string" || !hasOwn(target, property)) return field;
        if (list && property === "length") return field;
        const at = list ? path + "[]" : step(path, property);
        note(tool, at);
        return track(field, tool, at);
      },
    });
    apply(weakSet, tracked, [value, proxy]);
    return proxy;
  }

  const sdk = create(null);
  const pairs = parse(names);
  for (let i = 0; i < pairs.length; i++) {
    const namespace = pairs[i][0];
    const name = pairs[i][1];
    if (!hasOwn(sdk, namespace)) define(sdk, namespace, create(null));
    const tool = namespace + "." + name;
    define(sdk[namespace], name, (args) =>
      apply(then, call(namespace, name, wire(args ?? {}), stack()), [
        (json) => track(decode(json), tool, ""),
      ])
    );
  }
  globalThis.sdk = sdk;

  return async (input) => {
    if (typeof globalThis.__program?.main !== "function") {
      throw new TypeErrorType("the program must export a main(input) function");
    }
    const value = wire(await globalThis.__program.main(parse(input)));
    let readPaths = "";
    const tools = keys(reads);
    for (let i = 0; i < tools.length; i++) {
      const paths = wireList(keys(reads[tools[i]]));
      readPaths += (i > 0 ? "," : "") + wireKey(tools[i]) + ":" + paths;
    }
    return (
      "{" +
      (value === undefined ? "" : '"value":' + value + ",") +
      '"reads":{' + readPaths + "}}"
    );
  };
}`;

export const quickJsSandbox: Sandbox = {
  async run(program) {
    const compiled = await compile(program.source, program.declarations);
    if (!compiled.ok) return compiled;

    // A fresh module per run, so a fault inside one run cannot outlive it.
    const QuickJS = await newQuickJSWASMModule();
    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    const handles: QuickJSHandle[] = [];
    const pending = new Set<QuickJSDeferredPromise>();
    let finished = false;

    function track(handle: QuickJSHandle): QuickJSHandle {
      handles.push(handle);
      return handle;
    }

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
      try {
        outcome(vm);
        pending.delete(deferred);
        deferred.dispose();
        runtime.executePendingJobs().dispose();
      } catch (error) {
        // Thrown here, in a callback of the host's promise, the error would
        // reject nothing and crash the host, so it fails the run instead.
        fail(builtInOverflow(error) ?? `InternalError: ${messageOf(error)}`);
      }
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
          (value) => {
            let encoded: string;
            try {
              encoded = encodeValue(value);
            } catch (error) {
              settle(deferred, () =>
                withHandle(
                  vm.newError(
                    `the result of sdk.${namespace}.${name} cannot be passed to the program: ${messageOf(error)}`
                  ),
                  (h) => deferred.reject(h)
                )
              );
              return;
            }
            settle(deferred, () =>
              withHandle(vm.newString(encoded), (h) => deferred.resolve(h))
            );
          },
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
      const clock = program.clock ?? {
        now: Date.now(),
        seed: randomInt(2 ** 32),
      };
      const install = unwrap(vm.evalCode(prelude, "pinfold:prelude"));
      const runMain = unwrap(
        vm.callFunction(
          install,
          vm.undefined,
          call,
          reportMisuse,
          track(vm.newString(JSON.stringify(names))),
          track(vm.newString(JSON.stringify(clock)))
        )
      );
      unwrap(vm.evalCode(compiled.code, compiled.filename));
      const input = track(vm.newString(JSON.stringify(program.input ?? null)));
      const promise = unwrap(vm.callFunction(runMain, vm.undefined, input));

      const settled = vm.resolvePromise(promise);
      runtime.executePendingJobs().dispose();
      const json = unwrap(await Promise.race([settled, stopped]));
      if (Date.now() > deadline) exceed(timeLimit);
      const error = failed();
      if (error !== undefined) return { ok: false, error };
      const { value, reads } = decodeValue(vm.getString(json)) as {
        value: unknown;
        reads: FieldReads;
      };
      return { ok: true, value, reads };
    } catch (error) {
      if (error instanceof GuestError && isOutOfMemory(error.value)) {
        exceed(`its memory limit of ${limits.memoryBytes} bytes`);
      }
      const reason = failed();
      if (reason !== undefined) return { ok: false, error: reason };
      if (error instanceof GuestError) {
        return { ok: false, error: compiled.describe(error.value) };
      }
      const overflow = builtInOverflow(error);
      if (overflow !== undefined) return { ok: false, error: overflow };
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      for (const deferred of pending) deferred.dispose();
      try {
        for (const handle of handles) handle.dispose();
        vm.dispose();
        runtime.dispose();
      } catch {
        // A stack overflow inside a QuickJS built-in can leave the module
        // aborted. The module belongs to this run alone and is dropped here.
      }
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
  const tools = Object.hasOwn(program.sdk, namespace)
    ? program.sdk[namespace]
    : undefined;
  const fn = tools && Object.hasOwn(tools, name) ? tools[name] : undefined;
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

// Deep recursion inside a QuickJS built-in (JSON.stringify of a deeply
// nested value, say) exhausts the WebAssembly stack before QuickJS's own
// stack limit sees it.
function builtInOverflow(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    (error instanceof RangeError || error.name === "RuntimeError")
  ) {
    return `InternalError: the program exhausted the stack inside a built-in function (${error.message})`;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOutOfMemory(error: unknown): boolean {
  const { name, message } = (error ?? {}) as Record<string, unknown>;
  return name === "InternalError" && message === "out of memory";
}
