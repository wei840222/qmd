import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  analyzeCjk,
  analyzeCjkWithCapability,
  CJK_ANALYZER_POLICY_VERSIONS,
  type CjkWordDiagnostic,
  type JiebaCapabilityLoader,
} from "./cjk-analyzer.js";
import {
  createJiebaUnavailableCapability,
  loadJiebaCapability,
  loadJiebaCapabilitySync,
  type JiebaCapability,
} from "./jieba-loader.js";
import {
  ZH_TW_TECH_DICTIONARY_SHA256,
  ZH_TW_TECH_DICTIONARY_VERSION,
} from "./zh-tw-tech-dictionary.js";
import { openDatabase, type Database } from "../db.js";

const CJK_INDEX_SCHEMA_VERSION = "3";
const DEFAULT_LEASE_MS = 60_000;
const BUILD_BATCH_SIZE = 200;
const BUILD_BATCH_BYTE_BUDGET = 8 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface CjkAnalyzerFingerprintSource {
  analyzerVersion: string;
  charPolicy: string;
  wordBoundaryPolicy: string;
  wordEligibilityPolicy: string;
  bigramPolicy: string;
  jiebaPackage: string;
  jiebaVersion: string;
  jiebaHmm: string;
  dictionaryVersion: string;
  dictionarySha256: string;
}

function resolveJiebaVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("@node-rs/jieba/package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unresolved";
  }
}

export const CJK_ANALYZER_FINGERPRINT_SOURCE: Readonly<CjkAnalyzerFingerprintSource> = Object.freeze({
  analyzerVersion: CJK_ANALYZER_POLICY_VERSIONS.analyzer,
  charPolicy: CJK_ANALYZER_POLICY_VERSIONS.char,
  wordBoundaryPolicy: CJK_ANALYZER_POLICY_VERSIONS.wordBoundary,
  wordEligibilityPolicy: CJK_ANALYZER_POLICY_VERSIONS.wordEligibility,
  bigramPolicy: CJK_ANALYZER_POLICY_VERSIONS.bigram,
  jiebaPackage: "@node-rs/jieba",
  jiebaVersion: resolveJiebaVersion(),
  jiebaHmm: "false",
  dictionaryVersion: ZH_TW_TECH_DICTIONARY_VERSION,
  dictionarySha256: ZH_TW_TECH_DICTIONARY_SHA256,
});

export function computeCjkAnalyzerFingerprint(source: CjkAnalyzerFingerprintSource): string {
  const canonical = Object.entries(source).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function getCjkAnalyzerFingerprint(): string {
  return computeCjkAnalyzerFingerprint(CJK_ANALYZER_FINGERPRINT_SOURCE);
}

export type CjkLexicalIndexStatus = "empty" | "building" | "ready" | "unavailable" | "dirty";

export interface CjkLexicalIndexState {
  status: CjkLexicalIndexStatus;
  generation: number;
  analyzerFingerprint: string | null;
  wordCapability: "unknown" | "available" | "unavailable";
  diagnosticCode: string | null;
  activeBuildId: string | null;
  publishedBuildId: string | null;
  dirtySinceMutationSeq: number | null;
  updatedAt: number;
}

interface CjkIndexStateRow {
  status: CjkLexicalIndexStatus;
  generation: number;
  analyzer_fingerprint: string | null;
  word_capability: "unknown" | "available" | "unavailable";
  diagnostic_code: string | null;
  active_build_id: string | null;
  published_build_id: string | null;
  dirty_since_mutation_seq: number | null;
  updated_at: number;
}

interface CjkBuildRow {
  build_id: string;
  state: string;
  owner_pid: number;
  owner_start_token: string | null;
  lease_expires_at: number;
  words_table: string;
  bigrams_table: string;
}

interface RetiredCjkTablesRow {
  build_id: string;
  retired_words_table: string;
  retired_bigrams_table: string;
}

interface RetiredCjkTablesCandidateRow {
  build_id: string;
  retired_words_table: string | null;
  retired_bigrams_table: string | null;
}

interface SourceRow {
  id: number;
  collection: string;
  path: string;
  title: string;
  body: string;
}

interface AnalyzedRow {
  id: number;
  filepathWord: string;
  titleWord: string;
  bodyWord: string;
  filepathBigram: string;
  titleBigram: string;
  bodyBigram: string;
}

export type CjkIndexBuildPhase =
  | { phase: "snapshot-complete"; buildId: string; baseMutationSeq: number }
  | {
      phase: "catchup-page-complete";
      buildId: string;
      targetMutationSeq: number;
      appliedMutationSeq: number;
      documentCount: number;
    }
  | { phase: "catchup-complete"; buildId: string; targetMutationSeq: number; documentCount: number }
  | { phase: "published"; buildId: string; generation: number };

export type CjkIndexBuildResult =
  | { status: "ready"; buildId: string; generation: number; fingerprint: string; reused: boolean }
  | { status: "busy"; buildId: string }
  | { status: "unavailable"; diagnostic: CjkWordDiagnostic; publishedBuildId: string | null };

export interface CjkIndexBuildOptions {
  force?: boolean;
  loadCapability?: JiebaCapabilityLoader;
  leaseDurationMs?: number;
  onPhase?: (event: CjkIndexBuildPhase) => void | Promise<void>;
}

function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error("Invalid CJK index table identifier");
  }
  return `"${identifier}"`;
}

function getMutationHead(db: Database): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM cjk_index_mutations`).get() as { seq: number };
  return Number(row.seq);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Return the kernel process start-time token used to distinguish a live build
 * owner from an unrelated process that later reused the same PID. Linux exposes
 * this as field 22 in /proc/<pid>/stat. Other platforms conservatively return
 * null, preserving legacy PID-only cleanup rather than risking a live owner.
 */
export function getProcessStartToken(pid: number = process.pid): string | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fieldsFromState = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = fieldsFromState[19];
    return startTime ? `linux:${startTime}` : null;
  } catch {
    return null;
  }
}

function registeredOwnerIsAlive(row: CjkBuildRow): boolean {
  if (!processIsAlive(row.owner_pid)) return false;
  if (row.owner_start_token === null) return true;
  const currentToken = getProcessStartToken(row.owner_pid);
  return currentToken === null || currentToken === row.owner_start_token;
}

function dropRegisteredTable(db: Database, name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) return;
  db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
}

function validateBuildTableNames(db: Database, row: CjkBuildRow): void {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(row.build_id)) {
    throw new Error("Invalid CJK build table identifier");
  }
  const suffix = row.build_id.replaceAll("-", "").slice(0, 20);
  if (
    row.words_table !== `documents_fts_words_build_${suffix}`
    || row.bigrams_table !== `documents_fts_bigrams_build_${suffix}`
  ) {
    throw new Error("Invalid CJK build table identifier");
  }
  const conflictingOwner = db.prepare(`
    SELECT 1
    FROM cjk_index_builds
    WHERE build_id <> ?
      AND (
        words_table IN (?, ?) OR bigrams_table IN (?, ?)
        OR retired_words_table IN (?, ?) OR retired_bigrams_table IN (?, ?)
      )
    LIMIT 1
  `).get(
    row.build_id,
    row.words_table,
    row.bigrams_table,
    row.words_table,
    row.bigrams_table,
    row.words_table,
    row.bigrams_table,
    row.words_table,
    row.bigrams_table,
  );
  if (conflictingOwner != null) {
    throw new Error("CJK build table is registered to another build");
  }
}

function validateRetiredTableNames(db: Database, row: RetiredCjkTablesRow): void {
  if (!/^documents_fts_words_old_[a-f0-9]+$/u.test(row.retired_words_table)
    || !/^documents_fts_bigrams_old_[a-f0-9]+$/u.test(row.retired_bigrams_table)) {
    throw new Error("Invalid retired CJK index table identifier");
  }
  const conflictingOwner = db.prepare(`
    SELECT 1
    FROM cjk_index_builds
    WHERE build_id <> ?
      AND (
        words_table IN (?, ?) OR bigrams_table IN (?, ?)
        OR retired_words_table IN (?, ?) OR retired_bigrams_table IN (?, ?)
      )
    LIMIT 1
  `).get(
    row.build_id,
    row.retired_words_table,
    row.retired_bigrams_table,
    row.retired_words_table,
    row.retired_bigrams_table,
    row.retired_words_table,
    row.retired_bigrams_table,
    row.retired_words_table,
    row.retired_bigrams_table,
  );
  if (conflictingOwner != null) {
    throw new Error("Retired CJK index table is registered to another build");
  }
}

/**
 * Reclaim a bounded number of atomically registered retired FTS table pairs.
 * Each pair is dropped and its tombstone cleared in one transaction, so a
 * crash leaves either a fully discoverable pair or a fully reclaimed pair.
 */
export function cleanupRetiredCjkIndexTables(
  db: Database,
  options: { limit?: number } = {},
): string[] {
  const limit = options.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("CJK retired table cleanup limit must be an integer from 1 to 100");
  }
  const candidates = db.prepare(`
    SELECT build_id
    FROM cjk_index_builds
    WHERE state = 'ready'
      AND (retired_words_table IS NOT NULL OR retired_bigrams_table IS NOT NULL)
    ORDER BY updated_at, build_id
    LIMIT ?
  `).all(limit) as { build_id: string }[];
  const cleaned: string[] = [];

  for (const candidate of candidates) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`
        SELECT build_id, retired_words_table, retired_bigrams_table
        FROM cjk_index_builds
        WHERE build_id = ? AND state = 'ready'
          AND (retired_words_table IS NOT NULL OR retired_bigrams_table IS NOT NULL)
      `).get(candidate.build_id) as RetiredCjkTablesCandidateRow | undefined;
      if (!row) {
        db.exec("COMMIT");
        continue;
      }
      if (row.retired_words_table === null || row.retired_bigrams_table === null) {
        throw new Error("Incomplete retired CJK index table tombstone");
      }
      const completeRow: RetiredCjkTablesRow = {
        build_id: row.build_id,
        retired_words_table: row.retired_words_table,
        retired_bigrams_table: row.retired_bigrams_table,
      };
      validateRetiredTableNames(db, completeRow);
      db.exec(`
        DROP TABLE IF EXISTS ${quoteIdentifier(completeRow.retired_words_table)};
        DROP TABLE IF EXISTS ${quoteIdentifier(completeRow.retired_bigrams_table)};
      `);
      const cleared = db.prepare(`
        UPDATE cjk_index_builds
        SET retired_words_table = NULL, retired_bigrams_table = NULL,
            updated_at = ?
        WHERE build_id = ? AND state = 'ready'
          AND retired_words_table = ? AND retired_bigrams_table = ?
      `).run(
        Date.now(),
        completeRow.build_id,
        completeRow.retired_words_table,
        completeRow.retired_bigrams_table,
      );
      if (Number(cleared.changes) !== 1) {
        throw new Error("Retired CJK index table ownership changed during cleanup");
      }
      db.exec("COMMIT");
      cleaned.push(completeRow.build_id);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  return cleaned;
}

function cleanupExpiredBuildsWithinTransaction(db: Database, nowMs: number): string[] {
  const rows = db.prepare(`
    SELECT build_id, state, owner_pid, owner_start_token, lease_expires_at,
           words_table, bigrams_table
    FROM cjk_index_builds
    WHERE state = 'building' AND lease_expires_at < ?
    ORDER BY started_at, build_id
  `).all(nowMs) as CjkBuildRow[];
  const cleaned: string[] = [];

  for (const row of rows) {
    if (registeredOwnerIsAlive(row)) continue;
    validateBuildTableNames(db, row);
    dropRegisteredTable(db, row.words_table);
    dropRegisteredTable(db, row.bigrams_table);
    db.prepare(`
      UPDATE cjk_index_builds
      SET state = 'abandoned', updated_at = ?
      WHERE build_id = ? AND state = 'building'
    `).run(nowMs, row.build_id);
    db.prepare(`
      UPDATE cjk_index_state
      SET active_build_id = NULL,
          status = CASE
            WHEN dirty_since_mutation_seq IS NOT NULL THEN 'dirty'
            WHEN published_build_id IS NULL THEN 'empty'
            ELSE 'ready'
          END,
          updated_at = ?
      WHERE singleton = 1 AND active_build_id = ?
    `).run(nowMs, row.build_id);
    cleaned.push(row.build_id);
  }
  return cleaned;
}

export function cleanupExpiredCjkIndexBuilds(
  db: Database,
  options: { nowMs?: number } = {},
): string[] {
  const nowMs = options.nowMs ?? Date.now();
  const candidate = db.prepare(`
    SELECT 1 FROM cjk_index_builds
    WHERE state = 'building' AND lease_expires_at < ?
    LIMIT 1
  `).get(nowMs);
  if (candidate == null) return [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const cleaned = cleanupExpiredBuildsWithinTransaction(db, nowMs);
    db.exec("COMMIT");
    return cleaned;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initializeCjkLexicalIndexSchema(db: Database): void {
  const current = db.prepare(`SELECT value FROM store_config WHERE key = 'cjk_index_schema_version'`).get() as { value?: string } | undefined;
  if (current?.value === CJK_INDEX_SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const checked = db.prepare(`SELECT value FROM store_config WHERE key = 'cjk_index_schema_version'`).get() as { value?: string } | undefined;
    if (checked?.value !== CJK_INDEX_SCHEMA_VERSION) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts_words USING fts5(
          filepath, title, body,
          tokenize='unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts_bigrams USING fts5(
          filepath, title, body,
          tokenize='unicode61'
        );
        CREATE TABLE IF NOT EXISTS cjk_index_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL CHECK (status IN ('empty', 'building', 'ready', 'unavailable', 'dirty')),
          generation INTEGER NOT NULL DEFAULT 0,
          analyzer_fingerprint TEXT,
          word_capability TEXT NOT NULL DEFAULT 'unknown'
            CHECK (word_capability IN ('unknown', 'available', 'unavailable')),
          diagnostic_code TEXT,
          active_build_id TEXT,
          published_build_id TEXT,
          dirty_since_mutation_seq INTEGER,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS cjk_index_builds (
          build_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'abandoned')),
          base_mutation_seq INTEGER NOT NULL,
          applied_mutation_seq INTEGER NOT NULL,
          analyzer_fingerprint TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          owner_start_token TEXT,
          lease_expires_at INTEGER NOT NULL,
          words_table TEXT NOT NULL,
          bigrams_table TEXT NOT NULL,
          retired_words_table TEXT,
          retired_bigrams_table TEXT,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cjk_index_mutations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete'))
        );
        CREATE INDEX IF NOT EXISTS idx_cjk_index_mutations_document
          ON cjk_index_mutations(document_id, seq);
        INSERT OR IGNORE INTO cjk_index_state(singleton, status)
          VALUES (1, 'empty');

      `);
      const stateColumns = db.prepare(`PRAGMA table_info(cjk_index_state)`).all() as { name: string }[];
      if (!stateColumns.some(column => column.name === "dirty_since_mutation_seq")) {
        db.exec(`ALTER TABLE cjk_index_state ADD COLUMN dirty_since_mutation_seq INTEGER`);
      }
      const buildColumns = db.prepare(`PRAGMA table_info(cjk_index_builds)`).all() as { name: string }[];
      if (!buildColumns.some(column => column.name === "owner_start_token")) {
        db.exec(`ALTER TABLE cjk_index_builds ADD COLUMN owner_start_token TEXT`);
      }
      if (!buildColumns.some(column => column.name === "retired_words_table")) {
        db.exec(`ALTER TABLE cjk_index_builds ADD COLUMN retired_words_table TEXT`);
      }
      if (!buildColumns.some(column => column.name === "retired_bigrams_table")) {
        db.exec(`ALTER TABLE cjk_index_builds ADD COLUMN retired_bigrams_table TEXT`);
      }
      db.exec(`
        DROP TRIGGER IF EXISTS documents_cjk_journal_ai;
        CREATE TRIGGER documents_cjk_journal_ai AFTER INSERT ON documents
        BEGIN
          INSERT INTO cjk_index_mutations(document_id, operation)
          VALUES (new.id, CASE WHEN new.active = 1 THEN 'upsert' ELSE 'delete' END);
          DELETE FROM documents_fts_words WHERE rowid = new.id;
          DELETE FROM documents_fts_bigrams WHERE rowid = new.id;
          UPDATE cjk_index_state
          SET status = 'dirty', diagnostic_code = 'CJK_INDEX_RAW_WRITE',
              dirty_since_mutation_seq = COALESCE(
                dirty_since_mutation_seq,
                (SELECT MAX(seq) FROM cjk_index_mutations)
              ),
              updated_at = unixepoch('subsec') * 1000
          WHERE singleton = 1;
        END;

        DROP TRIGGER IF EXISTS documents_cjk_journal_au;
        CREATE TRIGGER documents_cjk_journal_au
        AFTER UPDATE OF collection, path, title, hash, active ON documents
        WHEN old.collection IS NOT new.collection
          OR old.path IS NOT new.path
          OR old.title IS NOT new.title
          OR old.hash IS NOT new.hash
          OR old.active IS NOT new.active
        BEGIN
          INSERT INTO cjk_index_mutations(document_id, operation)
          VALUES (new.id, CASE WHEN new.active = 1 THEN 'upsert' ELSE 'delete' END);
          DELETE FROM documents_fts_words WHERE rowid = new.id;
          DELETE FROM documents_fts_bigrams WHERE rowid = new.id;
          UPDATE cjk_index_state
          SET status = 'dirty', diagnostic_code = 'CJK_INDEX_RAW_WRITE',
              dirty_since_mutation_seq = COALESCE(
                dirty_since_mutation_seq,
                (SELECT MAX(seq) FROM cjk_index_mutations)
              ),
              updated_at = unixepoch('subsec') * 1000
          WHERE singleton = 1;
        END;

        DROP TRIGGER IF EXISTS documents_cjk_journal_ad;
        CREATE TRIGGER documents_cjk_journal_ad AFTER DELETE ON documents
        BEGIN
          INSERT INTO cjk_index_mutations(document_id, operation)
          VALUES (old.id, 'delete');
          DELETE FROM documents_fts_words WHERE rowid = old.id;
          DELETE FROM documents_fts_bigrams WHERE rowid = old.id;
          UPDATE cjk_index_state
          SET status = 'dirty', diagnostic_code = 'CJK_INDEX_RAW_WRITE',
              dirty_since_mutation_seq = COALESCE(
                dirty_since_mutation_seq,
                (SELECT MAX(seq) FROM cjk_index_mutations)
              ),
              updated_at = unixepoch('subsec') * 1000
          WHERE singleton = 1;
        END;
      `);
      db.prepare(`
        INSERT OR REPLACE INTO store_config(key, value)
        VALUES ('cjk_index_schema_version', ?)
      `).run(CJK_INDEX_SCHEMA_VERSION);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getCjkLexicalIndexState(db: Database): CjkLexicalIndexState {
  const row = db.prepare(`
    SELECT status, generation, analyzer_fingerprint, word_capability,
           diagnostic_code, active_build_id, published_build_id,
           dirty_since_mutation_seq, updated_at
    FROM cjk_index_state WHERE singleton = 1
  `).get() as CjkIndexStateRow | undefined;
  if (!row) throw new Error("CJK lexical index schema is not initialized");
  return {
    status: row.status,
    generation: Number(row.generation),
    analyzerFingerprint: row.analyzer_fingerprint,
    wordCapability: row.word_capability,
    diagnosticCode: row.diagnostic_code,
    activeBuildId: row.active_build_id,
    publishedBuildId: row.published_build_id,
    dirtySinceMutationSeq: row.dirty_since_mutation_seq == null
      ? null
      : Number(row.dirty_since_mutation_seq),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Repair the char-only fallback rows affected by raw document writes.
 * Word/bigram rows and the dirty state intentionally remain gated until a
 * complete analyzer rebuild publishes the journal head.
 */
export function repairDirtyCjkCharFallback(db: Database): number {
  const schema = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name IN ('cjk_index_state', 'cjk_index_mutations')
  `).get() as { count: number };
  if (Number(schema.count) !== 2) return 0;

  const repair = db.transaction(() => {
    const state = getCjkLexicalIndexState(db);
    if (state.status !== "dirty" || state.dirtySinceMutationSeq === null) return 0;

    const targetMutationSeq = getMutationHead(db);
    const documentIds = (db.prepare(`
      SELECT DISTINCT document_id
      FROM cjk_index_mutations
      WHERE seq >= ? AND seq <= ?
      ORDER BY document_id
    `).all(state.dirtySinceMutationSeq, targetMutationSeq) as { document_id: number }[])
      .map(row => Number(row.document_id));
    const deleteChar = db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`);
    const insertChar = db.prepare(`
      INSERT INTO documents_fts(rowid, filepath, title, body)
      VALUES (?, ?, ?, ?)
    `);
    const fallbackCapability = createJiebaUnavailableCapability();

    for (const documentId of documentIds) {
      deleteChar.run(documentId);
      const source = sourceRowForDocument(db, documentId);
      if (!source) continue;
      const filepath = analyzeCjkWithCapability(`${source.collection}/${source.path}`, fallbackCapability);
      const title = analyzeCjkWithCapability(source.title, fallbackCapability);
      const body = analyzeCjkWithCapability(source.body, fallbackCapability);
      insertChar.run(documentId, filepath.char, title.char, body.char);
    }

    return documentIds.length;
  });

  return Number(repair());
}

/**
 * Commit a document/collection mutation and all published CJK lexical signals
 * at one SQLite transaction boundary. If the published index is not safe to
 * update (missing, rebuilding, stale fingerprint), raw triggers remove stale
 * word/bigram rows and leave an explicit dirty marker for maintenance rebuild.
 */
export function runCjkSynchronizedMutation<T>(db: Database, mutation: () => T): T {
  const synchronized = db.transaction(() => {
    const before = getCjkLexicalIndexState(db);
    const beforeMutationSeq = getMutationHead(db);
    const result = mutation();
    const targetMutationSeq = getMutationHead(db);
    if (targetMutationSeq === beforeMutationSeq) return result;

    const canSynchronize = before.status === "ready"
      && before.analyzerFingerprint === getCjkAnalyzerFingerprint()
      && before.wordCapability === "available"
      && before.activeBuildId === null
      && before.publishedBuildId !== null;
    if (!canSynchronize) return result;

    const capability = loadJiebaCapabilitySync();
    if (!capability.available) {
      throw new Error(`${capability.diagnostic.code}: ${capability.diagnostic.message} ${capability.diagnostic.remediation}`);
    }

    const mutationIds = (db.prepare(`
      SELECT DISTINCT document_id
      FROM cjk_index_mutations
      WHERE seq > ? AND seq <= ?
      ORDER BY document_id
    `).all(beforeMutationSeq, targetMutationSeq) as { document_id: number }[])
      .map(row => Number(row.document_id));
    const deleteChars = db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`);
    const deleteWords = db.prepare(`DELETE FROM documents_fts_words WHERE rowid = ?`);
    const deleteBigrams = db.prepare(`DELETE FROM documents_fts_bigrams WHERE rowid = ?`);
    const insertChars = db.prepare(`
      INSERT INTO documents_fts(rowid, filepath, title, body)
      VALUES (?, ?, ?, ?)
    `);
    const insertWords = db.prepare(`
      INSERT INTO documents_fts_words(rowid, filepath, title, body)
      VALUES (?, ?, ?, ?)
    `);
    const insertBigrams = db.prepare(`
      INSERT INTO documents_fts_bigrams(rowid, filepath, title, body)
      VALUES (?, ?, ?, ?)
    `);

    for (const documentId of mutationIds) {
      deleteChars.run(documentId);
      deleteWords.run(documentId);
      deleteBigrams.run(documentId);
      const source = sourceRowForDocument(db, documentId);
      if (!source) continue;
      const filepath = analyzeCjkWithCapability(`${source.collection}/${source.path}`, capability);
      const title = analyzeCjkWithCapability(source.title, capability);
      const body = analyzeCjkWithCapability(source.body, capability);
      if (!filepath.wordCapability.available || !title.wordCapability.available || !body.wordCapability.available) {
        throw new Error("CJK_JIEBA_MUTATION_FAILED: Chinese word segmentation failed during mutation");
      }
      insertChars.run(documentId, filepath.char, title.char, body.char);
      insertWords.run(documentId, filepath.word, title.word, body.word);
      insertBigrams.run(documentId, filepath.bigram, title.bigram, body.bigram);
    }

    db.prepare(`
      UPDATE cjk_index_state
      SET status = 'ready', generation = ?, analyzer_fingerprint = ?,
          word_capability = 'available', diagnostic_code = NULL,
          dirty_since_mutation_seq = NULL, updated_at = ?
      WHERE singleton = 1
    `).run(targetMutationSeq, getCjkAnalyzerFingerprint(), Date.now());
    return result;
  });

  return synchronized();
}

interface AcquiredBuild {
  buildId: string;
  wordsTable: string;
  bigramsTable: string;
  leaseDurationMs: number;
  ownerStartToken: string | null;
}

function createShadowTables(db: Database, wordsTable: string, bigramsTable: string): void {
  db.exec(`
    CREATE VIRTUAL TABLE ${quoteIdentifier(wordsTable)} USING fts5(
      filepath, title, body,
      tokenize='unicode61'
    );
    CREATE VIRTUAL TABLE ${quoteIdentifier(bigramsTable)} USING fts5(
      filepath, title, body,
      tokenize='unicode61'
    )
  `);
}

function renewLease(db: Database, build: AcquiredBuild): void {
  const nowMs = Date.now();
  const result = db.prepare(`
    UPDATE cjk_index_builds
    SET lease_expires_at = ?, updated_at = ?
    WHERE build_id = ? AND state = 'building'
      AND owner_pid = ? AND owner_start_token IS ?
  `).run(
    nowMs + build.leaseDurationMs,
    nowMs,
    build.buildId,
    process.pid,
    build.ownerStartToken,
  );
  if (Number(result.changes) !== 1) throw new Error("CJK rebuild lease ownership was lost");
}

async function resolveCapability(loader: JiebaCapabilityLoader): Promise<JiebaCapability> {
  try {
    return await loader();
  } catch {
    return createJiebaUnavailableCapability();
  }
}

function acquireBuild(
  db: Database,
  capability: JiebaCapability,
  options: CjkIndexBuildOptions,
): CjkIndexBuildResult | AcquiredBuild {
  const nowMs = Date.now();
  const fingerprint = getCjkAnalyzerFingerprint();
  const leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? DEFAULT_LEASE_MS);
  db.exec("BEGIN IMMEDIATE");
  try {
    cleanupExpiredBuildsWithinTransaction(db, nowMs);
    const state = getCjkLexicalIndexState(db);
    if (state.activeBuildId) {
      const active = db.prepare(`
        SELECT build_id FROM cjk_index_builds
        WHERE build_id = ? AND state = 'building'
      `).get(state.activeBuildId) as { build_id: string } | undefined;
      if (active) {
        db.exec("COMMIT");
        return { status: "busy", buildId: active.build_id };
      }
      db.prepare(`UPDATE cjk_index_state SET active_build_id = NULL WHERE singleton = 1`).run();
    }

    if (!capability.available) {
      db.prepare(`
        UPDATE cjk_index_state
        SET status = 'unavailable', word_capability = 'unavailable',
            diagnostic_code = ?, active_build_id = NULL, updated_at = ?
        WHERE singleton = 1
      `).run(capability.diagnostic.code, nowMs);
      db.exec("COMMIT");
      return {
        status: "unavailable",
        diagnostic: capability.diagnostic,
        publishedBuildId: state.publishedBuildId,
      };
    }

    if (!options.force && state.status === "ready" && state.analyzerFingerprint === fingerprint && state.publishedBuildId) {
      db.exec("COMMIT");
      return {
        status: "ready",
        buildId: state.publishedBuildId,
        generation: state.generation,
        fingerprint,
        reused: true,
      };
    }

    const buildId = randomUUID();
    const suffix = buildId.replaceAll("-", "").slice(0, 20);
    const wordsTable = `documents_fts_words_build_${suffix}`;
    const bigramsTable = `documents_fts_bigrams_build_${suffix}`;
    const ownerStartToken = getProcessStartToken();
    createShadowTables(db, wordsTable, bigramsTable);
    db.prepare(`
      INSERT INTO cjk_index_builds(
        build_id, state, base_mutation_seq, applied_mutation_seq,
        analyzer_fingerprint, owner_pid, owner_start_token, lease_expires_at,
        words_table, bigrams_table, started_at, updated_at
      ) VALUES (?, 'building', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      buildId,
      fingerprint,
      process.pid,
      ownerStartToken,
      nowMs + leaseDurationMs,
      wordsTable,
      bigramsTable,
      nowMs,
      nowMs,
    );
    db.prepare(`
      UPDATE cjk_index_state
      SET status = 'building', active_build_id = ?, word_capability = 'available',
          diagnostic_code = NULL, updated_at = ?
      WHERE singleton = 1
    `).run(buildId, nowMs);
    db.exec("COMMIT");
    return { buildId, wordsTable, bigramsTable, leaseDurationMs, ownerStartToken };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

class WordCapabilityLostError extends Error {
  constructor(readonly diagnostic: CjkWordDiagnostic) {
    super(diagnostic.code);
  }
}

async function analyzeSourceRow(row: SourceRow, loader: JiebaCapabilityLoader): Promise<AnalyzedRow> {
  const filepath = await analyzeCjk(`${row.collection}/${row.path}`, loader);
  const title = await analyzeCjk(row.title, loader);
  const body = await analyzeCjk(row.body, loader);
  if (!filepath.wordCapability.available) throw new WordCapabilityLostError(filepath.wordCapability.diagnostic);
  if (!title.wordCapability.available) throw new WordCapabilityLostError(title.wordCapability.diagnostic);
  if (!body.wordCapability.available) throw new WordCapabilityLostError(body.wordCapability.diagnostic);
  return {
    id: row.id,
    filepathWord: filepath.word,
    titleWord: title.word,
    bodyWord: body.word,
    filepathBigram: filepath.bigram,
    titleBigram: title.bigram,
    bodyBigram: body.bigram,
  };
}

function writeAnalyzedRows(
  db: Database,
  build: AcquiredBuild,
  rows: readonly (AnalyzedRow | null)[],
  documentIds?: readonly number[],
): void {
  const words = quoteIdentifier(build.wordsTable);
  const bigrams = quoteIdentifier(build.bigramsTable);
  const deleteWords = db.prepare(`DELETE FROM ${words} WHERE rowid = ?`);
  const deleteBigrams = db.prepare(`DELETE FROM ${bigrams} WHERE rowid = ?`);
  const insertWords = db.prepare(`INSERT INTO ${words}(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);
  const insertBigrams = db.prepare(`INSERT INTO ${bigrams}(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);
  const write = db.transaction(() => {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const documentId = row?.id ?? documentIds?.[index];
      if (documentId === undefined) throw new Error("Missing CJK mutation document id");
      deleteWords.run(documentId);
      deleteBigrams.run(documentId);
      if (!row) continue;
      insertWords.run(row.id, row.filepathWord, row.titleWord, row.bodyWord);
      insertBigrams.run(row.id, row.filepathBigram, row.titleBigram, row.bodyBigram);
    }
  });
  write();
}

function analyzedRowBytes(row: AnalyzedRow | null): number {
  if (row === null) return 0;
  return Buffer.byteLength(row.filepathWord, "utf8")
    + Buffer.byteLength(row.titleWord, "utf8")
    + Buffer.byteLength(row.bodyWord, "utf8")
    + Buffer.byteLength(row.filepathBigram, "utf8")
    + Buffer.byteLength(row.titleBigram, "utf8")
    + Buffer.byteLength(row.bodyBigram, "utf8");
}

async function analyzeAndWriteMutationPage(
  db: Database,
  build: AcquiredBuild,
  documentIds: readonly number[],
  loader: JiebaCapabilityLoader,
): Promise<void> {
  let rows: (AnalyzedRow | null)[] = [];
  let rowIds: number[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (rows.length === 0) return;
    writeAnalyzedRows(db, build, rows, rowIds);
    rows = [];
    rowIds = [];
    bytes = 0;
    renewLease(db, build);
  };

  for (const documentId of documentIds) {
    const source = sourceRowForDocument(db, documentId);
    const row = source ? await analyzeSourceRow(source, loader) : null;
    const rowBytes = analyzedRowBytes(row);
    if (rows.length > 0 && (rows.length >= BUILD_BATCH_SIZE || bytes + rowBytes > BUILD_BATCH_BYTE_BUDGET)) {
      flush();
    }
    rows.push(row);
    rowIds.push(documentId);
    bytes += rowBytes;
  }
  flush();
}

function sourceRowForDocument(db: Database, documentId: number): SourceRow | undefined {
  return db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, content.doc AS body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.id = ? AND d.active = 1
  `).get(documentId) as SourceRow | undefined;
}

function validateShadowRowIds(db: Database, build: AcquiredBuild): void {
  const words = quoteIdentifier(build.wordsTable);
  const bigrams = quoteIdentifier(build.bigramsTable);
  const mismatch = db.prepare(`
    SELECT id FROM (
      SELECT id FROM documents WHERE active = 1
      EXCEPT SELECT rowid AS id FROM ${words}
    )
    UNION ALL
    SELECT id FROM (
      SELECT rowid AS id FROM ${words}
      EXCEPT SELECT id FROM documents WHERE active = 1
    )
    UNION ALL
    SELECT id FROM (
      SELECT id FROM documents WHERE active = 1
      EXCEPT SELECT rowid AS id FROM ${bigrams}
    )
    UNION ALL
    SELECT id FROM (
      SELECT rowid AS id FROM ${bigrams}
      EXCEPT SELECT id FROM documents WHERE active = 1
    )
    LIMIT 1
  `).get();
  if (mismatch != null) throw new Error("CJK shadow index rowids do not match active documents");
}

function validateShadowAtMutationHead(
  db: Database,
  build: AcquiredBuild,
  appliedMutationSeq: number,
): boolean {
  db.exec("BEGIN");
  try {
    // Read the head first to establish the WAL snapshot used by the expensive
    // bidirectional identity scan. A later mutation is caught again under the
    // final writer lock before any live table name changes.
    if (getMutationHead(db) !== appliedMutationSeq) {
      db.exec("ROLLBACK");
      return false;
    }
    validateShadowRowIds(db, build);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function publishShadowTables(db: Database, build: AcquiredBuild, generation: number): void {
  const suffix = build.buildId.replaceAll("-", "").slice(0, 20);
  const oldWords = `documents_fts_words_old_${suffix}`;
  const oldBigrams = `documents_fts_bigrams_old_${suffix}`;
  const mutationTriggers = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'trigger' AND name IN (
      'documents_cjk_journal_ai',
      'documents_cjk_journal_au',
      'documents_cjk_journal_ad'
    )
    ORDER BY name
  `).all() as { sql: string | null }[];
  if (mutationTriggers.length !== 3 || mutationTriggers.some(trigger => !trigger.sql)) {
    throw new Error("CJK mutation triggers are incomplete before publish");
  }
  db.exec(`
    DROP TRIGGER documents_cjk_journal_ai;
    DROP TRIGGER documents_cjk_journal_au;
    DROP TRIGGER documents_cjk_journal_ad;
    ALTER TABLE documents_fts_words RENAME TO ${quoteIdentifier(oldWords)};
    ALTER TABLE ${quoteIdentifier(build.wordsTable)} RENAME TO documents_fts_words;
    ALTER TABLE documents_fts_bigrams RENAME TO ${quoteIdentifier(oldBigrams)};
    ALTER TABLE ${quoteIdentifier(build.bigramsTable)} RENAME TO documents_fts_bigrams;
  `);
  for (const trigger of mutationTriggers) db.exec(trigger.sql!);
  const nowMs = Date.now();
  const buildUpdate = db.prepare(`
    UPDATE cjk_index_builds
    SET state = 'ready', applied_mutation_seq = ?,
        retired_words_table = ?, retired_bigrams_table = ?, updated_at = ?
    WHERE build_id = ? AND state = 'building'
      AND owner_pid = ? AND owner_start_token IS ?
  `).run(
    generation,
    oldWords,
    oldBigrams,
    nowMs,
    build.buildId,
    process.pid,
    build.ownerStartToken,
  );
  if (Number(buildUpdate.changes) !== 1) throw new Error("CJK rebuild lease ownership was lost");
  const stateUpdate = db.prepare(`
    UPDATE cjk_index_state
    SET status = 'ready', generation = ?, analyzer_fingerprint = ?,
        word_capability = 'available', diagnostic_code = NULL,
        active_build_id = NULL, published_build_id = ?,
        dirty_since_mutation_seq = NULL, updated_at = ?
    WHERE singleton = 1 AND active_build_id = ?
  `).run(generation, getCjkAnalyzerFingerprint(), build.buildId, nowMs, build.buildId);
  if (Number(stateUpdate.changes) !== 1) throw new Error("CJK rebuild state ownership was lost");
}

function failBuild(db: Database, build: AcquiredBuild, diagnostic: CjkWordDiagnostic | null): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const active = getCjkLexicalIndexState(db).activeBuildId === build.buildId;
    if (active) {
      dropRegisteredTable(db, build.wordsTable);
      dropRegisteredTable(db, build.bigramsTable);
      const nowMs = Date.now();
      db.prepare(`
        UPDATE cjk_index_builds SET state = 'failed', updated_at = ?
        WHERE build_id = ? AND state = 'building'
      `).run(nowMs, build.buildId);
      db.prepare(`
        UPDATE cjk_index_state
        SET status = ?, active_build_id = NULL,
            word_capability = ?, diagnostic_code = ?, updated_at = ?
        WHERE singleton = 1 AND active_build_id = ?
      `).run(
        diagnostic ? "unavailable" : "dirty",
        diagnostic ? "unavailable" : "unknown",
        diagnostic?.code ?? "CJK_REBUILD_FAILED",
        nowMs,
        build.buildId,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function rebuildCjkLexicalIndex(
  dbPath: string,
  options: CjkIndexBuildOptions = {},
): Promise<CjkIndexBuildResult> {
  const requestedLoader = options.loadCapability ?? loadJiebaCapability;
  const capability = await resolveCapability(requestedLoader);
  const fixedLoader: JiebaCapabilityLoader = async () => capability;
  const coordinator = openDatabase(dbPath);
  initializeCjkLexicalIndexSchema(coordinator);
  cleanupRetiredCjkIndexTables(coordinator, { limit: 2 });
  const acquired = acquireBuild(coordinator, capability, options);
  if ("status" in acquired) {
    coordinator.close();
    return acquired;
  }

  const build = acquired;
  const snapshot = openDatabase(dbPath);
  let snapshotOpen = false;
  try {
    snapshot.exec("BEGIN");
    snapshotOpen = true;
    const baseMutationSeq = getMutationHead(snapshot);
    coordinator.prepare(`
      UPDATE cjk_index_builds
      SET base_mutation_seq = ?, applied_mutation_seq = ?, updated_at = ?
      WHERE build_id = ? AND state = 'building'
    `).run(baseMutationSeq, baseMutationSeq, Date.now(), build.buildId);

    const iterator = snapshot.prepare(`
      SELECT d.id, d.collection, d.path, d.title, content.doc AS body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.active = 1
      ORDER BY d.id
    `).iterate<SourceRow>();
    let batch: AnalyzedRow[] = [];
    for (const row of iterator) {
      batch.push(await analyzeSourceRow(row, fixedLoader));
      if (batch.length >= BUILD_BATCH_SIZE) {
        writeAnalyzedRows(coordinator, build, batch);
        batch = [];
        renewLease(coordinator, build);
      }
    }
    if (batch.length > 0) writeAnalyzedRows(coordinator, build, batch);
    snapshot.exec("COMMIT");
    snapshotOpen = false;
    renewLease(coordinator, build);
    await options.onPhase?.({ phase: "snapshot-complete", buildId: build.buildId, baseMutationSeq });

    let appliedMutationSeq = baseMutationSeq;
    for (;;) {
      const targetMutationSeq = getMutationHead(coordinator);
      let processedDocumentCount = 0;
      while (appliedMutationSeq < targetMutationSeq) {
        const journalPage = coordinator.prepare(`
          SELECT seq, document_id
          FROM cjk_index_mutations
          WHERE seq > ? AND seq <= ?
          ORDER BY seq
          LIMIT ?
        `).all(appliedMutationSeq, targetMutationSeq, BUILD_BATCH_SIZE) as {
          seq: number;
          document_id: number;
        }[];
        if (journalPage.length === 0) {
          throw new Error("CJK mutation journal has a gap before the target head");
        }
        const mutationIds = [...new Set(journalPage.map((row) => Number(row.document_id)))];
        await analyzeAndWriteMutationPage(coordinator, build, mutationIds, fixedLoader);
        processedDocumentCount += mutationIds.length;
        appliedMutationSeq = Number(journalPage[journalPage.length - 1]!.seq);
        const updated = coordinator.prepare(`
          UPDATE cjk_index_builds
          SET applied_mutation_seq = ?, updated_at = ?
          WHERE build_id = ? AND state = 'building'
            AND owner_pid = ? AND owner_start_token IS ?
        `).run(
          appliedMutationSeq,
          Date.now(),
          build.buildId,
          process.pid,
          build.ownerStartToken,
        );
        if (Number(updated.changes) !== 1) throw new Error("CJK rebuild lease ownership was lost");
        await options.onPhase?.({
          phase: "catchup-page-complete",
          buildId: build.buildId,
          targetMutationSeq,
          appliedMutationSeq,
          documentCount: mutationIds.length,
        });
      }
      await options.onPhase?.({
        phase: "catchup-complete",
        buildId: build.buildId,
        targetMutationSeq,
        documentCount: processedDocumentCount,
      });

      renewLease(coordinator, build);
      if (!validateShadowAtMutationHead(coordinator, build, appliedMutationSeq)) {
        continue;
      }
      renewLease(coordinator, build);

      coordinator.exec("BEGIN IMMEDIATE");
      try {
        const state = getCjkLexicalIndexState(coordinator);
        if (state.activeBuildId !== build.buildId) {
          throw new Error("CJK rebuild lease ownership was lost");
        }
        const lease = coordinator.prepare(`
          SELECT lease_expires_at
          FROM cjk_index_builds
          WHERE build_id = ? AND state = 'building'
            AND owner_pid = ? AND owner_start_token IS ?
        `).get(build.buildId, process.pid, build.ownerStartToken) as {
          lease_expires_at: number;
        } | undefined;
        if (!lease || Number(lease.lease_expires_at) < Date.now()) {
          throw new Error("CJK rebuild lease ownership was lost");
        }
        if (getMutationHead(coordinator) !== appliedMutationSeq) {
          coordinator.exec("ROLLBACK");
          renewLease(coordinator, build);
          continue;
        }
        publishShadowTables(coordinator, build, appliedMutationSeq);
        coordinator.exec("COMMIT");
      } catch (error) {
        try { coordinator.exec("ROLLBACK"); } catch {}
        throw error;
      }

      await options.onPhase?.({ phase: "published", buildId: build.buildId, generation: appliedMutationSeq });
      return {
        status: "ready",
        buildId: build.buildId,
        generation: appliedMutationSeq,
        fingerprint: getCjkAnalyzerFingerprint(),
        reused: false,
      };
    }
  } catch (error) {
    if (snapshotOpen) {
      try { snapshot.exec("ROLLBACK"); } catch {}
    }
    const diagnostic = error instanceof WordCapabilityLostError ? error.diagnostic : null;
    failBuild(coordinator, build, diagnostic);
    if (diagnostic) {
      return {
        status: "unavailable",
        diagnostic,
        publishedBuildId: getCjkLexicalIndexState(coordinator).publishedBuildId,
      };
    }
    throw error;
  } finally {
    snapshot.close();
    coordinator.close();
  }
}
