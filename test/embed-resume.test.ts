import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllEmbeddings,
  cleanupOrphanedVectors,
  createStore,
  finalizeEmbeddingBuild,
  generateEmbeddings,
  insertContent,
  insertDocument,
  insertEmbedding,
  searchVec,
} from "../src/store.js";
import { openDatabase } from "../src/db.js";
import {
  EmbeddingIdentityStateError,
  beginEmbeddingBuild,
  completeEmbeddingBuild,
  createEmbeddingIdentity,
  ensureEmbeddingIdentitySchema,
  inspectEmbeddingIndexState,
} from "../src/embedding/identity.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";

const tempDirs: string[] = [];

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "qmd-embed-resume-"));
  tempDirs.push(dir);
  return createStore(join(dir, "index.sqlite"));
}

function identity(model: string, dimension: number) {
  return createEmbeddingIdentity({
    providerId: "local-test",
    model,
    dimension,
    remote: false,
    canonicalMaterial: JSON.stringify({
      provider: "local-test",
      model,
      dimension,
      formatter: "test-v1",
      chunking: "test-v1",
    }),
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("embedding partial resume persistence", () => {
  test("rebuilds the new vector dimension inside the reset and lease transaction", async () => {
    const store = await createTempStore();
    const now = Date.now();
    const oldIdentity = identity("old-model", 3);
    const oldLease = beginEmbeddingBuild(store.db, oldIdentity, {
      ownerId: "old-owner",
      now,
      leaseMs: 10_000,
      allowDestructiveRebuild: true,

    });
    expect(store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
    `).get()).toMatchObject({ sql: expect.stringContaining("float[3]") });
    insertEmbedding(
      store.db,
      "old-hash",
      0,
      0,
      new Float32Array([1, 0, 0]),
      oldIdentity.model,
      new Date(0).toISOString(),
      1,
      oldIdentity.fingerprint,
      oldLease,
    );
    completeEmbeddingBuild(store.db, oldLease, now + 1);

    const nextIdentity = identity("new-model", 4);
    expect(() => beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "new-owner",
      now: now + 2,
      leaseMs: 10_000,
      allowDestructiveRebuild: true,
      afterVectorTablePrepared: () => {
        throw new Error("fault after vector table rebuild");
      },
    })).toThrow("fault after vector table rebuild");

    expect(inspectEmbeddingIndexState(store.db, oldIdentity, now + 3).status).toBe("ready");
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get()).toEqual({ n: 1 });
    expect(store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
    `).get()).toMatchObject({ sql: expect.stringContaining("float[3]") });

    const nextLease = beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "new-owner",
      now: now + 4,
      leaseMs: 10_000,
      allowDestructiveRebuild: true,

    });
    expect(nextLease.fingerprint).toBe(nextIdentity.fingerprint);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get()).toEqual({ n: 0 });
    expect(store.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
    `).get()).toMatchObject({ sql: expect.stringContaining("float[4]") });
    store.close();
  });

  test("requires the active lease and matching identity for every chunk write", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("active-model", 3);
    const lease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "active-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,

    });
    const vector = new Float32Array([1, 0, 0]);
    const embeddedAt = new Date(0).toISOString();

    expect(() => insertEmbedding(
      store.db,
      "missing-lease",
      0,
      0,
      vector,
      activeIdentity.model,
      embeddedAt,
      1,
      activeIdentity.fingerprint,
    )).toThrow(/lease/i);

    expect(() => insertEmbedding(
      store.db,
      "wrong-identity",
      0,
      0,
      vector,
      "other-model",
      embeddedAt,
      1,
      "other-fingerprint",
      lease,
    )).toThrow(/lease|identity/i);

    insertEmbedding(
      store.db,
      "valid",
      0,
      0,
      vector,
      activeIdentity.model,
      embeddedAt,
      1,
      activeIdentity.fingerprint,
      lease,
    );
    expect(store.db.prepare(`SELECT model, embed_fingerprint FROM content_vectors`).get()).toEqual({
      model: activeIdentity.model,
      embed_fingerprint: activeIdentity.fingerprint,
    });
    store.close();
  });

  test("holds the writer lock from final health scan through ready publication", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("active-model", 3);
    const lease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "active-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,
    });
    const competingWriter = openDatabase(store.dbPath);
    competingWriter.exec("PRAGMA busy_timeout = 0");
    let writerWasBlocked = false;

    const published = finalizeEmbeddingBuild(
      store.db,
      lease,
      activeIdentity.model,
      activeIdentity.fingerprint,
      {
        afterHealthScan: () => {
          try {
            competingWriter.prepare(`
              INSERT INTO content(hash, doc, created_at) VALUES ('racing-hash', 'racing body', 'now')
            `).run();
          } catch (error) {
            writerWasBlocked = /locked|busy/i.test(String(error));
          }
        },
      },
    );

    expect(writerWasBlocked).toBe(true);
    expect(published).toBe(true);
    expect(inspectEmbeddingIndexState(store.db, activeIdentity).status).toBe("ready");

    // A mutation committed after ready publication is allowed and becomes
    // pending without hiding the already-published identity.
    insertContent(competingWriter, "later-hash", "later body", new Date().toISOString());
    insertDocument(
      competingWriter,
      "docs",
      "later.md",
      "Later",
      "later-hash",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(inspectEmbeddingIndexState(store.db, activeIdentity).status).toBe("ready");
    competingWriter.close();
    store.close();
  });

  test("does not publish ready when the locked health scan finds pending documents", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("active-model", 3);
    const lease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "active-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,
    });
    const timestamp = new Date().toISOString();
    insertContent(store.db, "pending-hash", "pending body", timestamp);
    insertDocument(store.db, "docs", "pending.md", "Pending", "pending-hash", timestamp, timestamp);

    expect(finalizeEmbeddingBuild(
      store.db,
      lease,
      activeIdentity.model,
      activeIdentity.fingerprint,
    )).toBe(false);
    expect(store.db.prepare(`
      SELECT status, lease_owner, lease_expires_at
      FROM embedding_index_state WHERE singleton = 1
    `).get()).toEqual({
      status: "building",
      lease_owner: null,
      lease_expires_at: null,
    });
    store.close();
  });

  test("does not search building vectors through the low-level legacy path", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("active-model", 3);
    const lease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "active-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,
    });
    const timestamp = new Date().toISOString();
    insertContent(store.db, "search-hash", "search body", timestamp);
    insertDocument(store.db, "docs", "search.md", "Search", "search-hash", timestamp, timestamp);
    insertEmbedding(
      store.db,
      "search-hash",
      0,
      0,
      new Float32Array([1, 0, 0]),
      activeIdentity.model,
      timestamp,
      1,
      activeIdentity.fingerprint,
      lease,
    );

    expect(await searchVec(
      store.db,
      "query",
      activeIdentity.model,
      10,
      undefined,
      undefined,
      [1, 0, 0],
    )).toEqual([]);

    completeEmbeddingBuild(store.db, lease);
    expect(await searchVec(
      store.db,
      "query",
      activeIdentity.model,
      10,
      undefined,
      undefined,
      [1, 0, 0],
    )).toHaveLength(1);
    store.close();
  });

  test("keeps a published same-identity generation searchable during incremental work", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("incremental-model", 3);
    const initialLease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "initial-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,
    });
    const timestamp = new Date().toISOString();
    insertContent(store.db, "published-hash", "published body", timestamp);
    insertDocument(store.db, "docs", "published.md", "Published", "published-hash", timestamp, timestamp);
    insertEmbedding(
      store.db,
      "published-hash",
      0,
      0,
      new Float32Array([1, 0, 0]),
      activeIdentity.model,
      timestamp,
      1,
      activeIdentity.fingerprint,
      initialLease,
    );
    completeEmbeddingBuild(store.db, initialLease);

    const incrementalLease = beginEmbeddingBuild(store.db, activeIdentity, {
      ownerId: "incremental-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: false,
    });
    expect(inspectEmbeddingIndexState(store.db, activeIdentity).status).toBe("ready");
    expect(await searchVec(
      store.db,
      "query",
      activeIdentity.model,
      10,
      undefined,
      undefined,
      [1, 0, 0],
    )).toHaveLength(1);
    completeEmbeddingBuild(store.db, incrementalLease);
    store.close();
  });

  test("rejects an unfenced chunk write when authoritative identity state is missing", async () => {
    const store = await createTempStore();
    store.ensureVecTable(3);

    expect(() => insertEmbedding(
      store.db,
      "unfenced-hash",
      0,
      0,
      new Float32Array([1, 0, 0]),
      "unfenced-model",
      new Date().toISOString(),
    )).toThrow("identity is missing");
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get()).toEqual({ n: 0 });
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get()).toEqual({ n: 0 });
    store.close();
  });

  test("does not search vector rows when authoritative identity state is missing", async () => {
    const store = await createTempStore();
    store.ensureVecTable(3);
    const timestamp = new Date().toISOString();
    insertContent(store.db, "orphan-hash", "orphan body", timestamp);
    insertDocument(store.db, "docs", "orphan.md", "Orphan", "orphan-hash", timestamp, timestamp);
    store.db.transaction(() => {
      store.db.prepare(`
        INSERT INTO content_vectors(hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
        VALUES (?, 0, 0, ?, ?, 1, ?)
      `).run("orphan-hash", "orphan-model", "abcdef", timestamp);
      store.db.prepare(`INSERT INTO vectors_vec(hash_seq, collection, embedding) VALUES (?, ?, ?)`)
        .run("orphan-hash_0", "docs", new Float32Array([1, 0, 0]));
    })();

    expect(await searchVec(
      store.db,
      "query",
      "orphan-model",
      10,
      undefined,
      undefined,
      [1, 0, 0],
    )).toEqual([]);
    store.close();
  });

  test("rejects a collection-scoped identity change before clearing global vectors", async () => {
    const provider: EmbeddingProvider = {
      providerId: "replacement-provider",
      model: "replacement-model",
      dimension: 3,
      remote: false,
      canonicalIdentityMaterial: () => JSON.stringify({ provider: "replacement-provider", version: 1 }),
      formatQuery: query => query,
      formatDocument: text => text,
      embed: async () => ({ vector: [0, 1, 0], model: "replacement-model", dimension: 3 }),
      embedBatch: async texts => texts.map(() => ({
        vector: [0, 1, 0],
        model: "replacement-model",
        dimension: 3,
      })),
      close: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), "qmd-embed-resume-"));
    tempDirs.push(dir);
    const store = createStore(join(dir, "index.sqlite"), { embeddingProvider: provider });
    const originalIdentity = identity("original-model", 3);
    const originalLease = beginEmbeddingBuild(store.db, originalIdentity, {
      ownerId: "original-owner",
      now: Date.now(),
      leaseMs: 60_000,
      allowDestructiveRebuild: true,
    });
    const timestamp = new Date().toISOString();
    for (const collection of ["a", "b"]) {
      const hash = `${collection}-hash`;
      insertContent(store.db, hash, `${collection} body`, timestamp);
      insertDocument(store.db, collection, `${collection}.md`, collection, hash, timestamp, timestamp);
      insertEmbedding(
        store.db,
        hash,
        0,
        0,
        new Float32Array([1, 0, 0]),
        originalIdentity.model,
        timestamp,
        1,
        originalIdentity.fingerprint,
        originalLease,
      );
    }
    completeEmbeddingBuild(store.db, originalLease);

    await expect(generateEmbeddings(store, { collection: "a" })).rejects.toThrow(
      "cannot be collection-scoped",
    );
    expect(inspectEmbeddingIndexState(store.db, originalIdentity).status).toBe("ready");
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get()).toEqual({ n: 2 });
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM vectors_vec`).get()).toEqual({ n: 2 });
    store.close();
  });

  test("migrates authoritative identity state to persist incompatible status", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("legacy-model", 3);
    store.db.exec(`DROP TABLE embedding_index_state`);
    store.db.exec(`
      CREATE TABLE embedding_index_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        fingerprint TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK (dimension > 0),
        remote INTEGER NOT NULL CHECK (remote IN (0, 1)),
        canonical_material TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        lease_owner TEXT,
        lease_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);
    store.db.prepare(`
      INSERT INTO embedding_index_state(
        singleton, fingerprint, provider_id, model, dimension, remote,
        canonical_material, status, generation, lease_owner, lease_expires_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, 0, ?, 'ready', 7, NULL, NULL, ?)
    `).run(
      "abcdef",
      activeIdentity.providerId,
      activeIdentity.model,
      activeIdentity.dimension,
      "legacy-material",
      Date.now(),
    );

    ensureEmbeddingIdentitySchema(store.db);

    expect(inspectEmbeddingIndexState(store.db, activeIdentity)).toMatchObject({
      status: "incompatible",
      generation: 7,
      identity: {
        fingerprint: "abcdef",
        canonicalMaterial: "legacy-material",
      },
    });
    store.close();
  });

  test("rolls back orphan cleanup when either embedding table delete fails", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("atomic-cleanup", 3);
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "cleanup-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      insertEmbedding(
        store.db,
        "orphan-hash",
        0,
        0,
        new Float32Array([1, 0, 0]),
        activeIdentity.model,
        now,
        1,
        activeIdentity.fingerprint,
        lease,
      );
      completeEmbeddingBuild(store.db, lease);
      store.db.exec(`
        CREATE TRIGGER fail_orphan_metadata_delete
        BEFORE DELETE ON content_vectors
        BEGIN
          SELECT RAISE(ABORT, 'injected metadata delete failure');
        END
      `);

      expect(() => cleanupOrphanedVectors(store.db)).toThrow(/injected metadata delete failure/);
      expect((store.db.prepare(`SELECT COUNT(*) AS count FROM vectors_vec`).get() as { count: number }).count).toBe(1);
      expect((store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors`).get() as { count: number }).count).toBe(1);
    } finally {
      store.close();
    }
  });

  test("rolls back collection clear when either embedding table delete fails", async () => {
    const store = await createTempStore();
    const activeIdentity = identity("atomic-clear", 3);
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "clear-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      insertContent(store.db, "kept-hash", "kept body", now);
      insertDocument(store.db, "kept", "doc.md", "Kept", "kept-hash", now, now);
      insertEmbedding(
        store.db,
        "kept-hash",
        0,
        0,
        new Float32Array([1, 0, 0]),
        activeIdentity.model,
        now,
        1,
        activeIdentity.fingerprint,
        lease,
      );
      completeEmbeddingBuild(store.db, lease);
      const clearLease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "active-clear-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      store.db.exec(`
        CREATE TRIGGER fail_collection_metadata_delete
        BEFORE DELETE ON content_vectors
        BEGIN
          SELECT RAISE(ABORT, 'injected collection delete failure');
        END
      `);

      expect(() => clearAllEmbeddings(
        store.db,
        "kept",
        { ...clearLease, ownerId: "foreign-writer" },
      )).toThrowError(EmbeddingIdentityStateError);
      expect(() => clearAllEmbeddings(store.db, "kept", clearLease))
        .toThrow(/injected collection delete failure/);
      expect((store.db.prepare(`SELECT COUNT(*) AS count FROM vectors_vec`).get() as { count: number }).count).toBe(1);
      expect((store.db.prepare(`SELECT COUNT(*) AS count FROM content_vectors`).get() as { count: number }).count).toBe(1);
    } finally {
      store.close();
    }
  });
});
