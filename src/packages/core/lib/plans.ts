// Write Plans awaiting or past Approval, kept in the git-ignored state
// directory .pinfold/. Each Approval request is its own record, so running
// the same code again never reopens a plan that was applied or failed.
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { decodeValue, encodeValue, type Clock } from "../../sandbox/index.ts";
import { openJournal } from "./journal.ts";
import type { WritePlan } from "./plan.ts";

export type PlanStatus =
  "pending" | "approved" | "declined" | "applying" | "applied" | "failed";

export type PlanRecord = WritePlan & {
  /** Identifies this Approval request, and the run it belongs to. */
  record: string;
  status: PlanStatus;
  /** Identifies the code and input whose run built the plan. */
  run: string;
  /** The clock the run saw, so a run after Approval rebuilds the same plan. */
  clock?: Clock;
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
  /** The record with that ID, which is also its run's ID. */
  get(record: string): Promise<PlanRecord | undefined>;
  /**
   * The approved plan built by a run of the same code and input, if it is
   * the newest decided record of that code and input.
   */
  approvedFor(run: string): Promise<PlanRecord | undefined>;
  /**
   * Adds a record of a Write Plan, pending or approved without the developer
   * for a run that needs no Approval. Returns it, or undefined if a run
   * adding one at the same time, in this process or another, got there first.
   */
  add(
    plan: WritePlan,
    run: string,
    clock: Clock,
    status: "pending" | "approved"
  ): Promise<PlanRecord | undefined>;
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
  async function planFiles(): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function scan(): Promise<{
    records: PlanRecord[];
    unreadable: string[];
  }> {
    const files = await planFiles();
    const declined = new Set(
      files.filter((file) => file.endsWith(".declined"))
    );
    const records: PlanRecord[] = [];
    const unreadable: string[] = [];
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      try {
        const record = decodeValue(
          await readFile(join(dir, name), "utf8")
        ) as PlanRecord;
        // A decline is final: its marker outranks whatever an Apply that was
        // running wrote to the record afterwards.
        if (declined.has(`${record.record}.declined`)) {
          record.status = "declined";
        }
        records.push(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        unreadable.push(join(dir, name));
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, unreadable };
  }

  const all = async () => (await scan()).records;

  // Written aside and moved into place, so no reader ever sees half a
  // record. A new record is linked, which fails if its file exists already.
  async function save(record: PlanRecord, options = { new: false }) {
    await mkdir(dir, { recursive: true });
    // Nothing in the state directory belongs in version control.
    await writeFile(join(state, ".gitignore"), "*\n");
    const file = join(dir, `${record.record}.json`);
    const aside = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(aside, `${encodeValue(record)}\n`);
    if (!options.new) return rename(aside, file);
    try {
      await link(aside, file);
    } finally {
      await rm(aside);
    }
  }

  // Creates a marker file only if it does not exist yet: the atomic step that
  // makes a decision or a claim happen once, across processes too.
  async function mark(
    record: PlanRecord,
    kind: "decided" | "claim" | "declined"
  ) {
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
    get: async (record) =>
      (await all()).find((candidate) => candidate.record === record),
    pending: async () =>
      (await all()).filter((record) => record.status === "pending"),
    unreadable: async () => (await scan()).unreadable,
    async approvedFor(run) {
      // Only the newest decided record counts: an approved plan that a later
      // plan replaced, applied or not, says nothing about the next run.
      const newest = (await all())
        .filter((record) => record.run === run && record.status !== "pending")
        .at(-1);
      return newest?.status === "approved" ? newest : undefined;
    },
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
      // taken so that no run can start applying the plan afterwards, and an
      // Apply already running stops before its next write.
      await mark(record, "decided");
      await mark(record, "claim");
      await mark(record, "declined");
      const journal = openJournal(root);
      try {
        journal.run(record.record).decline();
      } finally {
        journal.close();
      }
      const declined = { ...record, status: "declined" as const };
      await save(declined);
      return { ...declined, previous: record.status };
    },
    async add(plan, run, clock, status) {
      // Records of a plan are numbered, so two runs adding the next record at
      // once pick the same name and only one of them creates it.
      const files = await planFiles();
      const ordinal =
        files.filter(
          (file) => file.startsWith(`${plan.id}-`) && file.endsWith(".json")
        ).length + 1;
      const record: PlanRecord = {
        ...plan,
        record: `${plan.id}-${ordinal}`,
        status,
        run,
        clock,
        createdAt: new Date().toISOString(),
      };
      try {
        await save(record, { new: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return undefined;
      }
      return record;
    },
    async claim(record) {
      if (!(await mark(record, "claim"))) return false;
      await save({ ...record, status: "applying" });
      return true;
    },
    finish: (record, status) => save({ ...record, status }),
  };
}
