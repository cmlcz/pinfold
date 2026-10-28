// Runs the benchmark, which `pinfold bench` calls:
//   node bin.ts --model <id> --provider <slug> --budget <usd> [--pilot]
//     [--driver loop|claude-code|codex] [--tasks a,b] [--inputs 0,1,2]
//     [--arms A1,A2,A3,A4] [--repeats 3] [--out dir]
// The agent Arms A1 to A3 need OPENROUTER_API_KEY; the driver is the
// minimal agent loop by default. The pilot runs the first task chosen on
// its first input, three times per Arm, to estimate the cost of a run.
//   node bin.ts --lifecycle --model <id> --provider <slug> --budget <usd>
//     [--driver ...] [--arms A2,A3,A4] [--tasks <one>] [--runs 100]
//     [--parallel <n>] [--out dir]
// runs the lifecycle experiment on one task, triage-assign by default,
// with up to --parallel agent runs at a time.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import {
  claudeCodeDriver,
  codexDriver,
  formatLifecycle,
  lifecycleDrift,
  loopDriver,
  openRouterModel,
  servePinProxy,
  runBenchmark,
  runLifecycle,
  type GridScenario,
  startBench,
  tasks,
  type AgentArm,
  type ArmName,
  type Driver,
  type PinProxy,
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
    driver: { type: "string", default: "loop" },
    repeats: { type: "string", default: "3" },
    out: { type: "string" },
    lifecycle: { type: "boolean", default: false },
    runs: { type: "string", default: "100" },
    parallel: { type: "string", default: "1" },
  },
});

const arms = values.arms.split(",") as ArmName[];
if (!arms.every((arm) => ["A1", "A2", "A3", "A4"].includes(arm))) {
  fail("--arms takes A1, A2, A3 and A4");
}
const agentArms = arms.filter((arm): arm is AgentArm => arm !== "A4");
if (!["loop", "claude-code", "codex"].includes(values.driver)) {
  fail("--driver takes loop, claude-code or codex");
}
const budgetUsd = Number(values.budget);
if (!(budgetUsd >= 0)) fail("--budget <usd> is required");
const apiKey = process.env.OPENROUTER_API_KEY;
const pinned =
  values.model && values.provider && apiKey
    ? { model: values.model, provider: values.provider, apiKey }
    : undefined;
if ((agentArms.length > 0 || values.lifecycle) && pinned === undefined) {
  fail("the agent Arms need --model, --provider and OPENROUTER_API_KEY");
}
let proxy: PinProxy | undefined;
let driver: Driver | undefined;
if (pinned !== undefined) {
  if (values.driver === "loop") {
    driver = loopDriver(
      openRouterModel({ ...pinned, log: (line) => console.log(line) })
    );
  } else {
    proxy = await servePinProxy({
      provider: pinned.provider,
      log: (line) => console.log(line),
    });
    const make = values.driver === "codex" ? codexDriver : claudeCodeDriver;
    driver = await make({ ...pinned, proxy });
  }
}
const names = values.tasks?.split(",");
// The pilot runs the first task chosen.
const chosen = tasks
  .filter((task) => names === undefined || names.includes(task.name))
  .slice(0, values.pilot ? 1 : undefined);
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
  Driver: driver?.id ?? "none",
  "Repair Model": process.env.PINFOLD_REPAIR_MODEL ?? "none",
  "Budget cap (USD)": String(budgetUsd),
  Mode: values.pilot ? "pilot" : "full",
};

const bench = await startBench();
try {
  if (values.lifecycle) {
    const task =
      tasks.find(
        (candidate) => candidate.name === (names?.[0] ?? "triage-assign")
      ) ?? fail(`no task ${names?.[0]}`);
    const grid = JSON.parse(
      await readFile(new URL("./h2-scenarios.json", import.meta.url), "utf8")
    ) as GridScenario[];
    const runs = Number(values.runs);
    const result = await runLifecycle(bench, {
      task,
      input: 0,
      runs,
      drift: lifecycleDrift(grid, task, runs),
      driver: driver!,
      arms: agentArms,
      budgetUsd,
      parallel: Number(values.parallel),
      log: (line) => console.log(line),
    });
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, "lifecycle.json"),
      `${JSON.stringify({ provenance, ...result }, null, 2)}\n`
    );
    const report = formatLifecycle(result, provenance);
    await writeFile(join(out, "lifecycle.md"), report);
    console.log(report);
    if (result.stopped !== undefined) process.exitCode = 1;
  } else {
    const { records, stopped } = await runBenchmark(bench, {
      tasks: chosen,
      inputs: values.pilot
        ? [0]
        : (values.inputs?.split(",").map(Number) ?? [0, 1, 2]),
      arms,
      repeats: Number(values.repeats),
      ...(driver !== undefined && { driver }),
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
  }
} finally {
  await bench.close();
  await proxy?.close();
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
