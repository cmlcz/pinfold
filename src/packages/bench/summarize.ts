// Merges benchmark results run in parallel, one directory per task, into
// one directory with a single summary:
//   node summarize.ts --out <dir> [--concurrent] <dir>...
// It joins their runs.jsonl, copies their transcripts and writes
// summary.md and provenance.json, with the first directory's provenance.
// --concurrent says the directories' runs went at the same time, and
// leaves wall times out of the summary.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatSummary, type RunRecord } from "./index.ts";

const { values, positionals } = parseArgs({
  options: {
    out: { type: "string" },
    concurrent: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
if (values.out === undefined || positionals.length === 0) {
  console.error("usage: node summarize.ts --out <dir> <dir>...");
  process.exit(2);
}

const records: RunRecord[] = [];
const stopped: string[] = [];
let provenance: Record<string, string> | undefined;
await mkdir(join(values.out, "transcripts"), { recursive: true });
for (const dir of positionals) {
  const lines = (await readFile(join(dir, "runs.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  records.push(...lines.map((line) => JSON.parse(line) as RunRecord));
  const { stopped: reason, ...rest } = JSON.parse(
    await readFile(join(dir, "provenance.json"), "utf8")
  ) as Record<string, string>;
  provenance ??= rest;
  if (reason !== undefined) stopped.push(`${dir}: ${reason}`);
  await cp(join(dir, "transcripts"), join(values.out, "transcripts"), {
    recursive: true,
  });
}
const merged = { ...provenance!, "Merged from": positionals.join(", ") };
await writeFile(
  join(values.out, "runs.jsonl"),
  records.map((record) => `${JSON.stringify(record)}\n`).join("")
);
await writeFile(
  join(values.out, "summary.md"),
  formatSummary(
    records,
    merged,
    stopped.length > 0 ? stopped.join("; ") : undefined,
    {
      wallTimes:
        !values.concurrent && (provenance?.["Runs at a time"] ?? "1") === "1",
    }
  )
);
await writeFile(
  join(values.out, "provenance.json"),
  `${JSON.stringify({ ...merged, ...(stopped.length > 0 && { stopped }) }, null, 2)}\n`
);
console.log(`${records.length} runs merged into ${values.out}`);
