/** A host function the sandboxed program reaches as `sdk.<namespace>.<name>(args)`. */
export type HostFunction = (args: unknown) => Promise<unknown>;

export type Sdk = Record<string, Record<string, HostFunction>>;

/** Per-run limits. A run that exceeds one stops with a `LimitError`. */
export type Limits = {
  timeoutMs: number;
  memoryBytes: number;
  toolCalls: number;
};

/**
 * The time and randomness a run sees: `Date` stands still at `now`, and
 * `Math.random` draws from `seed`. A run given the same clock, input and Tool
 * results computes the same values.
 */
export type Clock = { now: number; seed: number };

export type Program = {
  /** TypeScript source that exports `main(input)`. */
  source: string;
  /** Declarations of `sdk` that the source must type-check against. */
  declarations: string;
  input: unknown;
  sdk: Sdk;
  limits: Limits;
  /** Absent, the run sees the host's time at its start and a fresh seed. */
  clock?: Clock;
};

export type SandboxResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Runs untrusted code with no host access except its `sdk`.
 * The runtime behind it is replaceable (ADR 0005).
 */
export type Sandbox = {
  run(program: Program): Promise<SandboxResult>;
};
