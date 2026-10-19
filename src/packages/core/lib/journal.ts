// The Apply Journal: which writes of a run's Write Plan were sent, kept in
// SQLite in the git-ignored state directory. A write is taken before it is
// sent and settled after, so no two Applies, even in separate processes,
// ever send the same write of a run.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The Apply Journal's entries for one run's Write Plan, by position from 0. */
export type RunJournal = {
  readonly run: string;
  /**
   * The results of the writes already sent, in order. Throws when a write
   * is in doubt: taken by an Apply that is still sending it or stopped while
   * sending it.
   */
  sent(): unknown[];
  /**
   * Takes a write for sending. Fails when another Apply took it first, or
   * when the run was declined.
   */
  take(position: number): "taken" | "busy" | "declined";
  settle(position: number, result: unknown): void;
  /** Gives back a write its server refused, so that a resume sends it. */
  release(position: number): void;
  /** Stops every Apply of the run before its next write. */
  decline(): void;
};

export type Journal = {
  run(run: string): RunJournal;
  close(): void;
};

export function openJournal(root: string): Journal {
  let db: DatabaseSync | undefined;
  // Opened on first use, so a core that never applies leaves no state behind.
  function open(): DatabaseSync {
    if (db !== undefined) return db;
    const state = join(root, ".pinfold");
    mkdirSync(state, { recursive: true });
    // Nothing in the state directory belongs in version control.
    writeFileSync(join(state, ".gitignore"), "*\n");
    db = new DatabaseSync(join(state, "journal.sqlite"));
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS writes (
        run TEXT NOT NULL,
        position INTEGER NOT NULL,
        -- JSON of the write's real result; NULL while it is being sent.
        result TEXT,
        PRIMARY KEY (run, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS declined (run TEXT PRIMARY KEY) STRICT;
    `);
    return db;
  }

  return {
    run(run) {
      return {
        run,
        sent() {
          const rows = open()
            .prepare(
              "SELECT position, result FROM writes WHERE run = ? ORDER BY position"
            )
            .all(run) as { position: number; result: string | null }[];
          return rows.map(({ position, result }) => {
            if (result === null) {
              throw new Error(
                `Write ${position + 1} of run ${run} is being sent by another Apply, or an Apply stopped while sending it and it may have reached its server. Nothing was sent.`
              );
            }
            return JSON.parse(result) as unknown;
          });
        },
        take(position) {
          // One statement, so a decline lands either before the write is
          // taken or after it, never in between.
          const { changes } = open()
            .prepare(
              `INSERT OR IGNORE INTO writes (run, position)
               SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM declined WHERE run = ?)`
            )
            .run(run, position, run);
          if (changes === 1) return "taken";
          const declined = open()
            .prepare("SELECT 1 FROM declined WHERE run = ?")
            .get(run);
          return declined === undefined ? "busy" : "declined";
        },
        settle(position, result) {
          open()
            .prepare(
              "UPDATE writes SET result = ? WHERE run = ? AND position = ?"
            )
            .run(JSON.stringify(result ?? null), run, position);
        },
        release(position) {
          open()
            .prepare("DELETE FROM writes WHERE run = ? AND position = ?")
            .run(run, position);
        },
        decline() {
          open()
            .prepare("INSERT OR IGNORE INTO declined (run) VALUES (?)")
            .run(run);
        },
      };
    },
    close() {
      db?.close();
    },
  };
}
