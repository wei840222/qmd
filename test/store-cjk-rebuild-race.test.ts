import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { openDatabase, type Database } from "../src/db.js";
import {
  createStore,
  deactivateDocument,
  deleteInactiveDocuments,
  insertContent,
  insertDocument,
  removeCollection,
  renameCollection,
  updateDocument,
} from "../src/store.js";
import {
  cleanupRetiredCjkIndexTables,
  getCjkLexicalIndexState,
  rebuildCjkLexicalIndex,
  type CjkIndexBuildPhase,
} from "../src/search/cjk-index.js";
import type { JiebaCapabilityLoader } from "../src/search/cjk-analyzer.js";

const now = "2026-01-01T00:00:00.000Z";
const tempDirs: string[] = [];

const availableLoader: JiebaCapabilityLoader = async () => ({
  available: true,
  cut: (text: string) => Array.from(text.matchAll(/[\p{Script=Han}A-Za-z0-9]+/gu), (match) => match[0]),
});

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const crashWorker = join(thisDir, "_helpers", "cjk-rebuild-crash-worker.ts");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function spawnCrashWorker(dbPath: string): ChildProcessWithoutNullStreams {
  const args = isBunRuntime ? [crashWorker, dbPath] : [tsxCli, crashWorker, dbPath];
  return spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
}

function waitForSnapshot(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`crash worker timeout: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /SNAPSHOT_COMPLETE:([0-9a-f-]+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (stdout.includes("SNAPSHOT_COMPLETE:")) return;
      clearTimeout(timer);
      reject(new Error(`crash worker exited ${code}: ${stderr}`));
    });
  });
}

async function createFixture(): Promise<{ dbPath: string; db: Database }> {
  const dir = await mkdtemp(join(tmpdir(), "qmd-cjk-race-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "index.sqlite");
  const store = createStore(dbPath);
  return { dbPath, db: store.db };
}

function seed(
  db: Database,
  collection: string,
  path: string,
  title: string,
  hash: string,
  body: string,
): void {
  insertContent(db, hash, body, now);
  insertDocument(db, collection, path, title, hash, now, now);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CJK lexical rebuild races", () => {
  test("catch-up writes bounded journal pages before analyzing the full mutation interval", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "notes", "baseline.md", "基準", "hash-baseline", "基準內容");
    db.close();

    const completedPages: Extract<CjkIndexBuildPhase, { phase: "catchup-page-complete" }>[] = [];

    const result = await rebuildCjkLexicalIndex(dbPath, {
      loadCapability: availableLoader,
      onPhase: async (event) => {
        if (event.phase === "catchup-page-complete") {
          completedPages.push(event);
          return;
        }
        if (event.phase !== "snapshot-complete") return;
        const writer = openDatabase(dbPath);
        try {
          for (let index = 0; index < 205; index++) {
            seed(
              writer,
              "notes",
              `late-${index}.md`,
              `late-${index}`,
              `hash-late-${index}`,
              `late-${index}`,
            );
          }
        } finally {
          writer.close();
        }
      },
    });

    expect(result.status).toBe("ready");
    expect(completedPages.length).toBeGreaterThanOrEqual(2);
    expect(completedPages[0]!.appliedMutationSeq).toBeLessThan(completedPages[0]!.targetMutationSeq);
    expect(completedPages.every((page) => page.documentCount <= 200)).toBe(true);
  });

  test("snapshot analysis does not block a concurrent writer and catch-up publishes its row", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "中文筆記", "基準.md", "基準", "hash-snapshot-baseline", "玉山基準內容");
    db.close();

    let writerCommitted = false;
    const result = await rebuildCjkLexicalIndex(dbPath, {
      loadCapability: async () => ({
        available: true,
        cut: (text: string) => {
          if (!writerCommitted) {
            const writer = openDatabase(dbPath);
            try {
              seed(writer, "中文筆記", "並行.md", "並行寫入", "hash-snapshot-writer", "資料庫同步器");
              writerCommitted = true;
            } finally {
              writer.close();
            }
          }
          return [text];
        },
      }),
    });

    expect(writerCommitted).toBe(true);
    expect(result.status).toBe("ready");
    const verify = openDatabase(dbPath);
    try {
      const activeIds = verify.prepare(`SELECT id FROM documents WHERE active = 1 ORDER BY id`).all();
      expect(verify.prepare(`SELECT rowid AS id FROM documents_fts_words ORDER BY rowid`).all()).toEqual(activeIds);
      expect(verify.prepare(`SELECT rowid AS id FROM documents_fts_bigrams ORDER BY rowid`).all()).toEqual(activeIds);
      expect(verify.prepare(`
        SELECT rowid FROM documents_fts_words
        WHERE documents_fts_words MATCH '"資料庫同步器"'
      `).get()).toBeTruthy();
    } finally {
      verify.close();
    }
  });

  test("snapshot build replays insert, update, and deactivate mutations before atomic publish", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "notes", "existing.md", "舊標題", "hash-old", "舊內容");
    db.close();

    let mutated = false;
    let lateMutated = false;
    const result = await rebuildCjkLexicalIndex(dbPath, {
      loadCapability: availableLoader,
      onPhase: async (event: CjkIndexBuildPhase) => {
        if (event.phase === "snapshot-complete" && !mutated) {
          mutated = true;
          const writer = openDatabase(dbPath);
          try {
            insertContent(writer, "hash-new", "更新後玉山資料庫", now);
            const existing = writer.prepare(`
              SELECT id FROM documents WHERE collection = 'notes' AND path = 'existing.md'
            `).get() as { id: number };
            updateDocument(writer, existing.id, "更新後標題", "hash-new", now);

            seed(writer, "notes", "removed.md", "即將移除", "hash-removed", "不應發布");
            deactivateDocument(writer, "notes", "removed.md");
            seed(writer, "notes", "added.md", "新增玉山", "hash-added", "新增同步器");
          } finally {
            writer.close();
          }
        } else if (event.phase === "catchup-complete" && !lateMutated) {
          lateMutated = true;
          const writer = openDatabase(dbPath);
          try {
            seed(writer, "notes", "late.md", "延遲新增", "hash-late", "玉山晚到事件");
          } finally {
            writer.close();
          }
        }
      },
    });

    expect(mutated).toBe(true);
    expect(lateMutated).toBe(true);
    expect(result.status).toBe("ready");

    const verify = openDatabase(dbPath);
    try {
      const activeIds = verify.prepare(`SELECT id FROM documents WHERE active = 1 ORDER BY id`).all() as { id: number }[];
      const wordIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_words ORDER BY rowid`).all() as { id: number }[];
      const bigramIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_bigrams ORDER BY rowid`).all() as { id: number }[];
      expect(wordIds).toEqual(activeIds);
      expect(bigramIds).toEqual(activeIds);

      const removed = verify.prepare(`
        SELECT rowid FROM documents_fts_words
        WHERE documents_fts_words MATCH '"不應發布"'
      `).get();
      const updated = verify.prepare(`
        SELECT rowid FROM documents_fts_bigrams
        WHERE documents_fts_bigrams MATCH '"玉山"'
      `).get();
      expect(removed == null).toBe(true);
      expect(updated).toBeTruthy();

      const head = verify.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM cjk_index_mutations`).get() as { seq: number };
      expect(getCjkLexicalIndexState(verify)).toMatchObject({
        status: "ready",
        generation: head.seq,
        activeBuildId: null,
      });
    } finally {
      verify.close();
    }
  });

  test("a late publish failure rolls back table swaps and preserves the prior generation", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "notes", "prior.md", "既有標題", "hash-publish-prior", "玉山既有內容");
    db.close();
    const ready = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;

    const inject = openDatabase(dbPath);
    cleanupRetiredCjkIndexTables(inject, { limit: 10 });
    const priorState = getCjkLexicalIndexState(inject);
    const priorWords = inject.prepare(`
      SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid
    `).all();
    const priorBigrams = inject.prepare(`
      SELECT rowid, filepath, title, body FROM documents_fts_bigrams ORDER BY rowid
    `).all();
    inject.exec(`
      CREATE TRIGGER fail_cjk_publish_ready
      BEFORE UPDATE OF status ON cjk_index_state
      WHEN NEW.status = 'ready'
      BEGIN
        SELECT RAISE(ABORT, 'injected publish failure');
      END
    `);
    inject.close();

    await expect(rebuildCjkLexicalIndex(dbPath, {
      force: true,
      loadCapability: availableLoader,
    })).rejects.toThrow("injected publish failure");

    const verify = openDatabase(dbPath);
    try {
      expect(verify.prepare(`
        SELECT rowid, filepath, title, body FROM documents_fts_words ORDER BY rowid
      `).all()).toEqual(priorWords);
      expect(verify.prepare(`
        SELECT rowid, filepath, title, body FROM documents_fts_bigrams ORDER BY rowid
      `).all()).toEqual(priorBigrams);
      expect(getCjkLexicalIndexState(verify)).toMatchObject({
        status: "dirty",
        generation: priorState.generation,
        publishedBuildId: priorState.publishedBuildId,
        activeBuildId: null,
        diagnosticCode: "CJK_REBUILD_FAILED",
      });
      const leaked = verify.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table'
          AND (name GLOB 'documents_fts_words_build_*'
            OR name GLOB 'documents_fts_bigrams_build_*'
            OR name GLOB 'documents_fts_words_old_*'
            OR name GLOB 'documents_fts_bigrams_old_*')
      `).all();
      expect(leaked).toEqual([]);
      expect(verify.prepare(`
        SELECT COUNT(*) AS count FROM cjk_index_builds WHERE state = 'failed'
      `).get()).toEqual({ count: 1 });
    } finally {
      verify.close();
    }
  });

  test("snapshot build replays collection rename, collection removal, and hard delete before publish", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "old-name", "rename.md", "重新命名", "hash-rename", "玉山重新命名");
    seed(db, "removed", "remove.md", "移除集合", "hash-remove", "玉山移除集合");
    seed(db, "hard-delete", "delete.md", "永久刪除", "hash-delete", "玉山永久刪除");
    const hardDeleted = db.prepare(`
      SELECT id FROM documents WHERE collection = 'hard-delete' AND path = 'delete.md'
    `).get() as { id: number };
    db.close();

    let mutated = false;
    const result = await rebuildCjkLexicalIndex(dbPath, {
      loadCapability: availableLoader,
      onPhase: async (event: CjkIndexBuildPhase) => {
        if (event.phase !== "snapshot-complete" || mutated) return;
        mutated = true;
        const writer = openDatabase(dbPath);
        try {
          renameCollection(writer, "old-name", "new-name");
          removeCollection(writer, "removed");
          deactivateDocument(writer, "hard-delete", "delete.md");
          expect(deleteInactiveDocuments(writer)).toBe(1);
        } finally {
          writer.close();
        }
      },
    });

    expect(mutated).toBe(true);
    expect(result.status).toBe("ready");

    const verify = openDatabase(dbPath);
    try {
      expect(verify.prepare(`SELECT collection FROM documents WHERE path = 'rename.md'`).get()).toEqual({ collection: "new-name" });
      expect(verify.prepare(`SELECT 1 FROM documents WHERE collection IN ('old-name', 'removed')`).get() == null).toBe(true);
      expect(verify.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(hardDeleted.id) == null).toBe(true);

      const activeIds = verify.prepare(`SELECT id FROM documents WHERE active = 1 ORDER BY id`).all() as { id: number }[];
      const wordIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_words ORDER BY rowid`).all() as { id: number }[];
      const bigramIds = verify.prepare(`SELECT rowid AS id FROM documents_fts_bigrams ORDER BY rowid`).all() as { id: number }[];
      expect(wordIds).toEqual(activeIds);
      expect(bigramIds).toEqual(activeIds);

      const head = verify.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM cjk_index_mutations`).get() as { seq: number };
      expect(getCjkLexicalIndexState(verify)).toMatchObject({
        status: "ready",
        generation: head.seq,
        activeBuildId: null,
      });
    } finally {
      verify.close();
    }
  });

  test("a concurrent builder reports busy and cannot publish or delete the active build", async () => {
    const { dbPath, db } = await createFixture();
    seed(db, "notes", "one.md", "玉山", "hash-one", "同步器");
    db.close();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const snapshotReached = new Promise<void>((resolve) => { reached = resolve; });

    const first = rebuildCjkLexicalIndex(dbPath, {
      loadCapability: availableLoader,
      onPhase: async (event: CjkIndexBuildPhase) => {
        if (event.phase !== "snapshot-complete") return;
        reached();
        await gate;
      },
    });

    await snapshotReached;
    const during = openDatabase(dbPath);
    const activeBefore = getCjkLexicalIndexState(during).activeBuildId;
    during.close();
    expect(activeBefore).toBeTruthy();

    const second = await rebuildCjkLexicalIndex(dbPath, { loadCapability: availableLoader });
    expect(second).toMatchObject({ status: "busy", buildId: activeBefore });

    const stillBuilding = openDatabase(dbPath);
    expect(getCjkLexicalIndexState(stillBuilding).activeBuildId).toBe(activeBefore);
    stillBuilding.close();

    release();
    expect(await first).toMatchObject({ status: "ready", buildId: activeBefore });

    const complete = openDatabase(dbPath);
    try {
      expect(getCjkLexicalIndexState(complete)).toMatchObject({
        status: "ready",
        activeBuildId: null,
        publishedBuildId: activeBefore,
      });
      const published = complete.prepare(`
        SELECT COUNT(*) AS count FROM cjk_index_builds
        WHERE state = 'ready'
      `).get() as { count: number };
      expect(published.count).toBe(1);
    } finally {
      complete.close();
    }
  });

  test("a killed builder leaves the published generation intact and only dead-owner cleanup drops its shadow", async () => {
    const fixture = await createFixture();
    seed(fixture.db, "notes", "one.md", "玉山", "hash-one", "同步器");
    fixture.db.close();
    const seeded = await rebuildCjkLexicalIndex(fixture.dbPath, { loadCapability: availableLoader });
    expect(seeded.status).toBe("ready");
    if (seeded.status !== "ready") return;

    const child = spawnCrashWorker(fixture.dbPath);
    const crashedBuildId = await waitForSnapshot(child);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    let registry!: { words_table: string; bigrams_table: string };
    const db = openDatabase(fixture.dbPath);
    try {
      const building = getCjkLexicalIndexState(db);
      expect(building.status).toBe("building");
      expect(building.activeBuildId).toBe(crashedBuildId);
      expect(building.publishedBuildId).toBe(seeded.buildId);
      expect(db.prepare(`
        SELECT rowid FROM documents_fts_bigrams
        WHERE documents_fts_bigrams MATCH '"玉山"'
      `).get()).toBeTruthy();

      registry = db.prepare(`
        SELECT words_table, bigrams_table FROM cjk_index_builds WHERE build_id = ?
      `).get(crashedBuildId) as { words_table: string; bigrams_table: string };
      db.prepare(`UPDATE cjk_index_builds SET lease_expires_at = 0 WHERE build_id = ?`).run(crashedBuildId);
    } finally {
      db.close();
    }

    const reopened = createStore(fixture.dbPath);
    try {
      expect(getCjkLexicalIndexState(reopened.db)).toMatchObject({
        status: "ready",
        publishedBuildId: seeded.buildId,
        activeBuildId: null,
      });
      for (const tableName of [registry.words_table, registry.bigrams_table]) {
        const table = reopened.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName);
        expect(table == null).toBe(true);
      }
    } finally {
      reopened.close();
    }
  }, 20_000);

  test("dead-builder cleanup preserves a raw mutation dirty marker", async () => {
    const fixture = await createFixture();
    seed(fixture.db, "notes", "one.md", "玉山", "hash-one", "同步器");
    const document = fixture.db.prepare(`
      SELECT id FROM documents WHERE collection = 'notes' AND path = 'one.md'
    `).get() as { id: number };
    fixture.db.close();
    const seeded = await rebuildCjkLexicalIndex(fixture.dbPath, { loadCapability: availableLoader });
    expect(seeded.status).toBe("ready");
    if (seeded.status !== "ready") return;

    const child = spawnCrashWorker(fixture.dbPath);
    const crashedBuildId = await waitForSnapshot(child);
    const writer = openDatabase(fixture.dbPath);
    try {
      writer.prepare(`UPDATE documents SET title = ? WHERE id = ?`)
        .run("直接改寫標題", document.id);
      expect(getCjkLexicalIndexState(writer)).toMatchObject({
        status: "dirty",
        activeBuildId: crashedBuildId,
        publishedBuildId: seeded.buildId,
        diagnosticCode: "CJK_INDEX_RAW_WRITE",
      });
      expect(writer.prepare(`SELECT rowid FROM documents_fts_words WHERE rowid = ?`).get(document.id) == null).toBe(true);
    } finally {
      writer.close();
    }

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const expire = openDatabase(fixture.dbPath);
    expire.prepare(`UPDATE cjk_index_builds SET lease_expires_at = 0 WHERE build_id = ?`).run(crashedBuildId);
    expire.close();

    const reopened = createStore(fixture.dbPath);
    try {
      expect(getCjkLexicalIndexState(reopened.db)).toMatchObject({
        status: "dirty",
        activeBuildId: null,
        publishedBuildId: seeded.buildId,
        diagnosticCode: "CJK_INDEX_RAW_WRITE",
      });
      expect(reopened.db.prepare(`SELECT rowid FROM documents_fts_words WHERE rowid = ?`).get(document.id) == null).toBe(true);
    } finally {
      reopened.close();
    }
  }, 20_000);
});
