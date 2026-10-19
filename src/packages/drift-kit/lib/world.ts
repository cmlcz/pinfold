/** A write a Drift Kit server actually received through one of its MCP Tools. */
export type ReceivedWrite = {
  tool: string;
  arguments: Record<string, unknown>;
};

/** The mutable state behind one Drift Kit server, restorable to its seed. */
export type World<State> = {
  readonly state: State;
  readonly receivedWrites: ReceivedWrite[];
  /**
   * Takes a write into the received-writes log, or returns false for a write
   * chosen to fail, which the server must then refuse without changing state.
   */
  receive(write: ReceivedWrite): boolean;
  /** Makes the `call`-th write from now on fail. */
  failWrite(call: number): void;
  reset(): void;
};

export function createWorld<State>(seed: () => State): World<State> {
  let attempts = 0;
  const failingAttempts = new Set<number>();
  const world = {
    state: seed(),
    receivedWrites: [] as ReceivedWrite[],
    receive(write: ReceivedWrite) {
      attempts += 1;
      if (failingAttempts.has(attempts)) {
        failingAttempts.delete(attempts);
        return false;
      }
      world.receivedWrites.push(write);
      return true;
    },
    failWrite(call: number) {
      failingAttempts.add(attempts + call);
    },
    reset() {
      world.state = seed();
      world.receivedWrites = [];
      attempts = 0;
      failingAttempts.clear();
    },
  };
  return world;
}
