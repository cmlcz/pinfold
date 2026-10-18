/** A write a Drift Kit server actually received through one of its MCP Tools. */
export type ReceivedWrite = {
  tool: string;
  arguments: Record<string, unknown>;
};

/** The mutable state behind one Drift Kit server, restorable to its seed. */
export type World<State> = {
  readonly state: State;
  readonly receivedWrites: ReceivedWrite[];
  reset(): void;
};

export function createWorld<State>(seed: () => State): World<State> {
  const world = {
    state: seed(),
    receivedWrites: [] as ReceivedWrite[],
    reset() {
      world.state = seed();
      world.receivedWrites = [];
    },
  };
  return world;
}
