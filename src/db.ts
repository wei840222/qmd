/**
 * db.ts - SQLite database connection and extension management
 *
 * Provides a synchronous node:sqlite connection with QMD's transaction helper
 * and sqlite-vec extension loading.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export type SQLiteValue = string | number | bigint | Buffer | Uint8Array | Float32Array | null;
export type SQLiteParams = readonly SQLiteValue[];

let savepointSequence = 0;

export type Transaction<TArgs extends unknown[], TResult> = ((...args: TArgs) => TResult) & {
  deferred: (...args: TArgs) => TResult;
  immediate: (...args: TArgs) => TResult;
  exclusive: (...args: TArgs) => TResult;
};

function isBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /database is locked|database is busy|SQLITE_BUSY/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Synchronous SQLite connection with QMD-compatible transactions. */
export class Database extends DatabaseSync {
  transaction<TArgs extends unknown[], TResult>(operation: (...args: TArgs) => TResult): Transaction<TArgs, TResult> {
    const execute = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE", args: TArgs): TResult => {
      if (!this.isTransaction) {
        this.exec(`BEGIN ${mode}`);
        try {
          const result = operation(...args);
          this.exec("COMMIT");
          return result;
        } catch (error) {
          try { this.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }

      const savepoint = `qmd_${++savepointSequence}`;
      this.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation(...args);
        this.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.exec(`ROLLBACK TO ${savepoint}`);
          this.exec(`RELEASE ${savepoint}`);
        } catch {}
        throw error;
      }
    };

    const transaction = ((...args: TArgs) => execute("DEFERRED", args)) as Transaction<TArgs, TResult>;
    transaction.deferred = (...args: TArgs) => execute("DEFERRED", args);
    transaction.immediate = (...args: TArgs) => execute("IMMEDIATE", args);
    transaction.exclusive = (...args: TArgs) => execute("EXCLUSIVE", args);
    return transaction;
  }
}

/** Statement type used throughout QMD. */
export type Statement<T extends SQLiteParams = SQLiteParams> = StatementSync;

function resolveBusyTimeout(): number {
  const raw = process.env.QMD_SQLITE_BUSY_TIMEOUT;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 120_000;
}

/**
 * Switch a connection to WAL, retrying on `SQLITE_BUSY` within the busy-timeout
 * budget. Migrating the journal needs a brief exclusive lock and does not invoke
 * SQLite's busy handler on every supported runtime.
 */
function enableWal(db: Database, budgetMs: number): void {
  const deadline = Date.now() + Math.max(budgetMs, 0);
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      if (!isBusyError(err) || Date.now() >= deadline) throw err;
      sleepSync(Math.min(5 + attempt, 25));
    }
  }
}

/** Open a writable QMD database using Node's built-in SQLite runtime. */
export function openDatabase(path: string): Database {
  const busyTimeoutMs = resolveBusyTimeout();
  const db = new Database(path, { allowExtension: true, timeout: busyTimeoutMs });
  enableWal(db, busyTimeoutMs);
  return db;
}

/** Open an existing database without changing journal mode, schema, or user data. */
export function openReadOnlyDatabase(path: string): Database {
  const busyTimeoutMs = resolveBusyTimeout();
  return new Database(path, {
    readOnly: true,
    allowExtension: true,
    timeout: busyTimeoutMs,
  });
}

/** Load the sqlite-vec extension into a database. */
export function loadSqliteVec(db: Database): void {
  try {
    sqliteVec.load(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`sqlite-vec extension is unavailable. Ensure the sqlite-vec native module is installed correctly: ${message}`);
  }
}
