import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type Database } from "../src/db.js";
import {
  createStore,
  deactivateDocument,
  deleteInactiveDocuments,
  insertContent,
  insertDocument,
  removeCollection,
  updateDocumentTitle,
  upsertStoreCollection,
} from "../src/store.js";
import {
  getCjkLexicalIndexState,
  rebuildCjkLexicalIndex,
} from "../src/search/cjk-index.js";
import {
  setSynchronousJiebaCapabilityForTests,
  type JiebaCapability,
} from "../src/search/jieba-loader.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-24T00:00:00.000Z";

const unavailableCapability: JiebaCapability = {
  available: false,
  diagnostic: {
    code: "JIEBA_NATIVE_UNAVAILABLE",
    message: "Chinese word segmentation is unavailable for this runtime.",
    runtime: "test-runtime",
    remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.",
  },
};

afterEach(async () => {
  setSynchronousJiebaCapabilityForTests();
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function createReadyFixture(): Promise<{ db: Database; documentId: number }> {
  const directory = await mkdtemp(join(tmpdir(), "qmd-cjk-word-index-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "index.sqlite");
  const seed = createStore(dbPath);
  upsertStoreCollection(seed.db, "notes", { path: directory, pattern: "**/*.md" });
  insertContent(seed.db, "seed-hash", "玉山同步資料", timestamp);
  insertDocument(
    seed.db,
    "notes",
    "guide.md",
    "同步指南",
    "seed-hash",
    timestamp,
    timestamp,
  );
  const document = seed.db.prepare(`
    SELECT id FROM documents WHERE collection = 'notes' AND path = 'guide.md'
  `).get() as { id: number };
  seed.close();

  const rebuilt = await rebuildCjkLexicalIndex(dbPath);
  expect(rebuilt.status).toBe("ready");
  return { db: openDatabase(dbPath), documentId: document.id };
}

function snapshot(db: Database): unknown {
  return {
    documents: db.prepare(`SELECT * FROM documents ORDER BY id`).all(),
    content: db.prepare(`SELECT * FROM content ORDER BY hash`).all(),
    collections: db.prepare(`SELECT * FROM store_collections ORDER BY name`).all(),
    char: db.prepare(`SELECT rowid, filepath, title, body FROM documents_fts ORDER BY rowid`).all(),
    words: db.prepare(`SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid`).all(),
    bigrams: db.prepare(`SELECT rowid, filepath, title, body FROM documents_fts_bigrams ORDER BY rowid`).all(),
    journal: db.prepare(`SELECT * FROM cjk_index_mutations ORDER BY seq`).all(),
    state: getCjkLexicalIndexState(db),
  };
}

describe("T7 synchronized CJK word-index mutations", () => {
  test("publishes char, word, and bigram rows at the journal head", async () => {
    const { db, documentId } = await createReadyFixture();
    try {
      for (const table of ["documents_fts", "documents_fts_words", "documents_fts_bigrams"]) {
        expect(db.prepare(`SELECT 1 FROM ${table} WHERE rowid = ?`).get(documentId)).toBeTruthy();
      }
      const head = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM cjk_index_mutations`).get() as {
        seq: number;
      };
      expect(getCjkLexicalIndexState(db)).toMatchObject({
        status: "ready",
        generation: head.seq,
      });
    } finally {
      db.close();
    }
  });

  test("analyzer failure rolls the document, all lexical rows, journal, and generation back", async () => {
    const { db, documentId } = await createReadyFixture();
    try {
      const before = snapshot(db);
      setSynchronousJiebaCapabilityForTests(unavailableCapability);

      expect(() => updateDocumentTitle(db, documentId, "不應提交", timestamp))
        .toThrow(/JIEBA_NATIVE_UNAVAILABLE/);
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("hard-delete late failure restores the document, content, lexical rows, and journal", async () => {
    const { db } = await createReadyFixture();
    try {
      deactivateDocument(db, "notes", "guide.md");
      const before = snapshot(db);
      db.exec(`
        CREATE TRIGGER fail_after_document_delete
        AFTER DELETE ON documents
        WHEN OLD.hash = 'seed-hash'
        BEGIN
          SELECT RAISE(ABORT, 'injected hard-delete late failure');
        END
      `);

      expect(() => deleteInactiveDocuments(db)).toThrow(/injected hard-delete late failure/);
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("removeCollection late failure restores metadata, documents, content, lexical rows, and journal", async () => {
    const { db } = await createReadyFixture();
    try {
      const before = snapshot(db);
      db.exec(`
        CREATE TRIGGER fail_after_collection_metadata_delete
        AFTER DELETE ON store_collections
        WHEN OLD.name = 'notes'
        BEGIN
          SELECT RAISE(ABORT, 'injected removeCollection late failure');
        END
      `);

      expect(() => removeCollection(db, "notes")).toThrow(/injected removeCollection late failure/);
      expect(snapshot(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});
