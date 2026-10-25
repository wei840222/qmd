import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllEmbeddings,
  createStore,
  getEmbeddingFingerprint,
  hybridQuery,
  insertContent,
  insertDocument,
  insertEmbedding,
  searchVec,
  vectorSearchQuery,
} from "../src/store.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import { remoteEmbeddingIdentity } from "../src/embedding/remote-embedding.js";
import { VEC_TABLE, activeCollectionsOfHash, allocateCollectionId, upsertPartitionVector } from "../src/vec-layout.js";
import {
  OpenAIEmbeddingProvider,
  canonicalOpenAIEmbeddingIdentityMaterial,
  canonicalOpenAIQueryIdentityMaterial,
} from "../src/embedding/openai.js";
import {
  VoyageEmbeddingProvider,
  canonicalVoyageEmbeddingIdentityMaterial,
  canonicalVoyageQueryIdentityMaterial,
} from "../src/embedding/voyage.js";
import { canonicalEmbeddingBuildMaterial } from "../src/store.js";
import {
  EmbeddingIdentityStateError,
  abandonEmbeddingBuild,
  beginEmbeddingBuild,
  completeEmbeddingBuild,
  createEmbeddingIdentity,
  ensureEmbeddingIdentitySchema,
  inspectEmbeddingIndexState,
  renewEmbeddingBuildLease,
} from "../src/embedding/identity.js";

const tempDirs: string[] = [];

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "qmd-embedding-identity-"));
  tempDirs.push(dir);
  return createStore(join(dir, "index.sqlite"));
}

function localIdentity(model = "local-model", dimension = 3) {
  return createEmbeddingIdentity({
    providerId: "local-llama-cpp",
    model,
    dimension,
    remote: false,
    canonicalMaterial: JSON.stringify({ provider: "local", model, dimension }),
  });
}

function insertCorruptEmbedding(
  store: ReturnType<typeof createStore>,
  hash: string,
  vector: Float32Array,
  model: string,
  fingerprint: string,
  embeddedAt: string,
): void {
  store.db.prepare(`
    INSERT INTO content_vectors(hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
    VALUES (?, 0, 0, ?, ?, 1, ?)
  `).run(hash, model, fingerprint, embeddedAt);
  for (const collection of activeCollectionsOfHash(store.db, hash)) {
    upsertPartitionVector(store.db, hash, 0, allocateCollectionId(store.db, collection), vector);
  }
}

function remoteIdentity(
  model = "text-embedding-3-small",
  dimension = 1_536,
  endpointFingerprint?: string,
) {
  return createEmbeddingIdentity({
    providerId: "openai",
    model,
    dimension,
    remote: true,
    canonicalMaterial: JSON.stringify({
      provider: "openai",
      model,
      dimension,
      format: "qmd-openai-embedding-v1",
      ...(endpointFingerprint ? { endpointFingerprint } : {}),
    }),
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("embedding identity state machine", () => {
  test("ready remote identity fails closed before provider calls when authorization is missing", async () => {
    const embed = vi.fn(async () => ({
      vector: [1, 0, 0],
      model: "remote-model",
      dimension: 3,
    }));
    const embedBatch = vi.fn(async () => [{
      vector: [1, 0, 0],
      model: "remote-model",
      dimension: 3,
    }]);
    const provider: EmbeddingProvider = {
      providerId: "remote-test",
      model: "remote-model",
      dimension: 3,
      remote: true,
      canonicalIdentityMaterial: () => JSON.stringify({ provider: "remote-test", model: "remote-model", dimension: 3 }),
      formatQuery: query => query,
      formatDocument: text => text,
      estimateTokens: text => text.length,
      embed,
      embedBatch,
      close: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), "qmd-embedding-identity-"));
    tempDirs.push(dir);
    const store = createStore(join(dir, "index.sqlite"), { embeddingProvider: provider });
    const identity = remoteEmbeddingIdentity(provider);
    try {
      const lease = beginEmbeddingBuild(store.db, identity, {
        ownerId: "remote-query-test",
        now: 1_000,
        leaseMs: 1_000,
        allowDestructiveRebuild: true,
      });
      store.ensureVecTable(3);
      completeEmbeddingBuild(store.db, lease, 1_100);

      await expect(store.searchVec("private query", provider.model)).rejects.toMatchObject({
        name: "RemoteEmbeddingAuthorizationError",
        code: "PURPOSE_NOT_ALLOWED",
      });
      await expect(hybridQuery(store, "private query", {
        expansion: "skip",
        skipRerank: true,
      })).rejects.toMatchObject({
        name: "RemoteEmbeddingAuthorizationError",
        code: "PURPOSE_NOT_ALLOWED",
      });
      expect(embed).not.toHaveBeenCalled();
      expect(embedBatch).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  test("ready remote identity authorizes immediately before provider calls", async () => {
    const events: string[] = [];
    const embed = vi.fn(async () => {
      events.push("embed");
      return { vector: [1, 0, 0], model: "remote-model", dimension: 3 };
    });
    const provider: EmbeddingProvider = {
      providerId: "remote-test",
      model: "remote-model",
      dimension: 3,
      remote: true,
      canonicalIdentityMaterial: () => JSON.stringify({ provider: "remote-test", model: "remote-model", dimension: 3 }),
      formatQuery: query => query,
      formatDocument: text => text,
      estimateTokens: text => text.length,
      embed,
      embedBatch: async texts => Promise.all(texts.map(() => embed())),
      close: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), "qmd-embedding-identity-"));
    tempDirs.push(dir);
    const store = createStore(join(dir, "index.sqlite"), { embeddingProvider: provider });
    const identity = remoteEmbeddingIdentity(provider);
    try {
      const lease = beginEmbeddingBuild(store.db, identity, {
        ownerId: "remote-query-test",
        now: 1_000,
        leaseMs: 1_000,
        allowDestructiveRebuild: true,
      });
      store.ensureVecTable(3);
      completeEmbeddingBuild(store.db, lease, 1_100);
      store.authorizeRemoteRequest = (purpose, context) => {
        events.push("authorize");
        expect(purpose).toBe("query-embedding");
        expect(context.identity).toEqual(identity);
      };
      store.expandQuery = async () => [];

      await expect(vectorSearchQuery(store, "private query", {
        collection: ["alpha", "beta"],
      })).resolves.toEqual([]);
      expect(events).toEqual(["authorize", "embed"]);
    } finally {
      store.close();
    }
  });

  test("query does not call a remote provider before a matching identity is ready", async () => {
    const embedBatch = vi.fn(async () => {
      throw new Error("remote provider must not be called");
    });
    const provider: EmbeddingProvider = {
      providerId: "openai-test",
      model: "text-embedding-3-small",
      dimension: 3,
      remote: true,
      canonicalIdentityMaterial: () => JSON.stringify({
        provider: "openai-test",
        model: "text-embedding-3-small",
        dimension: 3,
      }),
      formatQuery: query => query,
      formatDocument: (text, title) => title ? `${title}\n${text}` : text,
      estimateTokens: text => new TextEncoder().encode(text).byteLength,
      embed: async () => ({
        vector: [0.1, 0.2, 0.3],
        model: "text-embedding-3-small",
        dimension: 3,
      }),
      embedBatch,
      close: async () => {},
    };
    const dir = await mkdtemp(join(tmpdir(), "qmd-embedding-identity-"));
    tempDirs.push(dir);
    const store = createStore(join(dir, "index.sqlite"), { embeddingProvider: provider });
    const timestamp = "2026-07-24T00:00:00.000Z";
    try {
      store.db.exec(`CREATE TABLE ${VEC_TABLE} (collection_id INTEGER, embedding BLOB)`);
      insertContent(store.db, "lexical-only", "REMOTE_GUARD_MARKER", timestamp);
      insertDocument(store.db, "docs", "guard.md", "Guard", "lexical-only", timestamp, timestamp);

      const results = await hybridQuery(store, "REMOTE_GUARD_MARKER", {
        expansion: "skip",
        skipRerank: true,
      });

      expect(results.map(result => result.file)).toContain("qmd://docs/guard.md");
      expect(embedBatch).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  test("persists a completed identity across store restarts", async () => {
    const store = await createTempStore();
    const dbPath = store.dbPath;
    const identity = localIdentity();
    ensureEmbeddingIdentitySchema(store.db);

    const lease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 500,
      allowDestructiveRebuild: true,
    });
    expect(lease.mode).toBe("rebuild");
    completeEmbeddingBuild(store.db, lease, 1_100);
    store.close();

    const reopened = createStore(dbPath);
    try {
      ensureEmbeddingIdentitySchema(reopened.db);
      expect(inspectEmbeddingIndexState(reopened.db, identity, 1_200)).toMatchObject({
        status: "ready",
        identity,
      });
    } finally {
      reopened.close();
    }
  });

  test("resumes an incomplete build with the same identity without clearing vectors", async () => {
    const store = await createTempStore();
    const identity = localIdentity();
    ensureEmbeddingIdentitySchema(store.db);

    const first = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-one", "body", new Date(0).toISOString());
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-one", identity.model, new Date(0).toISOString());
    abandonEmbeddingBuild(store.db, first, 1_050);
    const resumed = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });

    expect(resumed.mode).toBe("resume");
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 1 });
    store.close();
  });

  test("a local identity mismatch clears only embedding data before rebuilding", async () => {
    const store = await createTempStore();
    const oldIdentity = localIdentity("old-model");
    const nextIdentity = localIdentity("next-model");
    ensureEmbeddingIdentitySchema(store.db);
    const oldLease = beginEmbeddingBuild(store.db, oldIdentity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-one", "body", new Date(0).toISOString());
    store.insertDocument(
      "docs",
      "one.md",
      "One",
      "hash-one",
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    );
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-one", oldIdentity.model, new Date(0).toISOString());
    store.ensureVecTable(3);
    store.db.prepare(
      "INSERT INTO llm_cache(hash, result, created_at) VALUES ('keep', 'value', '1970-01-01')",
    ).run();

    completeEmbeddingBuild(store.db, oldLease, 1_010);
    const nextLease = beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });

    expect(nextLease.mode).toBe("rebuild");
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM llm_cache").get()).toEqual({ count: 1 });
    expect(store.db.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '${VEC_TABLE}'`,
    ).get()).toEqual({ count: 1 });
    store.close();
  });

  test("fails closed on a live foreign lease and allows expired takeover", async () => {
    const store = await createTempStore();
    const identity = localIdentity();
    ensureEmbeddingIdentitySchema(store.db);
    const lease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });

    expect(() => beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-b",
      now: 1_050,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    })).toThrowError(EmbeddingIdentityStateError);

    const takeover = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-b",
      now: 1_101,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    expect(takeover.generation).toBeGreaterThan(lease.generation);
    expect(takeover.ownerId).toBe("worker-b");
    store.close();
  });

  test("rolls back before an identity reset when the pre-mutation guard rejects", async () => {
    const store = await createTempStore();
    const oldIdentity = localIdentity("old-model");
    const nextIdentity = localIdentity("next-model");
    ensureEmbeddingIdentitySchema(store.db);
    const oldLease = beginEmbeddingBuild(store.db, oldIdentity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-guarded", "body", new Date(0).toISOString());
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-guarded", oldIdentity.model, new Date(0).toISOString());
    completeEmbeddingBuild(store.db, oldLease, 1_010);

    expect(() => beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: true,
      beforeMutation: () => {
        throw new Error("authorization expired");
      },
    })).toThrow("authorization expired");

    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 1 });
    expect(inspectEmbeddingIndexState(store.db, oldIdentity, 1_100)).toMatchObject({
      status: "ready",
      identity: oldIdentity,
    });
    store.close();
  });

  test("requires both remote force and destructive authorization inside the reset transaction", async () => {
    const store = await createTempStore();
    const identity = remoteIdentity();
    const initial = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-remote", "body", new Date(0).toISOString());
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-remote", identity.model, new Date(0).toISOString());
    completeEmbeddingBuild(store.db, initial, 1_010);

    expect(() => beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: false,
      forceRebuild: true,
      requireForceForIdentityChange: true,
    })).toThrowError(EmbeddingIdentityStateError);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 1 });
    expect(inspectEmbeddingIndexState(store.db, identity, 1_100).status).toBe("ready");

    const rebuilt = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-c",
      now: 1_101,
      leaseMs: 100,
      allowDestructiveRebuild: true,
      forceRebuild: true,
      requireForceForIdentityChange: true,
    });
    expect(rebuilt.mode).toBe("rebuild");
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 0 });
    store.close();
  });

  test("does not clear a remote identity mismatch when destructive authorization lacks force", async () => {
    const store = await createTempStore();
    const oldIdentity = remoteIdentity("text-embedding-3-small");
    const nextIdentity = remoteIdentity("text-embedding-3-small", 768);
    const initial = beginEmbeddingBuild(store.db, oldIdentity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-remote", "body", new Date(0).toISOString());
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-remote", oldIdentity.model, new Date(0).toISOString());
    completeEmbeddingBuild(store.db, initial, 1_010);

    expect(() => beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: true,
      forceRebuild: false,
      requireForceForIdentityChange: true,
    })).toThrowError(EmbeddingIdentityStateError);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 1 });
    expect(inspectEmbeddingIndexState(store.db, oldIdentity, 1_100).status).toBe("ready");
    store.close();
  });

  test("adopts a new remote endpoint without clearing stored vectors", async () => {
    const store = await createTempStore();
    const oldIdentity = remoteIdentity("text-embedding-3-small", 1_536, "old-endpoint");
    const nextIdentity = remoteIdentity("text-embedding-3-small", 1_536, "new-endpoint");
    const initial = beginEmbeddingBuild(store.db, oldIdentity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });
    store.insertContent("hash-remote", "body", new Date(0).toISOString());
    store.db.prepare(
      "INSERT INTO content_vectors(hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, ?, ?)",
    ).run("hash-remote", oldIdentity.model, new Date(0).toISOString());
    completeEmbeddingBuild(store.db, initial, 1_010);

    const adopted = beginEmbeddingBuild(store.db, nextIdentity, {
      ownerId: "worker-b",
      now: 1_100,
      leaseMs: 100,
      allowDestructiveRebuild: true,
      forceRebuild: false,
      requireForceForIdentityChange: true,
    });

    expect(adopted.mode).toBe("resume");
    expect(adopted.fingerprint).toBe(nextIdentity.fingerprint);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get()).toEqual({ count: 1 });
    expect(inspectEmbeddingIndexState(store.db, nextIdentity, 1_100)).toMatchObject({
      status: "building",
      identity: nextIdentity,
    });
    store.close();
  });

  test("renews and completes only with the current owner and generation", async () => {
    const store = await createTempStore();
    const identity = localIdentity();
    ensureEmbeddingIdentitySchema(store.db);
    const lease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "worker-a",
      now: 1_000,
      leaseMs: 100,
      allowDestructiveRebuild: true,
    });

    const renewed = renewEmbeddingBuildLease(store.db, lease, 1_050, 200);
    expect(renewed.leaseExpiresAt).toBe(1_250);
    expect(() => completeEmbeddingBuild(
      store.db,
      { ...renewed, ownerId: "worker-b" },
      1_100,
    )).toThrowError(EmbeddingIdentityStateError);
    completeEmbeddingBuild(store.db, renewed, 1_100);
    expect(inspectEmbeddingIndexState(store.db, identity, 1_101).status).toBe("ready");
    store.close();
  });

  test("rejects renewal and ready publication after the owned lease expires", async () => {
    const store = await createTempStore();
    const identity = localIdentity();
    const lease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "expired-worker",
      now: 1_000,
      leaseMs: 10,
      allowDestructiveRebuild: true,
    });

    expect(() => renewEmbeddingBuildLease(store.db, lease, 2_000, 100))
      .toThrowError(EmbeddingIdentityStateError);
    expect(() => completeEmbeddingBuild(store.db, lease, 2_000))
      .toThrowError(EmbeddingIdentityStateError);
    expect(store.db.prepare(`
      SELECT status FROM embedding_index_state WHERE singleton = 1
    `).get()).toEqual({ status: "building" });
    expect(inspectEmbeddingIndexState(store.db, identity, 2_000).status).toBe("partial");
    store.close();
  });

  test("vector search excludes metadata rows with a stale full fingerprint", async () => {
    const store = await createTempStore();
    const model = "remote-search-model";
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-only-key",
      model,
      dimension: 3,
      fetch: async () => { throw new Error("Precomputed searches must not call the provider"); },
    });
    const activeIdentity = remoteEmbeddingIdentity(provider);
    const activeFingerprint = activeIdentity.fingerprint;
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "search-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      store.insertContent("stale-hash", "stale body", now);
      store.insertDocument("docs", "stale.md", "Stale", "stale-hash", now, now);
      insertCorruptEmbedding(
        store,
        "stale-hash",
        new Float32Array([1, 0, 0]),
        model,
        "stale-full-fingerprint",
        now,
      );
      store.insertContent("live-hash", "live body", now);
      store.insertDocument("docs", "live.md", "Live", "live-hash", now, now);
      insertEmbedding(
        store.db,
        "live-hash",
        0,
        0,
        new Float32Array([0, 1, 0]),
        model,
        now,
        1,
        activeFingerprint,
        lease,
      );
      completeEmbeddingBuild(store.db, lease);

      const results = await searchVec(
        store.db,
        "query",
        model,
        10,
        undefined,
        undefined,
        [1, 0, 0],
        provider,
      );
      expect(results.map(result => result.displayPath)).toEqual(["docs/live.md"]);
    } finally {
      store.close();
    }
  });

  test("vector search applies the full fingerprint before global KNN truncation", async () => {
    const store = await createTempStore();
    const model = "remote-search-model";
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-only-key",
      model,
      dimension: 3,
      fetch: async () => { throw new Error("Precomputed searches must not call the provider"); },
    });
    const activeIdentity = remoteEmbeddingIdentity(provider);
    const activeFingerprint = activeIdentity.fingerprint;
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "search-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      store.db.transaction(() => {
        for (let index = 0; index < 31; index += 1) {
          const hash = `stale-${index}`;
          store.insertContent(hash, "stale body", now);
          store.insertDocument("docs", `stale-${index}.md`, `Stale ${index}`, hash, now, now);
          insertCorruptEmbedding(
            store,
            hash,
            new Float32Array([1, 0, 0]),
            model,
            "stale-full-fingerprint",
            now,
          );
        }
        store.insertContent("active-hash", "active body", now);
        store.insertDocument("docs", "active.md", "Active", "active-hash", now, now);
        insertEmbedding(
          store.db,
          "active-hash",
          0,
          0,
          new Float32Array([0.9, 0.1, 0]),
          model,
          now,
          1,
          activeFingerprint,
          lease,
        );
      })();
      completeEmbeddingBuild(store.db, lease);

      const results = await searchVec(
        store.db,
        "query",
        model,
        10,
        undefined,
        undefined,
        [1, 0, 0],
        provider,
      );

      expect(results.map(result => result.displayPath)).toEqual(["docs/active.md"]);
    } finally {
      store.close();
    }
  });

  test("vector search applies collection filters before truncating more than 4,096 KNN candidates", async () => {
    const store = await createTempStore();
    const model = "remote-search-model";
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-only-key",
      model,
      dimension: 3,
      fetch: async () => { throw new Error("Precomputed searches must not call the provider"); },
    });
    const activeIdentity = remoteEmbeddingIdentity(provider);
    const fingerprint = activeIdentity.fingerprint;
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, activeIdentity, {
        ownerId: "search-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      store.db.transaction(() => {
        for (let index = 0; index < 4_096; index += 1) {
          const hash = `noise-${index}`;
          store.insertContent(hash, "noise body", now);
          store.insertDocument("noise", `${index}.md`, `Noise ${index}`, hash, now, now);
          insertEmbedding(
            store.db,
            hash,
            0,
            0,
            new Float32Array([1, 0, 0]),
            model,
            now,
            1,
            fingerprint,
            lease,
          );
        }
        store.insertContent("target-hash", "target body", now);
        store.insertDocument("target", "only.md", "Target", "target-hash", now, now);
        insertEmbedding(
          store.db,
          "target-hash",
          0,
          0,
          new Float32Array([0.9, 0.1, 0]),
          model,
          now,
          1,
          fingerprint,
          lease,
        );
      })();
      completeEmbeddingBuild(store.db, lease);

      const results = await searchVec(
        store.db,
        "query",
        model,
        10,
        ["target"],
        undefined,
        [1, 0, 0],
        provider,
      );

      expect(results.map(result => result.displayPath)).toEqual(["target/only.md"]);
    } finally {
      store.close();
    }
  });

  test("query ignores endpoint changes and an unforced build keeps the published vectors", async () => {
    const cases = [
      {
        name: "openai",
        indexUrl: "https://first.invalid/openai/v1",
        queryUrl: "https://second.invalid/v1",
        rebuild: canonicalOpenAIEmbeddingIdentityMaterial,
        query: canonicalOpenAIQueryIdentityMaterial,
        create: (baseUrl: string, fetch: typeof globalThis.fetch) => new OpenAIEmbeddingProvider({
          apiKey: "test-key",
          model: "text-embedding-3-small",
          dimension: 3,
          baseUrl,
          maxAttempts: 1,
          fetch,
          authorizeRequest: async () => {},
        }),
      },
      {
        name: "voyage",
        indexUrl: "https://first.invalid/voyage/v1",
        queryUrl: "https://second.invalid/voyage/v1",
        rebuild: canonicalVoyageEmbeddingIdentityMaterial,
        query: canonicalVoyageQueryIdentityMaterial,
        create: (baseUrl: string, fetch: typeof globalThis.fetch) => new VoyageEmbeddingProvider({
          apiKey: "test-key",
          model: "voyage-4",
          dimension: 3,
          baseUrl,
          maxAttempts: 1,
          fetch,
          authorizeRequest: async () => {},
        }),
      },
    ] as const;

    for (const subject of cases) {
      const model = subject.name === "openai" ? "text-embedding-3-small" : "voyage-4";
      expect(subject.query(model as never, 3, subject.indexUrl)).toBe(subject.query(model as never, 3, subject.queryUrl));
      expect(subject.rebuild(model as never, 3, subject.indexUrl)).not.toBe(subject.rebuild(model as never, 3, subject.queryUrl));
      const published = createEmbeddingIdentity({
        providerId: subject.name === "openai" ? "openai" : "voyageai",
        model,
        dimension: 3,
        remote: true,
        canonicalMaterial: canonicalEmbeddingBuildMaterial(
          subject.rebuild(model as never, 3, subject.indexUrl),
          "regex",
        ),
      });
      const store = await createTempStore();
      const now = new Date(0).toISOString();
      const before = {
        material: "",
        fingerprint: "",
        generation: 0,
        vectors: 0,
      };
      try {
        const lease = beginEmbeddingBuild(store.db, published, {
          ownerId: "endpoint-writer",
          now: Date.now(),
          leaseMs: 60_000,
          allowDestructiveRebuild: true,
        });
        store.insertContent("kept-hash", "kept body", now);
        store.insertDocument("docs", "kept.md", "Kept", "kept-hash", now, now);
        insertEmbedding(
          store.db,
          "kept-hash",
          0,
          0,
          new Float32Array([1, 0, 0]),
          model,
          now,
          1,
          published.fingerprint,
          lease,
        );
        completeEmbeddingBuild(store.db, lease);
        const row = store.db.prepare(`
          SELECT canonical_material, fingerprint, generation FROM embedding_index_state WHERE singleton = 1
        `).get() as { canonical_material: string; fingerprint: string; generation: number };
        before.material = row.canonical_material;
        before.fingerprint = row.fingerprint;
        before.generation = row.generation;
        before.vectors = (store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get() as { n: number }).n;

        const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
          subject.name === "openai"
            ? {
              object: "list",
              model,
              data: [{ object: "embedding", embedding: [1, 0, 0], index: 0 }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }
            : {
              object: "list",
              model,
              data: [{ object: "embedding", embedding: [1, 0, 0], index: 0 }],
              usage: { total_tokens: 1 },
            },
        ), { status: 200, headers: { "content-type": "application/json" } }));
        const provider = subject.create(subject.queryUrl, fetch);
        const moved = createStore(store.dbPath, { embeddingProvider: provider });
        const results = await searchVec(
          moved.db,
          "kept",
          provider.model,
          10,
          undefined,
          undefined,
          undefined,
          provider,
          () => {},
        );
        expect(results.map(result => result.displayPath), subject.name).toEqual(["docs/kept.md"]);
        expect(fetch, subject.name).toHaveBeenCalled();
        const requestUrl = String(fetch.mock.calls[0]?.[0]);
        expect(requestUrl, subject.name).toContain("second.invalid");
        expect(requestUrl, subject.name).not.toContain("first.invalid");

        const after = moved.db.prepare(`
          SELECT canonical_material, fingerprint, generation FROM embedding_index_state WHERE singleton = 1
        `).get() as { canonical_material: string; fingerprint: string; generation: number };
        expect(after, subject.name).toEqual({
          canonical_material: before.material,
          fingerprint: before.fingerprint,
          generation: before.generation,
        });
        expect((moved.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get() as { n: number }).n).toBe(before.vectors);

        const adopted = beginEmbeddingBuild(moved.db, remoteEmbeddingIdentity(provider), {
          ownerId: "unforced",
          now: 2_000,
          leaseMs: 60_000,
          allowDestructiveRebuild: false,
          requireForceForIdentityChange: true,
        });
        expect(adopted.mode, subject.name).toBe("resume");
        const preserved = moved.db.prepare(`
          SELECT generation FROM embedding_index_state WHERE singleton = 1
        `).get() as { generation: number };
        expect(preserved.generation, subject.name).toBe(after.generation + 1);
        expect((moved.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get() as { n: number }).n, subject.name).toBe(before.vectors);
        abandonEmbeddingBuild(moved.db, adopted, 2_010);
        moved.close();
        await provider.close();
      } finally {
        store.close();
      }
    }
  });

  test("query refuses a changed provider dimension without embedding or rewriting the index", async () => {
    const publishedMaterial = canonicalOpenAIEmbeddingIdentityMaterial(
      "text-embedding-3-small",
      3,
      "https://first.invalid/v1",
    );
    const published = createEmbeddingIdentity({
      providerId: "openai",
      model: "text-embedding-3-small",
      dimension: 3,
      remote: true,
      canonicalMaterial: canonicalEmbeddingBuildMaterial(publishedMaterial, "regex"),
    });
    const store = await createTempStore();
    const now = new Date(0).toISOString();
    try {
      const lease = beginEmbeddingBuild(store.db, published, {
        ownerId: "dimension-writer",
        now: Date.now(),
        leaseMs: 60_000,
        allowDestructiveRebuild: true,
      });
      store.insertContent("kept-hash", "kept body", now);
      store.insertDocument("docs", "kept.md", "Kept", "kept-hash", now, now);
      insertEmbedding(store.db, "kept-hash", 0, 0, new Float32Array([1, 0, 0]), published.model, now, 1, published.fingerprint, lease);
      completeEmbeddingBuild(store.db, lease);
      const before = store.db.prepare(`SELECT canonical_material, fingerprint, generation FROM embedding_index_state`).get();

      const fetch = vi.fn();
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "test-key",
        model: "text-embedding-3-small",
        dimension: 4,
        baseUrl: "https://first.invalid/v1",
        maxAttempts: 1,
        fetch,
        authorizeRequest: async () => {},
      });
      const reopened = createStore(store.dbPath, { embeddingProvider: provider });
      await expect(reopened.searchVec("kept", provider.model)).resolves.toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(reopened.db.prepare(`SELECT canonical_material, fingerprint, generation FROM embedding_index_state`).get()).toEqual(before);
      reopened.close();
      await provider.close();
    } finally {
      store.close();
    }
  });

  test("global embedding clear removes metadata, payload table, and ready identity together", async () => {
    const store = await createTempStore();
    const identity = localIdentity();
    const now = Date.now();
    ensureEmbeddingIdentitySchema(store.db);
    const lease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "clear-test",
      now,
      leaseMs: 500,
      allowDestructiveRebuild: false,
    });
    insertEmbedding(
      store.db,
      "clear-hash",
      0,
      0,
      new Float32Array(identity.dimension),
      identity.model,
      new Date(0).toISOString(),
      1,
      identity.fingerprint,
      lease,
    );
    completeEmbeddingBuild(store.db, lease, now + 1);
    const clearLease = beginEmbeddingBuild(store.db, identity, {
      ownerId: "clear-owner",
      now: now + 2,
      leaseMs: 500,
      allowDestructiveRebuild: false,
    });

    clearAllEmbeddings(store.db, undefined, clearLease);

    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM content_vectors`).get()).toEqual({ n: 0 });
    expect(store.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${VEC_TABLE}'
    `).get()).toBeFalsy();
    expect(store.db.prepare(`SELECT 1 FROM embedding_index_state`).get()).toBeFalsy();
    store.close();
  });
});
