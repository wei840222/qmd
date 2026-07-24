import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../src/db.js";
import {
  createStore,
  insertContent,
  insertDocument,
} from "../src/store.js";
import {
  CJK_ANALYZER_FINGERPRINT_SOURCE,
  cleanupExpiredCjkIndexBuilds,
  cleanupRetiredCjkIndexTables,
  computeCjkAnalyzerFingerprint,
  getCjkAnalyzerFingerprint,
  getCjkLexicalIndexState,
  getProcessStartToken,
  initializeCjkLexicalIndexSchema,
  rebuildCjkLexicalIndex,
} from "../src/search/cjk-index.js";
import type { JiebaCapabilityLoader } from "../src/search/cjk-analyzer.js";
import { createJiebaUnavailableCapability } from "../src/search/jieba-loader.js";
import {
  ZH_TW_TECH_DICTIONARY_SHA256,
  ZH_TW_TECH_DICTIONARY_VERSION,
} from "../src/search/zh-tw-tech-dictionary.js";

const now = "2026-01-01T00:00:00.000Z";
const tempDirs: string[] = [];

const availableLoader: JiebaCapabilityLoader = async () => ({
  available: true,
  cut: (text: string) => text.match(/玉山|同步器|資料庫|未知詞|連接|[A-Za-z0-9]+/gu) ?? [],
});

const unavailableLoader: JiebaCapabilityLoader = async () => createJiebaUnavailableCapability();

async function createFixture(): Promise<{ dbPath: string; db: Database }> {
  const dir = await mkdtemp(join(tmpdir(), "qmd-cjk-shadow-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "index.sqlite");
  const store = createStore(dbPath);
  return { dbPath, db: store.db };
}

function seedDocument(
  db: Database,
  id: { collection: string; path: string; title: string; hash: string; body: string },
): void {
  insertContent(db, id.hash, id.body, now);
  insertDocument(db, id.collection, id.path, id.title, id.hash, now, now);
}

function tableNames(db: Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CJK lexical shadow schema", () => {
  test("fresh open creates live word/bigram tables, registry, journal, and triggers without building", async () => {
    const { db } = await createFixture();
    try {
      const tables = tableNames(db);
      for (const name of [
        "documents_fts_words",
        "documents_fts_bigrams",
        "cjk_index_state",
        "cjk_index_builds",
        "cjk_index_mutations",
      ]) {
        expect(tables.has(name), name).toBe(true);
      }

      for (const name of ["documents_fts_words", "documents_fts_bigrams"]) {
        const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql: string };
        expect(row.sql).toContain("filepath");
        expect(row.sql).toContain("title");
        expect(row.sql).toContain("body");
        expect(row.sql).toMatch(/tokenize\s*=\s*'unicode61'/);
      }

      const triggers = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'documents_cjk_journal_%'
        ORDER BY name
      `).all() as { name: string }[];
      expect(triggers.map((row) => row.name)).toEqual([
        "documents_cjk_journal_ad",
        "documents_cjk_journal_ai",
        "documents_cjk_journal_au",
      ]);

      expect(getCjkLexicalIndexState(db)).toMatchObject({
        status: "empty",
        generation: 0,
        analyzerFingerprint: null,
        activeBuildId: null,
      });
    } finally {
      db.close();
    }
  });

  test("schema v1 upgrades in place with a dirty sequence marker and raw-write triggers", async () => {
    const { dbPath, db } = await createFixture();
    let currentDb = db;
    try {
      currentDb.exec(`
        DROP TRIGGER documents_cjk_journal_ai;
        DROP TRIGGER documents_cjk_journal_au;
        DROP TRIGGER documents_cjk_journal_ad;
        DROP TABLE cjk_index_state;
        CREATE TABLE cjk_index_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL CHECK (status IN ('empty', 'building', 'ready', 'dirty', 'unavailable')),
          generation INTEGER NOT NULL DEFAULT 0,
          analyzer_fingerprint TEXT,
          word_capability TEXT NOT NULL DEFAULT 'unknown',
          diagnostic_code TEXT,
          active_build_id TEXT,
          published_build_id TEXT,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO cjk_index_state(singleton, status, updated_at) VALUES (1, 'empty', 0);
        UPDATE store_config SET value = '1' WHERE key = 'cjk_index_schema_version';
      `);
      currentDb.close();
      currentDb = openDatabase(dbPath);

      initializeCjkLexicalIndexSchema(currentDb);

      const columns = currentDb.prepare(`PRAGMA table_info(cjk_index_state)`).all() as { name: string }[];
      expect(columns.map((column) => column.name)).toContain("dirty_since_mutation_seq");
      expect(currentDb.prepare(`SELECT value FROM store_config WHERE key = 'cjk_index_schema_version'`).get()).toEqual({ value: "3" });
      const buildColumns = currentDb.prepare(`PRAGMA table_info(cjk_index_builds)`).all() as { name: string }[];
      expect(buildColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "owner_start_token",
        "retired_words_table",
        "retired_bigrams_table",
      ]));
      const triggerSql = currentDb.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'documents_cjk_journal_au'
      `).get() as { sql: string };
      expect(triggerSql.sql).toContain("CJK_INDEX_RAW_WRITE");
      expect(triggerSql.sql).toContain("dirty_since_mutation_seq");
    } finally {
      currentDb.close();
    }
  });

  test("fingerprint covers every analyzer policy and the versioned dictionary", () => {
    expect(CJK_ANALYZER_FINGERPRINT_SOURCE.dictionaryVersion).toBe(ZH_TW_TECH_DICTIONARY_VERSION);
    expect(CJK_ANALYZER_FINGERPRINT_SOURCE.dictionarySha256).toBe(ZH_TW_TECH_DICTIONARY_SHA256);
    expect(getCjkAnalyzerFingerprint()).toBe(computeCjkAnalyzerFingerprint(CJK_ANALYZER_FINGERPRINT_SOURCE));

    for (const key of Object.keys(CJK_ANALYZER_FINGERPRINT_SOURCE) as (keyof typeof CJK_ANALYZER_FINGERPRINT_SOURCE)[]) {
      const changed = { ...CJK_ANALYZER_FINGERPRINT_SOURCE, [key]: `${CJK_ANALYZER_FINGERPRINT_SOURCE[key]}-changed` };
      expect(computeCjkAnalyzerFingerprint(changed), String(key)).not.toBe(getCjkAnalyzerFingerprint());
    }
  });

  test("successful build publishes complete rowid-equivalent word and bigram indexes", async () => {
    const { dbPath, db } = await createFixture();
    seedDocument(db, {
      collection: "notes",
      path: "sync.md",
      title: "玉山同步器",
      hash: "hash-a",
      body: "玉山同步器連接資料庫",
    });
    seedDocument(db, {
      collection: "notes",
      path: "unknown.md",
      title: "未知詞",
      hash: "hash-b",
      body: "未知詞",
    });
    db.close();

    const result = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(result.status).toBe("ready");

    const verify = openDatabase(dbPath);
    try {
      const activeIds = verify.prepare(`SELECT id FROM documents WHERE active = 1 ORDER BY id`).all() as { id: number }[];
      const wordIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_words ORDER BY rowid`).all() as { id: number }[];
      const bigramIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_bigrams ORDER BY rowid`).all() as { id: number }[];
      expect(wordIds).toEqual(activeIds);
      expect(bigramIds).toEqual(activeIds);

      const wordHit = verify.prepare(`
        SELECT rowid FROM documents_fts_words
        WHERE documents_fts_words MATCH '"玉山"'
      `).get();
      const bigramHit = verify.prepare(`
        SELECT rowid FROM documents_fts_bigrams
        WHERE documents_fts_bigrams MATCH '"玉山"'
      `).get();
      expect(wordHit).toBeTruthy();
      expect(bigramHit).toBeTruthy();

      const state = getCjkLexicalIndexState(verify);
      expect(state).toMatchObject({
        status: "ready",
        analyzerFingerprint: getCjkAnalyzerFingerprint(),
        wordCapability: "available",
      });
      expect(state.generation).toBeGreaterThanOrEqual(2);
      expect(state.activeBuildId).toBeNull();
      const retired = verify.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds
        WHERE build_id = ?
      `).get(result.status === "ready" ? result.buildId : "") as {
        retired_words_table: string;
        retired_bigrams_table: string;
      };
      expect(retired.retired_words_table).toMatch(/^documents_fts_words_old_[a-f0-9]+$/);
      expect(retired.retired_bigrams_table).toMatch(/^documents_fts_bigrams_old_[a-f0-9]+$/);
      const tables = tableNames(verify);
      expect(tables.has(retired.retired_words_table)).toBe(true);
      expect(tables.has(retired.retired_bigrams_table)).toBe(true);
    } finally {
      verify.close();
    }
  });

  test("successive rebuilds keep retired FTS tables at a fixed bound", async () => {
    const { dbPath, db } = await createFixture();
    seedDocument(db, {
      collection: "notes",
      path: "bounded.md",
      title: "玉山",
      hash: "hash-bounded",
      body: "資料庫同步器",
    });
    db.close();

    for (let index = 0; index < 4; index++) {
      const result = await rebuildCjkLexicalIndex(dbPath, {
        force: index > 0,
        loadCapability: availableLoader,
      });
      expect(result.status).toBe("ready");
    }

    const verify = openDatabase(dbPath);
    try {
      const registered = verify.prepare(`
        SELECT COUNT(*) AS count
        FROM cjk_index_builds
        WHERE retired_words_table IS NOT NULL OR retired_bigrams_table IS NOT NULL
      `).get() as { count: number };
      expect(Number(registered.count)).toBe(1);
      const retiredTables = Array.from(tableNames(verify)).filter((name) => (
        /^documents_fts_(?:words|bigrams)_old_[a-f0-9]+$/u.test(name)
      ));
      expect(retiredTables).toHaveLength(2);
    } finally {
      verify.close();
    }
  });

  test("retired table cleanup is idempotent after a partially missing pair", async () => {
    const { dbPath, db } = await createFixture();
    db.close();
    const built = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;

    const cleanup = openDatabase(dbPath);
    try {
      const retired = cleanup.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId) as {
        retired_words_table: string;
        retired_bigrams_table: string;
      };
      cleanup.exec(`DROP TABLE "${retired.retired_words_table}"`);

      expect(cleanupRetiredCjkIndexTables(cleanup)).toEqual([built.buildId]);
      expect(tableNames(cleanup).has(retired.retired_words_table)).toBe(false);
      expect(tableNames(cleanup).has(retired.retired_bigrams_table)).toBe(false);
      expect(cleanup.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId)).toEqual({
        retired_words_table: null,
        retired_bigrams_table: null,
      });
      expect(cleanupRetiredCjkIndexTables(cleanup)).toEqual([]);
    } finally {
      cleanup.close();
    }
  });

  test("retired table cleanup rejects an unowned identifier without clearing its tombstone", async () => {
    const { dbPath, db } = await createFixture();
    db.close();
    const built = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;

    const cleanup = openDatabase(dbPath);
    try {
      cleanup.prepare(`
        UPDATE cjk_index_builds SET retired_words_table = 'documents'
        WHERE build_id = ?
      `).run(built.buildId);
      expect(() => cleanupRetiredCjkIndexTables(cleanup)).toThrow("Invalid retired CJK index table identifier");
      expect(tableNames(cleanup).has("documents")).toBe(true);
      const retained = cleanup.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId) as {
        retired_words_table: string;
        retired_bigrams_table: string;
      };
      expect(retained.retired_words_table).toBe("documents");
      expect(retained.retired_bigrams_table).toMatch(/^documents_fts_bigrams_old_[a-f0-9]+$/u);
      expect(tableNames(cleanup).has(retained.retired_bigrams_table)).toBe(true);
    } finally {
      cleanup.close();
    }
  });

  test("retired table cleanup diagnoses an incomplete tombstone without leaking silently", async () => {
    const { dbPath, db } = await createFixture();
    db.close();
    const built = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;

    const cleanup = openDatabase(dbPath);
    try {
      const retired = cleanup.prepare(`
        SELECT retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId) as { retired_bigrams_table: string };
      cleanup.prepare(`
        UPDATE cjk_index_builds SET retired_words_table = NULL
        WHERE build_id = ?
      `).run(built.buildId);

      expect(() => cleanupRetiredCjkIndexTables(cleanup)).toThrow(
        "Incomplete retired CJK index table tombstone",
      );
      expect(tableNames(cleanup).has(retired.retired_bigrams_table)).toBe(true);
      expect(cleanup.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId)).toEqual({
        retired_words_table: null,
        retired_bigrams_table: retired.retired_bigrams_table,
      });
    } finally {
      cleanup.close();
    }
  });

  test("retired table cleanup rejects duplicate registry ownership", async () => {
    const { dbPath, db } = await createFixture();
    db.close();
    const built = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;

    const cleanup = openDatabase(dbPath);
    try {
      const retired = cleanup.prepare(`
        SELECT retired_words_table, retired_bigrams_table
        FROM cjk_index_builds WHERE build_id = ?
      `).get(built.buildId) as {
        retired_words_table: string;
        retired_bigrams_table: string;
      };
      cleanup.prepare(`
        INSERT INTO cjk_index_builds(
          build_id, state, base_mutation_seq, applied_mutation_seq,
          analyzer_fingerprint, owner_pid, lease_expires_at,
          words_table, bigrams_table, retired_words_table, retired_bigrams_table,
          started_at, updated_at
        ) VALUES ('duplicate-retired-owner', 'ready', 0, 0, 'test', ?, 0,
          'documents_fts_words_build_duplicate', 'documents_fts_bigrams_build_duplicate',
          ?, ?, 0, 1)
      `).run(process.pid, retired.retired_words_table, retired.retired_bigrams_table);

      expect(() => cleanupRetiredCjkIndexTables(cleanup)).toThrow(
        "Retired CJK index table is registered to another build",
      );
      expect(tableNames(cleanup).has(retired.retired_words_table)).toBe(true);
      expect(tableNames(cleanup).has(retired.retired_bigrams_table)).toBe(true);
      const registrations = cleanup.prepare(`
        SELECT COUNT(*) AS count FROM cjk_index_builds
        WHERE retired_words_table = ? AND retired_bigrams_table = ?
      `).get(retired.retired_words_table, retired.retired_bigrams_table) as { count: number };
      expect(Number(registrations.count)).toBe(2);
    } finally {
      cleanup.close();
    }
  });

  test("default rebuild exposes jieba unavailable without replacing a previously ready generation", async () => {
    const { dbPath, db } = await createFixture();
    seedDocument(db, {
      collection: "notes",
      path: "sync.md",
      title: "玉山同步器",
      hash: "hash-a",
      body: "玉山同步器連接資料庫",
    });
    db.close();

    const ready = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(ready.status).toBe("ready");

    const before = openDatabase(dbPath);
    const priorRows = before.prepare(`SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid`).all();
    const priorBuild = getCjkLexicalIndexState(before).publishedBuildId;
    before.close();

    const unavailable = await rebuildCjkLexicalIndex(dbPath, { loadCapability: unavailableLoader });
    expect(unavailable.status).toBe("unavailable");

    const after = openDatabase(dbPath);
    try {
      expect(after.prepare(`SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid`).all()).toEqual(priorRows);
      expect(getCjkLexicalIndexState(after)).toMatchObject({
        status: "unavailable",
        publishedBuildId: priorBuild,
        wordCapability: "unavailable",
        diagnosticCode: "JIEBA_NATIVE_UNAVAILABLE",
      });
      const leaked = Array.from(tableNames(after)).filter((name) => /^documents_fts_(?:words|bigrams)_build_/.test(name));
      expect(leaked).toEqual([]);
    } finally {
      after.close();
    }
  });

  test("segmentation failure after a flushed batch preserves the published generation and records an accurate diagnostic", async () => {
    const { dbPath, db } = await createFixture();
    for (let index = 0; index < 201; index++) {
      seedDocument(db, {
        collection: "中文筆記",
        path: `文件${index}.md`,
        title: `玉山標題${index}`,
        hash: `hash-analysis-${index}`,
        body: index === 200 ? "分析失敗" : `資料庫內容${index}`,
      });
    }
    db.close();

    const ready = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;

    const before = openDatabase(dbPath);
    const priorRows = before.prepare(`
      SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid
    `).all();
    const priorState = getCjkLexicalIndexState(before);
    before.close();

    const failed = await rebuildCjkLexicalIndex(dbPath, {
      force: true,
      loadCapability: async () => ({
        available: true,
        cut: (text: string) => {
          if (text.includes("分析失敗")) throw new Error("sensitive native failure detail");
          return [text];
        },
      }),
    });
    expect(failed.status).toBe("unavailable");
    if (failed.status !== "unavailable") return;
    expect(failed.diagnostic.code).toBe("CJK_ANALYZER_FAILED");
    expect(JSON.stringify(failed)).not.toContain("sensitive native failure detail");

    const after = openDatabase(dbPath);
    try {
      expect(after.prepare(`
        SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid
      `).all()).toEqual(priorRows);
      expect(getCjkLexicalIndexState(after)).toMatchObject({
        status: "unavailable",
        generation: priorState.generation,
        publishedBuildId: priorState.publishedBuildId,
        activeBuildId: null,
        wordCapability: "unavailable",
        diagnosticCode: "CJK_ANALYZER_FAILED",
      });
      const leaked = Array.from(tableNames(after)).filter((name) => (
        /^documents_fts_(?:words|bigrams)_build_/u.test(name)
      ));
      expect(leaked).toEqual([]);
      expect(after.prepare(`
        SELECT COUNT(*) AS count FROM cjk_index_builds WHERE state = 'failed'
      `).get()).toEqual({ count: 1 });
    } finally {
      after.close();
    }
  });

  test("a persisted analyzer fingerprint mismatch forces a new published build", async () => {
    const fixture = await createFixture();
    seedDocument(fixture.db, {
      collection: "notes",
      path: "fingerprint.md",
      title: "玉山",
      hash: "hash-fingerprint",
      body: "同步器",
    });
    fixture.db.close();

    const first = await rebuildCjkLexicalIndex(fixture.dbPath, { loadCapability: availableLoader });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    const tamper = openDatabase(fixture.dbPath);
    tamper.prepare(`
      UPDATE cjk_index_state SET analyzer_fingerprint = 'stale-fingerprint' WHERE singleton = 1
    `).run();
    tamper.close();

    const second = await rebuildCjkLexicalIndex(fixture.dbPath, { loadCapability: availableLoader });
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.reused).toBe(false);
    expect(second.buildId).not.toBe(first.buildId);

    const verify = openDatabase(fixture.dbPath);
    try {
      expect(getCjkLexicalIndexState(verify)).toMatchObject({
        status: "ready",
        analyzerFingerprint: getCjkAnalyzerFingerprint(),
        publishedBuildId: second.buildId,
      });
    } finally {
      verify.close();
    }
  });

  test("cleanup only removes an expired build whose owner no longer exists", async () => {
    const { db } = await createFixture();
    const deadBuildId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const aliveBuildId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const reusedBuildId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    try {
      db.exec(`CREATE VIRTUAL TABLE documents_fts_words_build_aaaaaaaaaaaaaaaaaaaa USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE documents_fts_bigrams_build_aaaaaaaaaaaaaaaaaaaa USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE documents_fts_words_build_bbbbbbbbbbbbbbbbbbbb USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE documents_fts_bigrams_build_bbbbbbbbbbbbbbbbbbbb USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE documents_fts_words_build_cccccccccccccccccccc USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE documents_fts_bigrams_build_cccccccccccccccccccc USING fts5(filepath, title, body, tokenize='unicode61')`);
      const insert = db.prepare(`
        INSERT INTO cjk_index_builds(
          build_id, state, base_mutation_seq, applied_mutation_seq,
          analyzer_fingerprint, owner_pid, owner_start_token, lease_expires_at,
          words_table, bigrams_table, started_at, updated_at
        ) VALUES (?, 'building', 0, 0, 'test', ?, ?, 0, ?, ?, 0, 0)
      `);
      insert.run(deadBuildId, 999_999_999, null, "documents_fts_words_build_aaaaaaaaaaaaaaaaaaaa", "documents_fts_bigrams_build_aaaaaaaaaaaaaaaaaaaa");
      insert.run(aliveBuildId, process.pid, getProcessStartToken(), "documents_fts_words_build_bbbbbbbbbbbbbbbbbbbb", "documents_fts_bigrams_build_bbbbbbbbbbbbbbbbbbbb");
      const startToken = getProcessStartToken();
      insert.run(
        reusedBuildId,
        process.pid,
        startToken === null ? null : `${startToken}-different-owner`,
        "documents_fts_words_build_cccccccccccccccccccc",
        "documents_fts_bigrams_build_cccccccccccccccccccc",
      );

      expect(cleanupExpiredCjkIndexBuilds(db, { nowMs: 1 })).toEqual(
        startToken === null ? [deadBuildId] : [deadBuildId, reusedBuildId],
      );
      const tables = tableNames(db);
      expect(tables.has("documents_fts_words_build_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
      expect(tables.has("documents_fts_bigrams_build_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
      expect(tables.has("documents_fts_words_build_bbbbbbbbbbbbbbbbbbbb")).toBe(true);
      expect(tables.has("documents_fts_bigrams_build_bbbbbbbbbbbbbbbbbbbb")).toBe(true);
      expect(tables.has("documents_fts_words_build_cccccccccccccccccccc")).toBe(startToken === null);
      expect(tables.has("documents_fts_bigrams_build_cccccccccccccccccccc")).toBe(startToken === null);
    } finally {
      db.close();
    }
  });

  test("expired build cleanup rejects live CJK index table identifiers", async () => {
    const { db } = await createFixture();
    try {
      db.prepare(`
        INSERT INTO cjk_index_builds(
          build_id, state, base_mutation_seq, applied_mutation_seq,
          analyzer_fingerprint, owner_pid, owner_start_token, lease_expires_at,
          words_table, bigrams_table, started_at, updated_at
        ) VALUES (?, 'building', 0, 0, 'test', ?, NULL, 0, ?, ?, 0, 0)
      `).run(
        "expired-live-owner",
        999_999_999,
        "documents_fts_words",
        "documents_fts_bigrams",
      );

      expect(() => cleanupExpiredCjkIndexBuilds(db, { nowMs: 1 }))
        .toThrow("Invalid CJK build table identifier");
      const tables = tableNames(db);
      expect(tables.has("documents_fts_words")).toBe(true);
      expect(tables.has("documents_fts_bigrams")).toBe(true);
      expect(db.prepare(`
        SELECT state FROM cjk_index_builds WHERE build_id = 'expired-live-owner'
      `).get()).toEqual({ state: "building" });
    } finally {
      db.close();
    }
  });

  test("expired build cleanup rejects tables registered to another active build", async () => {
    const { db } = await createFixture();
    const activeBuildId = "11111111-1111-1111-1111-222222222222";
    const expiredBuildId = "11111111-1111-1111-1111-333333333333";
    const wordsTable = "documents_fts_words_build_11111111111111111111";
    const bigramsTable = "documents_fts_bigrams_build_11111111111111111111";
    try {
      db.exec(`CREATE VIRTUAL TABLE ${wordsTable} USING fts5(filepath, title, body, tokenize='unicode61')`);
      db.exec(`CREATE VIRTUAL TABLE ${bigramsTable} USING fts5(filepath, title, body, tokenize='unicode61')`);
      const insert = db.prepare(`
        INSERT INTO cjk_index_builds(
          build_id, state, base_mutation_seq, applied_mutation_seq,
          analyzer_fingerprint, owner_pid, owner_start_token, lease_expires_at,
          words_table, bigrams_table, started_at, updated_at
        ) VALUES (?, 'building', 0, 0, 'test', ?, ?, ?, ?, ?, 0, 0)
      `);
      insert.run(
        activeBuildId,
        process.pid,
        getProcessStartToken(),
        10_000,
        wordsTable,
        bigramsTable,
      );
      insert.run(
        expiredBuildId,
        999_999_999,
        null,
        0,
        wordsTable,
        bigramsTable,
      );

      expect(() => cleanupExpiredCjkIndexBuilds(db, { nowMs: 1 }))
        .toThrow("CJK build table is registered to another build");
      const tables = tableNames(db);
      expect(tables.has(wordsTable)).toBe(true);
      expect(tables.has(bigramsTable)).toBe(true);
      expect(db.prepare(`SELECT state FROM cjk_index_builds WHERE build_id = ?`)
        .get(expiredBuildId)).toEqual({ state: "building" });
    } finally {
      db.close();
    }
  });
});
