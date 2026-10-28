// The H2 Drift Scenario suite, with deterministic Repair alone:
//   node src/packages/bench/h2.ts grid   writes the scenario grid, to commit before any run
//   node src/packages/bench/h2.ts run    runs the committed grid and writes results to docs/results/
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  formatResults,
  generateGrid,
  runGrid,
  startBench,
  type GridScenario,
} from "./index.ts";

const gridFile = fileURLToPath(new URL("./h2-scenarios.json", import.meta.url));
const resultsDir = fileURLToPath(
  new URL("../../../docs/results/", import.meta.url)
);

const command = process.argv[2];
if (command !== "grid" && command !== "run") {
  console.error("usage: h2.ts grid|run");
  process.exit(2);
}

// No Repair Model, whatever the environment names: H2 measures
// deterministic Repair alone.
delete process.env.PINFOLD_REPAIR_MODEL;
const bench = await startBench();
try {
  if (command === "grid") {
    const grid = await generateGrid(bench);
    await writeFile(gridFile, `${JSON.stringify(grid, null, 2)}\n`);
    console.log(`${grid.length} scenarios written to ${gridFile}`);
  } else {
    const grid = JSON.parse(await readFile(gridFile, "utf8")) as GridScenario[];
    const results = await runGrid(bench, grid);
    const date = new Date().toISOString().slice(0, 10);
    const { version } = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8")
    ) as { version: string };
    const provenance = {
      "Measured on": date,
      Commit: execFileSync("git", ["rev-parse", "--short", "HEAD"])
        .toString()
        .trim(),
      pinfold: version,
      Node: process.version,
      "Repair Model": "none (deterministic Repair only)",
    };
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      `${resultsDir}h2-${date}.json`,
      `${JSON.stringify({ provenance, results }, null, 2)}\n`
    );
    const report = formatResults(results, provenance);
    await writeFile(`${resultsDir}h2-${date}.md`, report);
    console.log(report);
  }
} finally {
  await bench.close();
}
