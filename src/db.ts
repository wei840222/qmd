/**
 * db.ts - SQLite database connection and extension management
 *
 * Provides Database export and connection management using better-sqlite3
 * and sqlite-vec.
 */

import BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type SQLiteValue = string | number | bigint | Buffer | Uint8Array | Float32Array | null;
export type SQLiteParams = readonly SQLiteValue[];

type DatabaseOpenOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
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

/**
 * Switch a connection to WAL, retrying on `SQLITE_BUSY` within the busy-timeout
 * budget. Unlike ordinary writes, migrating the journal needs a brief exclusive
 * lock and does NOT invoke the busy handler, so concurrent first-time opens of a
 * cold database throw "database is locked" even with `busy_timeout` set. Once the
 * database is already WAL the pragma is a cheap no-op that does not contend.
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

/**
 * Open a SQLite database using better-sqlite3.
 *
 * `better-sqlite3` defaults `busy_timeout` to 0, so concurrent writers throw
 * `SQLITE_BUSY` instead of waiting. WAL improves read-while-write concurrency
 * but does not serialise writers. Setting the timeout at connection open makes
 * parallel processes queue at batch boundaries instead of failing on contact.
 *
 * WAL is enabled here too (with a bounded retry) so connection-level pragmas
 * live in one place and the cold-database journal migration survives concurrent
 * opens.
 *
 * Default 120_000 ms outlasts the worst-case batch commit on a multi-GB
 * index. Override with `QMD_SQLITE_BUSY_TIMEOUT` (value in milliseconds; `0`
 * restores the upstream fail-fast behaviour).
 */
export function openDatabase(path: string): Database {
  const db: Database = new BetterSqlite3(path);
  const raw = process.env.QMD_SQLITE_BUSY_TIMEOUT;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  const busyTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 120_000;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  enableWal(db, busyTimeoutMs);
  return db;
}

/** Open an existing database without changing journal mode, schema, or user data. */
export function openReadOnlyDatabase(path: string): Database {
  const options: DatabaseOpenOptions = { readonly: true, fileMustExist: true };
  const db: Database = new BetterSqlite3(path, options);
  const raw = process.env.QMD_SQLITE_BUSY_TIMEOUT;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  const busyTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 120_000;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
}

/**
 * Database and Statement types used throughout QMD.
 */
export type Database = BetterSqlite3.Database;
export type Statement<T extends SQLiteParams = SQLiteParams> = BetterSqlite3.Statement<T>;

/**
 * Load the sqlite-vec extension into a database.
 *
 * Throws with fix instructions when the extension is unavailable.
 */
export function loadSqliteVec(db: Database): void {
  try {
    sqliteVec.load(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`sqlite-vec extension is unavailable. Ensure the sqlite-vec native module is installed correctly: ${message}`);
  }
}
