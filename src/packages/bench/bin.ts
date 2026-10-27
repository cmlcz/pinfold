// Runs the benchmark, which `pinfold bench` calls:
//   node bin.ts --model <id> --provider <slug> --budget <usd> [--pilot]
//     [--tasks a,b] [--inputs 0,1,2] [--arms A2,A4] [--repeats 3] [--out dir]
// A2 needs OPENROUTER_API_KEY. The pilot runs one task on its first input,
// three times per Arm, to estimate the cost of a run.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  openRouterModel,
  runBenchmark,
  startBench,
  tasks,
  type ArmName,
} from "./index.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    provider: { type: "string" },
    budget: { type: "string" },
    pilot: { type: "boolean", default: false },
    tasks: { type: "string" },
    inputs: { type: "string" },
    arms: { type: "string", default: "A2,A4" },
    repeats: { type: "string", default: "3" },
    out: { type: "string" },
  },
});

const arms = values.arms.split(",") as ArmName[];
if (!arms.every((arm) => arm === "A2" || arm === "A4")) {
  fail("--arms takes A2 and A4");
}
const budgetUsd = Number(values.budget);
if (!(budgetUsd >= 0)) fail("--budget <usd> is required");
const apiKey = process.env.OPENROUTER_API_KEY;
const model =
  values.model && values.provider && apiKey
    ? openRouterModel({
        model: values.model,
        provider: values.provider,
        apiKey,
      })
    : undefined;
if (arms.includes("A2") && model === undefined) {
  fail("A2 needs --model, --provider and OPENROUTER_API_KEY");
}
const names = values.tasks?.split(",");
const chosen = values.pilot
  ? tasks.slice(0, 1)
  : tasks.filter((task) => names === undefined || names.includes(task.name));
if (chosen.length === 0)
  fail(`no task among ${tasks.map((task) => task.name).join(", ")}`);

const at = new Date().toISOString();
const out =
  values.out ?? join("bench-results", at.replaceAll(":", "-").slice(0, 19));
const { version } = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8")
) as { version: string };
const provenance = {
  "Measured on": at,
  Commit: execFileSync("git", ["rev-parse", "--short", "HEAD"])
    .toString()
    .trim(),
  pinfold: version,
  Node: process.version,
  Model: model?.id ?? "none",
  "Budget cap (USD)": String(budgetUsd),
  Mode: values.pilot ? "pilot" : "full",
};

const bench = await startBench();
try {
  const { records, stopped } = await runBenchmark(bench, {
    tasks: chosen,
    inputs: values.pilot
      ? [0]
      : (values.inputs?.split(",").map(Number) ?? [0, 1, 2]),
    arms,
    repeats: Number(values.repeats),
    ...(model !== undefined && { model }),
    budgetUsd,
    out,
    provenance,
    log: (line) => console.log(line),
  });
  const spent = records.reduce((sum, record) => sum + record.usage.cost, 0);
  console.log(
    `${records.length} runs, $${spent.toFixed(4)} spent. Results in ${out}`
  );
  if (stopped !== undefined) {
    console.log(`Stopped early: ${stopped}`);
    process.exitCode = 1;
  }
} finally {
  await bench.close();
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
