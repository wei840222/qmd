import { createHash } from "node:crypto";
import type { Database } from "../db.js";

export type EmbeddingBuildMode = "rebuild" | "resume";
export type EmbeddingIndexStateStatus = "empty" | "building" | "partial" | "ready" | "incompatible" | "mismatch";

export interface EmbeddingIdentity {
  readonly fingerprint: string;
  readonly providerId: string;
  readonly model: string;
  readonly dimension: number;
  readonly remote: boolean;
  readonly canonicalMaterial: string;
}

export interface EmbeddingBuildLease {
  readonly fingerprint: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly leaseExpiresAt: number;
  readonly mode: EmbeddingBuildMode;
}

export interface EmbeddingIndexState {
  readonly status: EmbeddingIndexStateStatus;
  readonly identity?: EmbeddingIdentity;
  readonly ownerId?: string;
  readonly generation?: number;
  readonly leaseExpiresAt?: number;
}

export type EmbeddingIdentityStateErrorCode =
  | "IDENTITY_MISMATCH"
  | "LEASE_BUSY"
  | "LEASE_LOST"
  | "INVALID_IDENTITY"
  | "INVALID_LEASE";

export class EmbeddingIdentityStateError extends Error {
  readonly code: EmbeddingIdentityStateErrorCode;

  constructor(code: EmbeddingIdentityStateErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingIdentityStateError";
    this.code = code;
  }
}

interface EmbeddingStateRow {
  fingerprint: string;
  provider_id: string;
  model: string;
  dimension: number;
  remote: number;
  canonical_material: string;
  status: "building" | "ready" | "incompatible";
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

function hasVerifiableStoredIdentity(row: EmbeddingStateRow): boolean {
  if (!/^[0-9a-f]{64}$/.test(row.fingerprint)) return false;
  if (createHash("sha256").update(row.canonical_material).digest("hex") !== row.fingerprint) {
    return false;
  }
  try {
    const material = JSON.parse(row.canonical_material) as unknown;
    return typeof material === "object" && material !== null && !Array.isArray(material);
  } catch {
    return false;
  }
}

export interface BeginEmbeddingBuildOptions {
  ownerId: string;
  now: number;
  leaseMs: number;
  allowDestructiveRebuild: boolean;
  /** Force a same-identity global reset inside this transaction. */
  forceRebuild?: boolean;
  /** Remote identity changes require force independently from destructive permission. */
  requireForceForIdentityChange?: boolean;
  /** Runs under BEGIN IMMEDIATE before any identity state or vector data mutation. */
  beforeMutation?: () => void;
  /** Fault-injection/observability hook after vector-table preparation, still under the writer transaction. */
  afterVectorTablePrepared?: () => void;
}

export function createEmbeddingIdentity(input: {
  providerId: string;
  model: string;
  dimension: number;
  remote: boolean;
  canonicalMaterial: string;
}): EmbeddingIdentity {
  if (input.providerId.trim() === "" || input.model.trim() === "" || input.canonicalMaterial === "") {
    throw new EmbeddingIdentityStateError("INVALID_IDENTITY", "Embedding identity fields must not be empty.");
  }
  if (!Number.isInteger(input.dimension) || input.dimension < 1) {
    throw new EmbeddingIdentityStateError("INVALID_IDENTITY", "Embedding identity dimension must be positive.");
  }
  const fingerprint = createHash("sha256").update(input.canonicalMaterial).digest("hex");
  return Object.freeze({ ...input, fingerprint });
}

export function ensureEmbeddingIdentitySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      fingerprint TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL CHECK (dimension > 0),
      remote INTEGER NOT NULL CHECK (remote IN (0, 1)),
      canonical_material TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'incompatible')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      lease_owner TEXT,
      lease_expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  const schema = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_state'
  `).get() as { sql: string } | undefined;
  if (schema && !schema.sql.includes("'incompatible'")) {
    db.transaction(() => {
      db.exec(`ALTER TABLE embedding_index_state RENAME TO embedding_index_state_legacy`);
      db.exec(`
        CREATE TABLE embedding_index_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          fingerprint TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL CHECK (dimension > 0),
          remote INTEGER NOT NULL CHECK (remote IN (0, 1)),
          canonical_material TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'incompatible')),
          generation INTEGER NOT NULL CHECK (generation > 0),
          lease_owner TEXT,
          lease_expires_at INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO embedding_index_state(
          singleton, fingerprint, provider_id, model, dimension, remote,
          canonical_material, status, generation, lease_owner, lease_expires_at, updated_at
        )
        SELECT singleton, fingerprint, provider_id, model, dimension, remote,
          canonical_material, status, generation, lease_owner, lease_expires_at, updated_at
        FROM embedding_index_state_legacy
      `);
      db.exec(`DROP TABLE embedding_index_state_legacy`);
    })();
  }
  const row = readState(db);
  if (row && row.status !== "incompatible" && !hasVerifiableStoredIdentity(row)) {
    db.prepare(`
      UPDATE embedding_index_state
      SET status = 'incompatible', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?
      WHERE singleton = 1
    `).run(Date.now());
  }
}

function readState(db: Database): EmbeddingStateRow | undefined {
  return db.prepare(`
    SELECT fingerprint, provider_id, model, dimension, remote, canonical_material,
           status, generation, lease_owner, lease_expires_at
    FROM embedding_index_state
    WHERE singleton = 1
  `).get() as EmbeddingStateRow | undefined;
}

function rowIdentity(row: EmbeddingStateRow): EmbeddingIdentity {
  return Object.freeze({
    fingerprint: row.fingerprint,
    providerId: row.provider_id,
    model: row.model,
    dimension: row.dimension,
    remote: row.remote === 1,
    canonicalMaterial: row.canonical_material,
  });
}

export function readStoredEmbeddingIdentity(db: Database): EmbeddingIdentity | undefined {
  ensureEmbeddingIdentitySchema(db);
  const row = readState(db);
  return row ? rowIdentity(row) : undefined;
}

function embeddingRowsExist(db: Database): boolean {
  const row = db.prepare("SELECT EXISTS(SELECT 1 FROM content_vectors LIMIT 1) AS present").get() as {
    present: number;
  };
  const vecTable = db.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
    ) AS present
  `).get() as { present: number };
  return row.present === 1 || vecTable.present === 1;
}

export function inspectEmbeddingIndexState(
  db: Database,
  expected: EmbeddingIdentity,
  now = Date.now(),
): EmbeddingIndexState {
  ensureEmbeddingIdentitySchema(db);
  const row = readState(db);
  if (!row) {
    return { status: embeddingRowsExist(db) ? "mismatch" : "empty" };
  }
  const identity = rowIdentity(row);
  if (row.status === "incompatible") {
    return { status: "incompatible", identity, generation: row.generation };
  }
  if (row.fingerprint !== expected.fingerprint) {
    return { status: "mismatch", identity, generation: row.generation };
  }
  if (row.status === "ready") {
    return { status: "ready", identity, generation: row.generation };
  }
  if (row.lease_owner && row.lease_expires_at !== null && row.lease_expires_at > now) {
    return {
      status: "building",
      identity,
      ownerId: row.lease_owner,
      generation: row.generation,
      leaseExpiresAt: row.lease_expires_at,
    };
  }
  return { status: "partial", identity, generation: row.generation };
}

function validateLeaseOptions(options: BeginEmbeddingBuildOptions): void {
  if (options.ownerId.trim() === "" || !Number.isFinite(options.now)
      || !Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
    throw new EmbeddingIdentityStateError("INVALID_LEASE", "Embedding build lease options are invalid.");
  }
}

function clearEmbeddingData(db: Database): void {
  db.prepare("DELETE FROM content_vectors").run();
  db.exec("DROP TABLE IF EXISTS vectors_vec");
}

function ensureEmbeddingVectorTable(db: Database, dimension: number): void {
  const table = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
  `).get() as { sql: string } | undefined;
  if (table) {
    const storedDimension = table.sql.match(/float\[(\d+)\]/)?.[1];
    const hasHashSeq = table.sql.includes("hash_seq");
    const hasCollection = table.sql.includes("collection");
    const hasCosine = table.sql.includes("distance_metric=cosine");
    if (storedDimension === String(dimension)
      && hasHashSeq
      && hasCollection
      && hasCosine) {
      return;
    }
    if (storedDimension === String(dimension) && hasHashSeq && !hasCollection) {
      // Auto-migrate legacy table without collection column
      try {
        db.exec("CREATE TEMP TABLE _qmd_migrate_vecs (hash_seq TEXT, embedding BLOB)");
        db.exec("INSERT INTO _qmd_migrate_vecs SELECT hash_seq, embedding FROM vectors_vec");
        db.exec("DROP TABLE vectors_vec");
        db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, collection TEXT, embedding float[${dimension}] distance_metric=cosine)`);
        db.exec(`
          INSERT INTO vectors_vec (hash_seq, collection, embedding)
          SELECT
            t.hash_seq,
            COALESCE((
              SELECT d.collection
              FROM content_vectors cv
              JOIN documents d ON d.hash = cv.hash AND d.active = 1
              WHERE (cv.hash || '_' || cv.seq) = t.hash_seq
              LIMIT 1
            ), ''),
            t.embedding
          FROM _qmd_migrate_vecs t
        `);
        db.exec("DROP TABLE IF EXISTS _qmd_migrate_vecs");
        return;
      } catch {
        db.exec("DROP TABLE IF EXISTS _qmd_migrate_vecs");
        db.exec("DROP TABLE IF EXISTS vectors_vec");
      }
    } else {
      throw new EmbeddingIdentityStateError(
        "IDENTITY_MISMATCH",
        "Stored vector table schema does not match the active embedding identity.",
      );
    }
  }
  db.exec(`
    CREATE VIRTUAL TABLE vectors_vec USING vec0(
      hash_seq TEXT PRIMARY KEY,
      collection TEXT,
      embedding float[${dimension}] distance_metric=cosine
    )
  `);
}

export function beginEmbeddingBuild(
  db: Database,
  identity: EmbeddingIdentity,
  options: BeginEmbeddingBuildOptions,
): EmbeddingBuildLease {
  validateLeaseOptions(options);
  ensureEmbeddingIdentitySchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    options.beforeMutation?.();
    let row = readState(db);
    const hasEmbeddingData = embeddingRowsExist(db);
    const mismatch = row
      ? row.status === "incompatible" || row.fingerprint !== identity.fingerprint
      : hasEmbeddingData;
    if (mismatch && options.requireForceForIdentityChange && !options.forceRebuild) {
      throw new EmbeddingIdentityStateError(
        "IDENTITY_MISMATCH",
        "Remote embedding identity changes require both force and destructive rebuild authorization.",
      );
    }
    if (mismatch || options.forceRebuild) {
      if (!options.allowDestructiveRebuild) {
        throw new EmbeddingIdentityStateError(
          "IDENTITY_MISMATCH",
          "Stored embedding identity does not match the active provider.",
        );
      }
      clearEmbeddingData(db);
      db.prepare("DELETE FROM embedding_index_state WHERE singleton = 1").run();
      row = undefined;
    }

    // Vector table creation is part of publication state, not a follow-up.
    // If this fails, any destructive reset and the new lease roll back together.
    ensureEmbeddingVectorTable(db, identity.dimension);
    options.afterVectorTablePrepared?.();

    if (row?.lease_owner && row.lease_expires_at !== null
        && row.lease_expires_at > options.now && row.lease_owner !== options.ownerId) {
      throw new EmbeddingIdentityStateError(
        "LEASE_BUSY",
        `Embedding build lease is owned by ${row.lease_owner}.`,
      );
    }

    const mode: EmbeddingBuildMode = row ? "resume" : "rebuild";
    const preservePublishedReady = row?.status === "ready" && !mismatch && !options.forceRebuild;
    const generation = (row?.generation ?? 0) + 1;
    const leaseExpiresAt = options.now + options.leaseMs;
    db.prepare(`
      INSERT INTO embedding_index_state(
        singleton, fingerprint, provider_id, model, dimension, remote,
        canonical_material, status, generation, lease_owner, lease_expires_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        provider_id = excluded.provider_id,
        model = excluded.model,
        dimension = excluded.dimension,
        remote = excluded.remote,
        canonical_material = excluded.canonical_material,
        status = excluded.status,
        generation = excluded.generation,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `).run(
      identity.fingerprint,
      identity.providerId,
      identity.model,
      identity.dimension,
      identity.remote ? 1 : 0,
      identity.canonicalMaterial,
      preservePublishedReady ? "ready" : "building",
      generation,
      options.ownerId,
      leaseExpiresAt,
      options.now,
    );
    db.exec("COMMIT");
    return Object.freeze({
      fingerprint: identity.fingerprint,
      ownerId: options.ownerId,
      generation,
      leaseExpiresAt,
      mode,
    });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateOwnedLease(
  db: Database,
  lease: EmbeddingBuildLease,
  sql: string,
  params: Array<string | number | null>,
): void {
  const result = db.prepare(sql).run(
    ...params,
    lease.fingerprint,
    lease.ownerId,
    lease.generation,
  );
  if (result.changes !== 1) {
    throw new EmbeddingIdentityStateError(
      "LEASE_LOST",
      "Embedding build lease is no longer owned by this operation.",
    );
  }
}

export function renewEmbeddingBuildLease(
  db: Database,
  lease: EmbeddingBuildLease,
  now: number,
  leaseMs: number,
): EmbeddingBuildLease {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new EmbeddingIdentityStateError("INVALID_LEASE", "Embedding lease duration must be positive.");
  }
  const leaseExpiresAt = now + leaseMs;
  updateOwnedLease(db, lease, `
    UPDATE embedding_index_state
    SET lease_expires_at = ?, updated_at = ?
    WHERE singleton = 1 AND lease_expires_at > ?
      AND fingerprint = ? AND lease_owner = ? AND generation = ?
  `, [leaseExpiresAt, now, now]);
  return Object.freeze({ ...lease, leaseExpiresAt });
}

export function completeEmbeddingBuild(
  db: Database,
  lease: EmbeddingBuildLease,
  now = Date.now(),
): void {
  updateOwnedLease(db, lease, `
    UPDATE embedding_index_state
    SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE singleton = 1 AND lease_expires_at > ?
      AND fingerprint = ? AND lease_owner = ? AND generation = ?
  `, [now, now]);
}

export function abandonEmbeddingBuild(
  db: Database,
  lease: EmbeddingBuildLease,
  now = Date.now(),
): void {
  updateOwnedLease(db, lease, `
    UPDATE embedding_index_state
    SET status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'building' END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE singleton = 1 AND lease_expires_at > ?
      AND fingerprint = ? AND lease_owner = ? AND generation = ?
  `, [now, now]);
}
