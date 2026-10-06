import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { EmbeddingProviderError, type EmbeddingVector } from "./provider.js";

export const DOCUMENT_CACHE_MAX_ENTRIES = 2_000;
export const DOCUMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_CACHE_TTL_MS = 2 * 60 * 60 * 1_000;

// Module-local fallback when no shared disk directory is configured.
const completed = new LRUCache<string, EmbeddingVector>({
  max: DOCUMENT_CACHE_MAX_ENTRIES,
  maxSize: DOCUMENT_CACHE_MAX_BYTES,
  sizeCalculation: value => value.vector.length * 8 + 256,
  ttl: DOCUMENT_CACHE_TTL_MS,
});
const pending = new Map<string, Promise<EmbeddingVector>>();

const transports = new WeakMap<typeof globalThis.fetch, number>();
let nextTransportId = 0;

export function documentCacheNamespace(
  material: string, apiKey: string | undefined, transport?: typeof globalThis.fetch,
): string {
  let transportId = transport ? transports.get(transport) : null;
  if (transport && transportId === undefined) {
    transportId = ++nextTransportId;
    transports.set(transport, transportId);
  }
  return createHash("sha256").update(JSON.stringify([material, apiKey ?? null, transportId])).digest("hex");
}

export function isValidDocumentVector(value: unknown, model: string, dimension: number): value is EmbeddingVector {
  if (typeof value !== "object" || value === null) return false;
  const result = value as EmbeddingVector;
  return result.model === model && result.dimension === dimension
    && Array.isArray(result.vector) && result.vector.length === dimension
    && result.vector.every(component => typeof component === "number"
      && Number.isFinite(component) && Number.isFinite(Math.fround(component)));
}

export function validateDocumentVectors(results: EmbeddingVector[], count: number, model: string, dimension: number): void {
  if (results.length !== count) {
    throw new EmbeddingProviderError("BATCH_CARDINALITY_MISMATCH", "Document embedding batch is incomplete.");
  }
  for (const result of results) {
    if (!isValidDocumentVector(result, model, dimension)) {
      throw new EmbeddingProviderError("DIMENSION_MISMATCH", "Document embedding vector is invalid.");
    }
  }
}

function copy(value: EmbeddingVector, reused = false): EmbeddingVector {
  return {
    vector: [...value.vector], model: value.model, dimension: value.dimension,
    ...(!reused && value.usage ? { usage: value.usage } : {}),
  };
}

/** Call only after input validation; reuse must pass the caller's own authorization. */
export async function embedDocumentsWithCache(
  namespace: string,
  texts: readonly string[],
  model: string,
  dimension: number,
  fetchBatch: (missing: string[]) => Promise<EmbeddingVector[]>,
  authorizeReuse: () => Promise<void>,
  bypassCache = false,
): Promise<EmbeddingVector[]> {
  const keys = texts.map(text => createHash("sha256")
    .update(JSON.stringify([namespace, text])).digest("hex"));
  const missing = new Map<string, string>();
  const values = new Map<string, Promise<EmbeddingVector>>();
  let reused = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (values.has(key) || missing.has(key)) continue;
    if (bypassCache) completed.delete(key);
    const cached = bypassCache ? undefined : completed.get(key);
    const flight = bypassCache ? undefined : pending.get(key);
    if (cached) {
      reused = true;
      values.set(key, Promise.resolve(copy(cached, true)));
    } else if (flight) {
      reused = true;
      // A flight belongs to its initiating provider. If that caller goes away,
      // surviving callers retry through their own provider and authorization.
      // Guard/lease failures are caller-specific too (guards may throw custom errors).
      values.set(key, flight.then(value => copy(value, true)).catch(async error => {
        if (error instanceof EmbeddingProviderError
          && !["OPERATION_ABORTED", "DEADLINE_EXCEEDED", "PROVIDER_CLOSED", "REMOTE_AUTHORIZATION_REQUIRED"].includes(error.code)) throw error;
        await authorizeReuse();
        return (await embedDocumentsWithCache(namespace, [texts[i]!], model, dimension, fetchBatch, authorizeReuse))[0]!;
      }));
    } else {
      missing.set(key, texts[i]!);
    }
  }
  if (missing.size > 0) {
    const entries = [...missing];
    // Defer execution until every per-input promise is registered for joiners.
    const batch = Promise.resolve().then(() => fetchBatch(entries.map(([, text]) => text))).then(results => {
      validateDocumentVectors(results, entries.length, model, dimension);
      for (let i = 0; i < entries.length; i++) {
        const key = entries[i]![0];
        // A forced recomputation supersedes older in-flight results for this key.
        if (pending.get(key) === values.get(key)) completed.set(key, copy(results[i]!, true));
      }
      return results;
    });
    entries.forEach(([key], i) => {
      const flight = batch.then(results => results[i]!).finally(() => {
        if (pending.get(key) === flight) pending.delete(key);
      });
      pending.set(key, flight);
      values.set(key, flight);
    });
  }
  const results = await Promise.all(keys.map(key => values.get(key)!));
  if (reused) await authorizeReuse();
  return results.map(value => copy(value));
}
