import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateGrid, startBench, type GridScenario } from "../index.ts";

describe("the H2 scenario grid", () => {
  // H2's scenario set is fixed before any run: a change to the tasks or the
  // Drift Kit that changes the grid must regenerate and commit it.
  it("is the committed one, regenerated from what the tasks read", async () => {
    const committed = JSON.parse(
      await readFile(new URL("../h2-scenarios.json", import.meta.url), "utf8")
    ) as GridScenario[];
    const bench = await startBench();
    try {
      expect(await generateGrid(bench)).toEqual(committed);
    } finally {
      await bench.close();
    }
  });
});
