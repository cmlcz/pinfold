// Runs H2's changelog set, Drift ported from github/github-mcp-server's
// trims of its responses, with deterministic Repair alone and no model:
//   node changelog.ts
// It writes docs/results/h2-changelog-<date>.md and .json.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatChangelog, runChangelog } from "./index.ts";

const at = new Date().toISOString();
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
  Source:
    "github/github-mcp-server's convertToMinimal* functions, pkg/github/minimal_types.go",
};
// No Repair Model, whatever the environment names: H2 measures deterministic Repair.
delete process.env.PINFOLD_REPAIR_MODEL;
const results = await runChangelog();
const base = fileURLToPath(
  new URL(
    `../../../docs/results/h2-changelog-${at.slice(0, 10)}`,
    import.meta.url
  )
);
await writeFile(
  `${base}.json`,
  `${JSON.stringify({ provenance, results }, null, 2)}\n`
);
const report = formatChangelog(results, provenance);
await writeFile(`${base}.md`, report);
console.log(report);
