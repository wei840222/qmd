import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import {
  createStore,
  getLexicalStrongSignal,
  insertContent,
  insertDocument,
  searchFTS,
} from "../src/store.js";
import { rebuildCjkLexicalIndex } from "../src/search/cjk-index.js";
import {
  setSynchronousJiebaCapabilityForTests,
  type JiebaCapability,
} from "../src/search/jieba-loader.js";

const now = "2026-01-01T00:00:00.000Z";
const tempDirs: string[] = [];
const unavailableCapability: JiebaCapability = {
  available: false,
  diagnostic: {
    code: "JIEBA_NATIVE_UNAVAILABLE",
    message: "Chinese word segmentation is unavailable for this runtime.",
    runtime: "test-runtime",
    remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.",
  },
};

async function createFixture(options: { build?: boolean } = {}): Promise<{ dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "qmd-cjk-search-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "index.sqlite");
  const store = createStore(dbPath);

  insertContent(store.db, "hash-sync", "資料庫同步器提供可靠的資料同步功能", now);
  insertDocument(store.db, "notes", "sync.md", "資料庫同步器", "hash-sync", now, now);
  insertContent(store.db, "hash-backup", "資料庫備份與還原操作手冊", now);
  insertDocument(store.db, "notes", "backup.md", "資料庫備份", "hash-backup", now, now);
  store.close();

  if (options.build !== false) {
    const build = await rebuildCjkLexicalIndex(dbPath);
    expect(build.status).toBe("ready");
  }
  return { dbPath };
}

afterEach(async () => {
  setSynchronousJiebaCapabilityForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CJK lexical search", () => {
  test("applies a collection filter before truncating each lexical channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-cjk-collection-filter-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "index.sqlite");
    const store = createStore(dbPath);
    try {
      for (let index = 0; index < 601; index++) {
        const hash = `hash-noise-${index}`;
        insertContent(store.db, hash, "資料庫同步 資料庫同步 資料庫同步", now);
        insertDocument(store.db, "noise", `noise-${index}.md`, "資料庫同步", hash, now, now);
      }
      insertContent(store.db, "hash-filter-target", "資料庫同步", now);
      insertDocument(store.db, "target", "only.md", "目標", "hash-filter-target", now, now);

      const results = searchFTS(store.db, "資料庫同步", 10, "target");

      expect(results.map(result => result.filepath)).toEqual(["qmd://target/only.md"]);
    } finally {
      store.close();
    }
  });

  test("evaluates strong signal from each channel backend score instead of fused ordering", () => {
    const results = [
      {
        filepath: "qmd://notes/a.md",
        score: 0.9,
        lexicalTrace: {
          contributions: [
            { channel: "char", backendScore: 0.9 },
            { channel: "word", backendScore: 0.95 },
          ],
        },
      },
      {
        filepath: "qmd://notes/b.md",
        score: 0.88,
        lexicalTrace: {
          contributions: [
            { channel: "char", backendScore: 0.88 },
            { channel: "word", backendScore: 0.5 },
          ],
        },
      },
    ] as any;

    const signal = getLexicalStrongSignal(results);
    expect(signal).toMatchObject({
      strong: true,
      channel: "word",
      topScore: 0.95,
    });
    expect(signal.gap).toBeCloseTo(0.45, 10);
  });

  test("fuses ready char, word, and bigram channels without replacing the public BM25 score", async () => {
    const { dbPath } = await createFixture();
    const db = openDatabase(dbPath);
    try {
      const results = searchFTS(db, "資料庫同步", 10, "notes");

      expect(results.map((result) => result.displayPath)).toEqual(["notes/sync.md"]);

      const first = results[0]!;
      expect(first.source).toBe("fts");
      expect(first.score).toBeGreaterThanOrEqual(0);
      expect(first.score).toBeLessThan(1);
      expect(first.lexicalTrace?.channels).toEqual([
        expect.objectContaining({ channel: "char", status: "used" }),
        expect.objectContaining({ channel: "word", status: "used" }),
        expect.objectContaining({ channel: "bigram", status: "used" }),
      ]);
      expect(first.lexicalTrace?.contributions.map((entry) => entry.channel).sort()).toEqual([
        "bigram",
        "char",
        "word",
      ]);
      expect(first.lexicalTrace?.contributions.every((entry) => (
        entry.rank >= 1
        && entry.backendScore >= 0
        && entry.backendScore < 1
        && entry.rrfContribution > 0
      ))).toBe(true);
      expect(first.score).toBeCloseTo(
        Math.max(...first.lexicalTrace!.contributions.map((entry) => entry.backendScore)),
        10,
      );
      expect(first.lexicalTrace!.fusionScore).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("falls back to char search and explains omitted channels before the lexical index is ready", async () => {
    const { dbPath } = await createFixture({ build: false });
    const db = openDatabase(dbPath);
    try {
      const results = searchFTS(db, "資料庫同步", 10, "notes");

      expect(results.map((result) => result.displayPath)).toEqual(["notes/sync.md"]);
      expect(results[0]?.lexicalTrace?.channels).toEqual([
        { channel: "char", status: "used" },
        { channel: "word", status: "omitted", reason: "index-dirty" },
        { channel: "bigram", status: "omitted", reason: "index-dirty" },
      ]);
      expect(results[0]?.lexicalTrace?.contributions.map((entry) => entry.channel)).toEqual(["char"]);
    } finally {
      db.close();
    }
  });

  test("omits both analyzed channels when Jieba is unavailable after a ready build", async () => {
    const { dbPath } = await createFixture();
    const db = openDatabase(dbPath);
    try {
      setSynchronousJiebaCapabilityForTests(unavailableCapability);
      const results = searchFTS(db, "資料庫同步", 10, "notes");

      expect(results.map((result) => result.displayPath)).toEqual(["notes/sync.md"]);
      expect(results[0]?.lexicalTrace?.channels).toEqual([
        { channel: "char", status: "used" },
        { channel: "word", status: "omitted", reason: "word-capability-unavailable" },
        { channel: "bigram", status: "omitted", reason: "word-capability-unavailable" },
      ]);
      expect(results[0]?.lexicalTrace?.contributions.map((entry) => entry.channel)).toEqual(["char"]);
    } finally {
      db.close();
    }
  });
});
