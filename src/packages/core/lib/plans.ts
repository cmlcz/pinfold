// Write Plans awaiting or past Approval, kept in the git-ignored state
// directory .pinfold/. Each Approval request is its own record, so running
// the same code again never reopens a plan that was applied or failed.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeValue, encodeValue } from "../../sandbox/index.ts";
import type { WritePlan } from "./plan.ts";

export type PlanStatus =
  "pending" | "approved" | "declined" | "applying" | "applied" | "failed";

export type PlanRecord = WritePlan & {
  record: string;
  status: PlanStatus;
  /** Identifies the code and input whose run built the plan. */
  run: string;
  createdAt: string;
};

/** What the developer does with Write Plans, from the terminal. */
export type Plans = {
  pending(): Promise<PlanRecord[]>;
  approve(id: string): Promise<PlanRecord>;
  decline(id: string): Promise<PlanRecord>;
};

export type PlanStore = Plans & {
  /** The newest record of a Write Plan. */
  latest(id: string): Promise<PlanRecord | undefined>;
  /** The latest approved plan built by a run of the same code and input. */
  approvedFor(run: string): Promise<PlanRecord | undefined>;
  addPending(plan: WritePlan, run: string): Promise<void>;
  /**
   * Takes an approved record for one Apply. Only the first claim of a record
   * ever succeeds, across processes too.
   */
  claim(record: PlanRecord): Promise<boolean>;
  finish(record: PlanRecord, status: "applied" | "failed"): Promise<void>;
};

export function openPlans(root: string): Plans {
  return openPlanStore(root);
}

export function openPlanStore(root: string): PlanStore {
  const state = join(root, ".pinfold");
  const dir = join(state, "plans");

  async function all(): Promise<PlanRecord[]> {
    const files = (await readOrNone(() => readdir(dir))) ?? [];
    const records = await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            decodeValue(await readFile(join(dir, name), "utf8")) as PlanRecord
        )
    );
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function save(record: PlanRecord): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Nothing in the state directory belongs in version control.
    await writeFile(join(state, ".gitignore"), "*\n");
    await writeFile(
      join(dir, `${record.record}.json`),
      `${encodeValue(record)}\n`
    );
  }

  async function latest(id: string) {
    return (await all()).filter((record) => record.id === id).at(-1);
  }

  async function decide(id: string, status: "approved" | "declined") {
    const record = await latest(id);
    if (record === undefined) throw new Error(`no Write Plan ${id}`);
    if (record.status !== "pending") {
      throw new Error(`Write Plan ${id} is ${record.status}, not pending`);
    }
    const decided = { ...record, status };
    await save(decided);
    return decided;
  }

  return {
    latest,
    pending: async () =>
      (await all()).filter((record) => record.status === "pending"),
    approvedFor: async (run) =>
      (await all())
        .filter((record) => record.run === run && record.status === "approved")
        .at(-1),
    approve: (id) => decide(id, "approved"),
    decline: (id) => decide(id, "declined"),
    async addPending(plan, run) {
      await save({
        ...plan,
        record: `${plan.id}-${randomUUID().slice(0, 8)}`,
        status: "pending",
        run,
        createdAt: new Date().toISOString(),
      });
    },
    async claim(record) {
      await mkdir(dir, { recursive: true });
      try {
        // The exclusive flag makes creating the claim file the atomic step.
        await writeFile(join(dir, `${record.record}.claim`), "", {
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      await save({ ...record, status: "applying" });
      return true;
    },
    finish: (record, status) => save({ ...record, status }),
  };
}

async function readOrNone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
