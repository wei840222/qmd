import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../src/db.js";
import { createStore as createSdkStore } from "../src/index.js";
import {
  createStore,
  deactivateDocument,
  deleteInactiveDocuments,
  findOrMigrateLegacyDocument,
  insertContent,
  insertDocument,
  normalizeCjkForFTS,
  removeCollection,
  renameCollection,
  searchFTS,
  updateDocument,
  updateDocumentWithContent,
  updateDocumentTitle,
  upsertStoreCollection,
} from "../src/store.js";
import { analyzeCjk } from "../src/search/cjk-analyzer.js";
import {
  setConfigWriteFaultInjectorForTests,
  type ConfigWriteStage,
} from "../src/collections.js";
import {
  getCjkAnalyzerFingerprint,
  getCjkLexicalIndexState,
  rebuildCjkLexicalIndex,
} from "../src/search/cjk-index.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-24T00:00:00.000Z";

afterEach(async () => {
  setConfigWriteFaultInjectorForTests();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createReadyFixture(): Promise<{ dbPath: string; db: Database }> {
  const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-mutations-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "index.sqlite");
  createStore(dbPath).close();
  const build = await rebuildCjkLexicalIndex(dbPath);
  expect(build.status).toBe("ready");
  return { dbPath, db: openDatabase(dbPath) };
}

function getDocument(db: Database, collection: string, path: string): {
  id: number;
  collection: string;
  path: string;
  title: string;
  body: string;
  active: number;
} {
  return db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, content.doc AS body, d.active
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.collection = ? AND d.path = ?
  `).get(collection, path) as {
    id: number;
    collection: string;
    path: string;
    title: string;
    body: string;
    active: number;
  };
}

async function expectDocumentSignals(db: Database, documentId: number): Promise<void> {
  const source = db.prepare(`
    SELECT d.collection || '/' || d.path AS filepath, d.title, content.doc AS body, d.active
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.id = ?
  `).get(documentId) as { filepath: string; title: string; body: string; active: number } | null | undefined;

  const tableRows = Object.fromEntries(
    ["documents_fts", "documents_fts_words", "documents_fts_bigrams"].map(tableName => [
      tableName,
      db.prepare(`SELECT filepath, title, body FROM ${tableName} WHERE rowid = ?`).get(documentId) as
        | { filepath: string; title: string; body: string }
        | null
        | undefined,
    ]),
  );

  if (source == null || source.active !== 1) {
    expect(tableRows.documents_fts == null).toBe(true);
    expect(tableRows.documents_fts_words == null).toBe(true);
    expect(tableRows.documents_fts_bigrams == null).toBe(true);
    return;
  }

  expect(tableRows.documents_fts).toEqual({
    filepath: normalizeCjkForFTS(source.filepath),
    title: normalizeCjkForFTS(source.title),
    body: normalizeCjkForFTS(source.body),
  });

  const filepath = await analyzeCjk(source.filepath);
  const title = await analyzeCjk(source.title);
  const body = await analyzeCjk(source.body);
  expect(tableRows.documents_fts_words).toEqual({
    filepath: filepath.word,
    title: title.word,
    body: body.word,
  });
  expect(tableRows.documents_fts_bigrams).toEqual({
    filepath: filepath.bigram,
    title: title.bigram,
    body: body.bigram,
  });
}

function expectReadyAtJournalHead(db: Database): void {
  const head = Number((db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM cjk_index_mutations`).get() as { seq: number }).seq);
  expect(getCjkLexicalIndexState(db)).toMatchObject({
    status: "ready",
    generation: head,
    analyzerFingerprint: getCjkAnalyzerFingerprint(),
    diagnosticCode: null,
  });
}

describe("CJK document mutation synchronization", () => {
  test("insert, update, title update, deactivate, and hard delete commit all lexical tables at one generation", async () => {
    const { db } = await createReadyFixture();
    try {
      insertContent(db, "hash-v1", "玉山同步器第一版", timestamp);
      insertDocument(db, "notes", "guide.md", "玉山指南", "hash-v1", timestamp, timestamp);
      const inserted = getDocument(db, "notes", "guide.md");
      await expectDocumentSignals(db, inserted.id);
      expectReadyAtJournalHead(db);

      insertContent(db, "hash-v2", "玉山同步器第二版資料庫", timestamp);
      updateDocument(db, inserted.id, "玉山更新指南", "hash-v2", timestamp);
      await expectDocumentSignals(db, inserted.id);
      expectReadyAtJournalHead(db);

      updateDocumentTitle(db, inserted.id, "玉山最終指南", timestamp);
      await expectDocumentSignals(db, inserted.id);
      expectReadyAtJournalHead(db);

      deactivateDocument(db, "notes", "guide.md");
      await expectDocumentSignals(db, inserted.id);
      expectReadyAtJournalHead(db);

      expect(deleteInactiveDocuments(db)).toBe(1);
      await expectDocumentSignals(db, inserted.id);
      expect(db.prepare(`SELECT 1 FROM content WHERE hash IN (?, ?) LIMIT 1`).get("hash-v1", "hash-v2") == null).toBe(true);
      expectReadyAtJournalHead(db);
    } finally {
      db.close();
    }
  });

  test("legacy path migration updates filepath identity in all lexical tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-legacy-mutation-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "index.sqlite");
    const seed = createStore(dbPath);
    insertContent(seed.db, "legacy-hash", "玉山舊路徑", timestamp);
    insertDocument(seed.db, "notes", "README.md", "舊指南", "legacy-hash", timestamp, timestamp);
    seed.close();
    expect((await rebuildCjkLexicalIndex(dbPath)).status).toBe("ready");

    const db = openDatabase(dbPath);
    try {
      const migrated = findOrMigrateLegacyDocument(db, "notes", "readme.md");
      expect(migrated).not.toBeNull();
      await expectDocumentSignals(db, migrated!.id);
      const charPath = db.prepare(`SELECT filepath FROM documents_fts WHERE rowid = ?`).get(migrated!.id) as { filepath: string };
      expect(charPath.filepath).toBe(normalizeCjkForFTS("notes/readme.md"));
      expect(db.prepare(`SELECT rowid FROM documents_fts_words WHERE rowid = ?`).get(migrated!.id) == null).toBe(false);
      expect(db.prepare(`SELECT rowid FROM documents_fts_bigrams WHERE rowid = ?`).get(migrated!.id) == null).toBe(false);
      expectReadyAtJournalHead(db);
    } finally {
      db.close();
    }
  });

  test("collection rename and removal update documents, metadata, and every lexical table atomically", async () => {
    const { db } = await createReadyFixture();
    try {
      upsertStoreCollection(db, "舊收藏", { path: "/tmp/old", pattern: "**/*.md" });
      insertContent(db, "collection-hash", "玉山收藏", timestamp);
      insertDocument(db, "舊收藏", "note.md", "收藏指南", "collection-hash", timestamp, timestamp);
      const document = getDocument(db, "舊收藏", "note.md");

      renameCollection(db, "舊收藏", "新收藏");
      expect(getDocument(db, "新收藏", "note.md").id).toBe(document.id);
      await expectDocumentSignals(db, document.id);
      expectReadyAtJournalHead(db);

      const removed = removeCollection(db, "新收藏");
      expect(removed.deletedDocs).toBe(1);
      await expectDocumentSignals(db, document.id);
      expectReadyAtJournalHead(db);
    } finally {
      db.close();
    }
  });

  test("collection rename collision rolls back document and metadata changes together", async () => {
    const { db } = await createReadyFixture();
    try {
      upsertStoreCollection(db, "old", { path: "/tmp/old", pattern: "**/*.md" });
      upsertStoreCollection(db, "taken", { path: "/tmp/taken", pattern: "**/*.md" });
      insertContent(db, "collision-hash", "玉山碰撞", timestamp);
      insertDocument(db, "old", "note.md", "碰撞指南", "collision-hash", timestamp, timestamp);
      const before = getDocument(db, "old", "note.md");

      expect(() => renameCollection(db, "old", "taken")).toThrow(/already exists/i);
      expect(getDocument(db, "old", "note.md").id).toBe(before.id);
      await expectDocumentSignals(db, before.id);
      expectReadyAtJournalHead(db);
    } finally {
      db.close();
    }
  });

  test("SDK collection rename and removal use the same document and lexical mutation path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-sdk-collection-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "index.sqlite");
    const seed = createStore(dbPath);
    insertContent(seed.db, "sdk-collection-hash", "玉山程式庫收藏", timestamp);
    insertDocument(seed.db, "舊收藏", "sdk.md", "程式庫指南", "sdk-collection-hash", timestamp, timestamp);
    const document = getDocument(seed.db, "舊收藏", "sdk.md");
    seed.close();
    expect((await rebuildCjkLexicalIndex(dbPath)).status).toBe("ready");

    const sdk = await createSdkStore({
      dbPath,
      config: {
        collections: {
          舊收藏: { path: directory, pattern: "**/*.md" },
        },
      },
    });
    try {
      expect(await sdk.renameCollection("舊收藏", "新收藏")).toBe(true);
      expect(getDocument(sdk.internal.db, "新收藏", "sdk.md").id).toBe(document.id);
      await expectDocumentSignals(sdk.internal.db, document.id);
      expectReadyAtJournalHead(sdk.internal.db);

      expect(await sdk.removeCollection("新收藏")).toBe(true);
      await expectDocumentSignals(sdk.internal.db, document.id);
      expectReadyAtJournalHead(sdk.internal.db);
    } finally {
      await sdk.close();
    }
  });

  test("SDK config-first rename is recovered on reopen after the SQLite mutation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-sdk-recovery-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "index.sqlite");
    const configPath = join(directory, "index.yml");
    await writeFile(configPath, JSON.stringify({
      collections: {
        old: { path: directory, pattern: "**/*.md" },
      },
    }), "utf8");

    const sdk = await createSdkStore({ dbPath, configPath });
    insertContent(sdk.internal.db, "sdk-recovery-hash", "玉山恢復測試", timestamp);
    insertDocument(sdk.internal.db, "old", "recover.md", "恢復指南", "sdk-recovery-hash", timestamp, timestamp);
    sdk.internal.db.exec(`
      CREATE TRIGGER fail_sdk_config_reconcile
      BEFORE UPDATE OF collection ON documents
      BEGIN
        SELECT RAISE(ABORT, 'injected SDK reconciliation failure');
      END
    `);

    try {
      await expect(sdk.renameCollection("old", "new")).rejects.toThrow("injected SDK reconciliation failure");
      expect(getDocument(sdk.internal.db, "old", "recover.md")).toBeTruthy();
      expect(sdk.internal.db.prepare(`SELECT 1 FROM documents WHERE collection = 'new'`).get() == null).toBe(true);
    } finally {
      await sdk.close();
    }

    const repair = openDatabase(dbPath);
    repair.exec(`DROP TRIGGER fail_sdk_config_reconcile`);
    repair.close();

    const reopened = await createSdkStore({ dbPath, configPath });
    try {
      expect(getDocument(reopened.internal.db, "new", "recover.md")).toBeTruthy();
      expect(reopened.internal.db.prepare(`SELECT 1 FROM documents WHERE collection = 'old'`).get() == null).toBe(true);
    } finally {
      await reopened.close();
    }
  });

  test.each(["before-temp-write", "before-rename"] satisfies ConfigWriteStage[])(
    "SDK config %s failure preserves old YAML and SQLite state",
    async failureStage => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-sdk-config-failure-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "index.sqlite");
    const configPath = join(directory, "index.yml");
    const originalYaml = JSON.stringify({
      collections: {
        old: { path: directory, pattern: "**/*.md" },
      },
    });
    await writeFile(configPath, originalYaml, "utf8");

    const sdk = await createSdkStore({ dbPath, configPath });
    insertContent(sdk.internal.db, "sdk-config-failure-hash", "玉山設定寫入失敗", timestamp);
    insertDocument(sdk.internal.db, "old", "unchanged.md", "不變指南", "sdk-config-failure-hash", timestamp, timestamp);
    setConfigWriteFaultInjectorForTests(stage => {
      if (stage === failureStage) throw new Error(`injected ${stage} failure`);
    });
    try {
      await expect(sdk.renameCollection("old", "new")).rejects.toThrow(`injected ${failureStage} failure`);
      expect(await readFile(configPath, "utf8")).toBe(originalYaml);
      expect(getDocument(sdk.internal.db, "old", "unchanged.md")).toBeTruthy();
      expect(sdk.internal.db.prepare(`SELECT 1 FROM documents WHERE collection = 'new'`).get() == null).toBe(true);
      expect(sdk.internal.db.prepare(`SELECT 1 FROM store_collections WHERE name = 'old'`).get()).toBeTruthy();
      expect(sdk.internal.db.prepare(`SELECT 1 FROM store_collections WHERE name = 'new'`).get() == null).toBe(true);
    } finally {
      await sdk.close();
    }
    },
  );

  test.each(["before-temp-write", "before-rename"] satisfies ConfigWriteStage[])(
    "SDK global context config %s failure preserves old YAML and SQLite state",
    async failureStage => {
      const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-sdk-global-context-failure-"));
      temporaryDirectories.push(directory);
      const dbPath = join(directory, "index.sqlite");
      const configPath = join(directory, "index.yml");
      const originalYaml = JSON.stringify({
        collections: {},
        global_context: "original context",
      });
      await writeFile(configPath, originalYaml, "utf8");

      const sdk = await createSdkStore({ dbPath, configPath });
      setConfigWriteFaultInjectorForTests(stage => {
        if (stage === failureStage) throw new Error(`injected ${stage} failure`);
      });
      try {
        await expect(sdk.setGlobalContext("should not commit")).rejects.toThrow(`injected ${failureStage} failure`);
        expect(await readFile(configPath, "utf8")).toBe(originalYaml);
        expect(await sdk.getGlobalContext()).toBe("original context");
      } finally {
        await sdk.close();
      }
    },
  );

  test("SDK update publishes the initial dirty generation at the maintenance boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-sdk-update-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "notes");
    await mkdir(root);
    await writeFile(join(root, "guide.md"), "# 台灣資料庫指南\n\n使用記憶體快取。\n", "utf8");
    const sdk = await createSdkStore({
      dbPath: join(directory, "index.sqlite"),
      config: {
        collections: {
          notes: { path: root, pattern: "**/*.md" },
        },
      },
    });

    try {
      await sdk.update();
      expect(getCjkLexicalIndexState(sdk.internal.db)).toMatchObject({
        status: "ready",
        analyzerFingerprint: getCjkAnalyzerFingerprint(),
        diagnosticCode: null,
      });
      const document = getDocument(sdk.internal.db, "notes", "guide.md");
      await expectDocumentSignals(sdk.internal.db, document.id);
    } finally {
      await sdk.close();
    }
  });

  test("raw document writes preserve char, invalidate word/bigram, append journal, and expose dirty remediation state", async () => {
    const { db } = await createReadyFixture();
    try {
      insertContent(db, "raw-hash", "玉山原始寫入", timestamp);
      insertDocument(db, "notes", "raw.md", "原始標題", "raw-hash", timestamp, timestamp);
      const document = getDocument(db, "notes", "raw.md");
      const generationBefore = getCjkLexicalIndexState(db).generation;

      db.prepare(`UPDATE documents SET title = ? WHERE id = ?`).run("直接改寫標題", document.id);

      const char = db.prepare(`SELECT title FROM documents_fts WHERE rowid = ?`).get(document.id) as { title: string };
      expect(char.title).toBe("直接改寫標題");
      expect(db.prepare(`SELECT 1 FROM documents_fts_words WHERE rowid = ?`).get(document.id) == null).toBe(true);
      expect(db.prepare(`SELECT 1 FROM documents_fts_bigrams WHERE rowid = ?`).get(document.id) == null).toBe(true);
      const state = getCjkLexicalIndexState(db) as ReturnType<typeof getCjkLexicalIndexState> & {
        dirtySinceMutationSeq: number | null;
      };
      expect(state).toMatchObject({
        status: "dirty",
        generation: generationBefore,
        diagnosticCode: "CJK_INDEX_RAW_WRITE",
      });
      expect(state.dirtySinceMutationSeq).toBeGreaterThan(generationBefore);
      expect(searchFTS(db, "改寫", 10).map(result => result.filepath)).toContain("qmd://notes/raw.md");
      expect(db.prepare(`SELECT title FROM documents_fts WHERE rowid = ?`).get(document.id)).toEqual({
        title: normalizeCjkForFTS("直接改寫標題"),
      });
      expect(db.prepare(`SELECT 1 FROM documents_fts_words WHERE rowid = ?`).get(document.id) == null).toBe(true);
    } finally {
      db.close();
    }
  });

  test("raw document insert preserves char but leaves word/bigram gated behind dirty state", async () => {
    const { db } = await createReadyFixture();
    try {
      insertContent(db, "raw-insert-hash", "玉山直接新增", timestamp);
      const generationBefore = getCjkLexicalIndexState(db).generation;
      const result = db.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run("notes", "insert.md", "直接新增標題", "raw-insert-hash", timestamp, timestamp);
      const documentId = Number(result.lastInsertRowid);

      expect(db.prepare(`SELECT title FROM documents_fts WHERE rowid = ?`).get(documentId)).toEqual({ title: "直接新增標題" });
      expect(db.prepare(`SELECT 1 FROM documents_fts_words WHERE rowid = ?`).get(documentId) == null).toBe(true);
      expect(getCjkLexicalIndexState(db)).toMatchObject({
        status: "dirty",
        generation: generationBefore,
        diagnosticCode: "CJK_INDEX_RAW_WRITE",
      });
      expect(searchFTS(db, "新增", 10).map(result => result.filepath)).toContain("qmd://notes/insert.md");
      expect(db.prepare(`SELECT title FROM documents_fts WHERE rowid = ?`).get(documentId)).toEqual({
        title: normalizeCjkForFTS("直接新增標題"),
      });
      expect(db.prepare(`SELECT 1 FROM documents_fts_words WHERE rowid = ?`).get(documentId) == null).toBe(true);
    } finally {
      db.close();
    }
  });

  test("raw document delete removes every lexical row and marks the published generation dirty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-raw-delete-"));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, "index.sqlite");
    const seed = createStore(dbPath);
    insertContent(seed.db, "raw-delete-hash", "玉山直接刪除", timestamp);
    insertDocument(seed.db, "notes", "delete.md", "直接刪除標題", "raw-delete-hash", timestamp, timestamp);
    const document = getDocument(seed.db, "notes", "delete.md");
    seed.close();
    expect((await rebuildCjkLexicalIndex(dbPath)).status).toBe("ready");

    const db = openDatabase(dbPath);
    try {
      const generationBefore = getCjkLexicalIndexState(db).generation;
      db.prepare(`DELETE FROM documents WHERE id = ?`).run(document.id);

      await expectDocumentSignals(db, document.id);
      expect(getCjkLexicalIndexState(db)).toMatchObject({
        status: "dirty",
        generation: generationBefore,
        diagnosticCode: "CJK_INDEX_RAW_WRITE",
      });
    } finally {
      db.close();
    }
  });

  test("a late index-state constraint failure rolls content, document, all FTS rows, and journal back", async () => {
    const { db } = await createReadyFixture();
    try {
      insertContent(db, "rollback-v1", "玉山回滾第一版", timestamp);
      insertDocument(db, "notes", "rollback.md", "回滾標題", "rollback-v1", timestamp, timestamp);
      const document = getDocument(db, "notes", "rollback.md");
      const beforeDocument = getDocument(db, "notes", "rollback.md");
      const beforeHead = Number((db.prepare(`SELECT MAX(seq) AS seq FROM cjk_index_mutations`).get() as { seq: number }).seq);
      const beforeWord = db.prepare(`SELECT filepath, title, body FROM documents_fts_words WHERE rowid = ?`).get(document.id);

      db.exec(`
        CREATE TRIGGER fail_cjk_generation_update
        BEFORE UPDATE OF generation ON cjk_index_state
        WHEN NEW.generation > OLD.generation
        BEGIN
          SELECT RAISE(ABORT, 'injected generation failure');
        END;
      `);
      expect(() => updateDocumentWithContent(
        db,
        "rollback-v2",
        "玉山回滾第二版",
        timestamp,
        document.id,
        "不應提交",
        timestamp,
      ))
        .toThrow(/injected generation failure/);

      expect(getDocument(db, "notes", "rollback.md")).toEqual(beforeDocument);
      expect(db.prepare(`SELECT 1 FROM content WHERE hash = ?`).get("rollback-v2") == null).toBe(true);
      expect(db.prepare(`SELECT filepath, title, body FROM documents_fts_words WHERE rowid = ?`).get(document.id)).toEqual(beforeWord);
      expect(Number((db.prepare(`SELECT MAX(seq) AS seq FROM cjk_index_mutations`).get() as { seq: number }).seq)).toBe(beforeHead);
      expectReadyAtJournalHead(db);
    } finally {
      db.close();
    }
  });

  test("Store stages content until document insertion commits every index signal atomically", async () => {
    const { dbPath, db } = await createReadyFixture();
    db.close();
    const store = createStore(dbPath);
    try {
      store.db.exec(`
        CREATE TRIGGER fail_store_generation_update
        BEFORE UPDATE OF generation ON cjk_index_state
        WHEN NEW.generation > OLD.generation
        BEGIN
          SELECT RAISE(ABORT, 'injected store generation failure');
        END;
      `);

      store.insertContent("staged-hash", "玉山暫存內容", timestamp);
      expect(store.db.prepare(`SELECT 1 FROM content WHERE hash = ?`).get("staged-hash") == null).toBe(true);
      expect(() => store.insertDocument(
        "notes",
        "staged.md",
        "暫存標題",
        "staged-hash",
        timestamp,
        timestamp,
      )).toThrow(/injected store generation failure/);

      expect(store.db.prepare(`SELECT 1 FROM content WHERE hash = ?`).get("staged-hash") == null).toBe(true);
      expect(store.db.prepare(`SELECT 1 FROM documents WHERE collection = ? AND path = ?`).get("notes", "staged.md") == null).toBe(true);
    } finally {
      store.close();
    }
  });
});
