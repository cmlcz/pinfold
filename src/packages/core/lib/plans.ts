// Write Plans awaiting or past Approval, kept in the git-ignored state
// directory .pinfold/. Each Approval request is its own record, so running
// the same code again never reopens a plan that was applied or failed.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
  /** Plan files that could not be read, and so were left out. */
  unreadable(): Promise<string[]>;
  approve(id: string): Promise<PlanRecord>;
  /**
   * Declines a pending or approved plan so that no run sends it. A plan a
   * run was applying (`previous: "applying"`) may have sent some writes.
   */
  decline(id: string): Promise<PlanRecord & { previous: PlanStatus }>;
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

  // Files that do not parse are left out, so one damaged record cannot stop
  // every run. Leaving a record out never sends anything: at worst a plan
  // asks for Approval again.
  async function scan(): Promise<{
    records: PlanRecord[];
    unreadable: string[];
  }> {
    const files = (await readOrNone(() => readdir(dir))) ?? [];
    const records: PlanRecord[] = [];
    const unreadable: string[] = [];
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      try {
        records.push(
          decodeValue(await readFile(join(dir, name), "utf8")) as PlanRecord
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        unreadable.push(join(dir, name));
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, unreadable };
  }

  const all = async () => (await scan()).records;

  async function save(record: PlanRecord): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Nothing in the state directory belongs in version control.
    await writeFile(join(state, ".gitignore"), "*\n");
    // Written aside and renamed, so no reader ever sees half a record.
    const file = join(dir, `${record.record}.json`);
    const aside = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(aside, `${encodeValue(record)}\n`);
    await rename(aside, file);
  }

  // Creates a marker file only if it does not exist yet: the atomic step that
  // makes a decision or a claim happen once, across processes too.
  async function mark(record: PlanRecord, kind: "decided" | "claim") {
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, `${record.record}.${kind}`), "", {
        flag: "wx",
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async function latest(id: string) {
    return (await all()).filter((record) => record.id === id).at(-1);
  }

  async function find(id: string): Promise<PlanRecord> {
    const record = await latest(id);
    if (record === undefined) throw new Error(`no Write Plan ${id}`);
    return record;
  }

  return {
    latest,
    pending: async () =>
      (await all()).filter((record) => record.status === "pending"),
    unreadable: async () => (await scan()).unreadable,
    approvedFor: async (run) =>
      (await all())
        .filter((record) => record.run === run && record.status === "approved")
        .at(-1),
    async approve(id) {
      const record = await find(id);
      if (record.status !== "pending" || !(await mark(record, "decided"))) {
        const now = (await latest(id))?.status ?? record.status;
        throw new Error(
          `Write Plan ${id} is ${now === "pending" ? "decided" : now}, not pending`
        );
      }
      const approved = { ...record, status: "approved" as const };
      await save(approved);
      return approved;
    },
    async decline(id) {
      const record = await find(id);
      if (!["pending", "approved", "applying"].includes(record.status)) {
        throw new Error(
          `Write Plan ${id} is ${record.status}, not pending or approved`
        );
      }
      // Declining wins over any approval: the decision and the claim are
      // taken so that no run can start applying the plan afterwards.
      await mark(record, "decided");
      await mark(record, "claim");
      const declined = { ...record, status: "declined" as const };
      await save(declined);
      return { ...declined, previous: record.status };
    },
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
      if (!(await mark(record, "claim"))) return false;
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
