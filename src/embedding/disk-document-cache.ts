import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  DOCUMENT_CACHE_MAX_BYTES, DOCUMENT_CACHE_MAX_ENTRIES, DOCUMENT_CACHE_TTL_MS,
  isValidDocumentVector, validateDocumentVectors,
} from "./document-cache.js";
import type { EmbeddingVector } from "./provider.js";

class CacheStorageError extends Error {}
let warned = false;
function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  console.warn("QMD: document disk cache is unavailable; embeddings will be computed without disk reuse.");
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return typeof code === "number" && [5, 6].includes(code & 255);
}

function storage<T>(run: () => T): T {
  try { return run(); }
  catch { throw new CacheStorageError(); }
}

async function retryBusy<T>(run: () => T, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try { return run(); }
    catch (error) {
      if (!isBusy(error)) throw new CacheStorageError();
      await delay(25, undefined, { signal });
    }
  }
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** SQLite owns both atomic publication and a crash-released cross-process writer lock. */
export async function embedDocumentsWithDiskCache(
  directory: string,
  namespace: string,
  texts: readonly string[],
  model: string,
  dimension: number,
  fetchBatch: (missing: string[]) => Promise<EmbeddingVector[]>,
  authorizeReuse: () => Promise<void>,
  signal: AbortSignal,
  bypassCache = false,
): Promise<EmbeddingVector[]> {
  signal.throwIfAborted();
  const keys = texts.map(text => createHash("sha256").update(JSON.stringify([namespace, text])).digest("hex"));
  const inputs = new Map(keys.map((key, i) => [key, texts[i]!]));
  let db: DatabaseSync | undefined;
  let results: EmbeddingVector[] | undefined;
  try {
    const file = join(directory, "document-embeddings-v1.sqlite");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { const handle = await open(file, "wx", 0o600); await handle.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!(await lstat(file)).isFile()) throw new CacheStorageError();
    } catch { throw new CacheStorageError(); }
    db = await retryBusy(() => new DatabaseSync(file, { timeout: 0, allowExtension: false }), signal);
    const connection = db;
    // ponytail: one writer per cache directory serializes cache-miss batches.
    // Shard directories if unrelated embedding workloads need independent throughput.
    await retryBusy(() => connection.exec("BEGIN IMMEDIATE"), signal);
    storage(() => connection.exec(`
      PRAGMA max_page_count = 32768;
      CREATE TABLE IF NOT EXISTS embeddings (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS embeddings_access ON embeddings(accessed_at);
    `));
    const now = Date.now();
    storage(() => connection.prepare("DELETE FROM embeddings WHERE created_at <= ?").run(now - DOCUMENT_CACHE_TTL_MS));
    const values = new Map<string, EmbeddingVector>();
    const missing: Array<[string, string]> = [];
    for (const [key, text] of inputs) {
      const row = bypassCache ? undefined : storage(() => connection.prepare(
        "SELECT payload FROM embeddings WHERE key = ?",
      ).get(key)) as { payload: string } | undefined;
      let value: unknown;
      try { value = row ? JSON.parse(row.payload) : undefined; } catch { /* Treat damaged entries as misses. */ }
      if (isValidDocumentVector(value, model, dimension)) {
        values.set(key, { vector: value.vector, model, dimension });
      } else {
        missing.push([key, text]);
      }
    }
    if (values.size > 0) await authorizeReuse();
    if (missing.length > 0) {
      signal.throwIfAborted();
      const computed = await withSignal(fetchBatch(missing.map(([, text]) => text)), signal);
      validateDocumentVectors(computed, missing.length, model, dimension);
      for (let i = 0; i < missing.length; i++) values.set(missing[i]![0], computed[i]!);
    }
    signal.throwIfAborted();
    results = keys.map(key => {
      const value = values.get(key)!;
      return { ...value, vector: [...value.vector] };
    });
    for (const [key] of missing) {
      const value = values.get(key)!;
      const payload = JSON.stringify({ vector: value.vector, model, dimension });
      const bytes = Buffer.byteLength(payload) + 256;
      storage(() => connection.prepare("DELETE FROM embeddings WHERE key = ?").run(key));
      if (bytes <= DOCUMENT_CACHE_MAX_BYTES) storage(() => connection.prepare(`
        INSERT INTO embeddings(key, payload, bytes, created_at, accessed_at) VALUES (?, ?, ?, ?, ?)
      `).run(key, payload, bytes, Date.now(), now));
    }
    for (const key of inputs.keys()) storage(() => connection.prepare("UPDATE embeddings SET accessed_at = ? WHERE key = ?").run(now, key));
    // Keep the most recently accessed bounded set; deleted pages are reused by SQLite.
    storage(() => connection.exec(`
      DELETE FROM embeddings WHERE key IN (
        SELECT key FROM (
          SELECT key, ROW_NUMBER() OVER (ORDER BY accessed_at DESC, key) AS rank,
            SUM(bytes) OVER (ORDER BY accessed_at DESC, key ROWS UNBOUNDED PRECEDING) AS total_bytes
          FROM embeddings
        ) WHERE rank > ${DOCUMENT_CACHE_MAX_ENTRIES} OR total_bytes > ${DOCUMENT_CACHE_MAX_BYTES}
      );
    `));
    await retryBusy(() => connection.exec("COMMIT"), signal);
    return results;
  } catch (error) {
    if (!(error instanceof CacheStorageError)) throw error;
    warnUnavailable();
    // A failed cache write must not trigger another paid request for vectors already obtained.
    if (results) return results;
  } finally {
    if (db) {
      try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { warnUnavailable(); }
      try { db.close(); } catch { warnUnavailable(); }
    }
  }
  signal.throwIfAborted();
  const computed = await withSignal(fetchBatch([...inputs.values()]), signal);
  validateDocumentVectors(computed, inputs.size, model, dimension);
  const values = new Map([...inputs.keys()].map((key, i) => [key, computed[i]!]));
  return keys.map(key => ({ ...values.get(key)!, vector: [...values.get(key)!.vector] }));
}
