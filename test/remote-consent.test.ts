import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStore,
  preflightRemoteEmbedding,
  type QMDStore,
} from "../src/index.js";
import { insertEmbedding } from "../src/store.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import {
  beginEmbeddingBuild,
  completeEmbeddingBuild,
  createEmbeddingIdentity,
} from "../src/embedding/identity.js";
import { OpenAIEmbeddingProvider } from "../src/embedding/openai.js";
import {
  REMOTE_CAPABILITY_PROBE_SENTINEL,
  REMOTE_EMBEDDING_POLICY_VERSION,
  acceptRemoteEmbeddingPreflight,
  authorizeRemoteEmbeddingPurpose,
  createRemoteEmbeddingPreflight,
  hasRemoteEmbeddingConsent,
  probeRemoteEmbeddingDimension,
  remoteEmbeddingIdentity,
} from "../src/embedding/remote-consent.js";

function remoteProvider(): EmbeddingProvider {
  return {
    providerId: "openai-test",
    model: "text-embedding-3-small",
    dimension: 3,
    remote: true,
    canonicalIdentityMaterial: () => JSON.stringify({
      provider: "openai-test",
      model: "text-embedding-3-small",
      dimension: 3,
      chunking: "qmd-utf8-window-v1",
    }),
    formatQuery: query => query,
    formatDocument: (text, title) => title ? `${title}\n${text}` : text,
    estimateTokens: text => new TextEncoder().encode(text).byteLength,
    embed: vi.fn(async () => ({
      vector: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
      dimension: 3,
    })),
    async embedBatch() {
      throw new Error("preflight must not call the remote provider");
    },
    async close() {},
  };
}

describe("remote embedding preflight and consent", () => {
  let root: string;
  let documents: string;
  let store: QMDStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-remote-consent-"));
    documents = join(root, "documents");
    await import("node:fs/promises").then(fs => fs.mkdir(documents));
    await writeFile(join(documents, "guide.md"), "# 台灣部署指南\n\n這是一份遠端向量文件。".repeat(500));
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: { docs: { path: documents, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterEach(async () => {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  });

  test("top-level SDK preflight does not create the target index", async () => {
    const dbPath = join(root, "preflight-only.sqlite");
    expect(existsSync(dbPath)).toBe(false);

    const preflight = await preflightRemoteEmbedding({
      dbPath,
      config: { collections: {}, embedding: { provider: "openai" } },
    });

    expect(preflight).toMatchObject({ providerId: "openai", pendingDocuments: 0 });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("rejects a local identity before a remote provider fetch", async () => {
    const localIdentity = createEmbeddingIdentity({
      providerId: "node-llama-cpp",
      model: "local-model",
      dimension: 1536,
      remote: false,
      canonicalMaterial: JSON.stringify({ provider: "node-llama-cpp", model: "local-model" }),
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200 }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "[REDACTED]",
      fetch,
      authorizeRequest: request => authorizeRemoteEmbeddingPurpose(
        store.internal.db,
        localIdentity,
        request.purpose,
        { requestFingerprint: request.fingerprint },
      ),
    });

    await expect(provider.embed("private query", {
      purpose: "query-embedding",
      kind: "query",
      identityFingerprint: localIdentity.fingerprint,
    })).rejects.toMatchObject({ code: "PURPOSE_NOT_ALLOWED" });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("creates a conservative no-request side-effect-free preflight", () => {
    const preflight = createRemoteEmbeddingPreflight(store.internal.db, remoteProvider(), {
      now: 1_000,
    });

    expect(preflight).toMatchObject({
      policyVersion: REMOTE_EMBEDDING_POLICY_VERSION,
      providerId: "openai-test",
      model: "text-embedding-3-small",
      dimension: 3,
      scope: "all_collections",
      pendingDocuments: 1,
      estimateKind: "conservative_utf8_bytes",
      costScope: "pending_document_build_only",
      createdAt: 1_000,
    });
    expect(preflight.preflightId).toMatch(/^[0-9a-f]{64}$/);
    expect(preflight.documentGeneration).toBeGreaterThan(0);
    expect(preflight.inputTokenUpperBound).toBeGreaterThan(0);
    expect(preflight.costUpperBoundUsd).toBeGreaterThan(0);
    expect(preflight.dataDisclosure).toEqual([
      "capability_probe_sentinel_sent_to_remote_provider",
      "document_chunks_sent_to_remote_provider",
      "document_titles_sent_to_remote_provider",
      "search_queries_sent_to_remote_provider",
    ]);

    expect(store.internal.db.prepare(`
      SELECT name FROM sqlite_master WHERE name LIKE 'remote_embedding_%'
    `).all()).toEqual([]);
  });

  test("accepts only the exact live preflight and persists the minimal consent record", () => {
    const provider = remoteProvider();
    const preflight = createRemoteEmbeddingPreflight(store.internal.db, provider, {
      now: 2_000,
    });

    expect(() => acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: "wrong-fingerprint",
      policyVersion: preflight.policyVersion,
      surface: "sdk",
      now: 2_001,
    })).toThrow(expect.objectContaining({ code: "PREFLIGHT_MISMATCH" }));

    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: preflight.fingerprint,
      policyVersion: preflight.policyVersion,
      surface: "sdk",
      now: 2_002,
    });

    expect(hasRemoteEmbeddingConsent(store.internal.db, preflight.fingerprint)).toBe(true);
    expect(store.internal.db.prepare(`SELECT * FROM remote_embedding_consents`).get()).toEqual({
      fingerprint: `${preflight.fingerprint}:${preflight.documentGeneration}`,
      policy_version: preflight.policyVersion,
      accepted_at: 2_002,
      surface: "sdk",
    });
  });

  test("expires accepted consent when the document generation changes", async () => {
    const provider = remoteProvider();
    const preflight = createRemoteEmbeddingPreflight(store.internal.db, provider);
    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: preflight.fingerprint,
      policyVersion: preflight.policyVersion,
      surface: "sdk",
    });

    await writeFile(join(documents, "new.md"), "# 新文件\n\n需要重新確認遠端傳送。");
    await store.update();

    expect(hasRemoteEmbeddingConsent(store.internal.db, preflight.fingerprint)).toBe(false);
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      remoteEmbeddingIdentity(provider),
      "capability-probe",
    )).toThrow(expect.objectContaining({ code: "DOCUMENT_GENERATION_CHANGED" }));
  });

  test("invalidates acknowledgement when documents changed after preflight", async () => {
    const provider = remoteProvider();
    const preflight = createRemoteEmbeddingPreflight(store.internal.db, provider, {
      now: 3_000,
    });
    await writeFile(join(documents, "guide.md"), "# 已變更\n\n文件generation已更新。".repeat(500));
    await store.update();

    expect(() => acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: preflight.fingerprint,
      policyVersion: preflight.policyVersion,
      surface: "cli",
      now: 3_001,
    })).toThrow(expect.objectContaining({ code: "PREFLIGHT_MISMATCH" }));
  });

  test("requires consent for every remote purpose and ready vectors for query embedding", () => {
    const provider = remoteProvider();
    const identity = remoteEmbeddingIdentity(provider);

    for (const purpose of ["capability-probe", "index-build", "query-embedding"] as const) {
      expect(() => authorizeRemoteEmbeddingPurpose(
        store.internal.db,
        identity,
        purpose,
      )).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    }

    const preflight = createRemoteEmbeddingPreflight(store.internal.db, provider);
    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: preflight.fingerprint,
      policyVersion: preflight.policyVersion,
      surface: "sdk",
    });
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "bogus" as never,
    )).toThrow(expect.objectContaining({ code: "PURPOSE_NOT_ALLOWED" }));
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "capability-probe",
    )).not.toThrow();
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "index-build",
    )).toThrow(expect.objectContaining({ code: "PURPOSE_NOT_ALLOWED" }));
    const now = Date.now();
    const lease = beginEmbeddingBuild(store.internal.db, identity, {
      ownerId: "authorized-owner",
      now,
      leaseMs: 5_000,
      allowDestructiveRebuild: true,
    });
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "index-build",
      { lease, now: now + 1 },
    )).not.toThrow();
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "index-build",
      { lease: { ...lease, ownerId: "wrong-owner" }, now: now + 1 },
    )).toThrow(expect.objectContaining({ code: "PURPOSE_NOT_ALLOWED" }));
    store.internal.ensureVecTable(identity.dimension);
    insertEmbedding(
      store.internal.db,
      "query-ready-hash",
      0,
      0,
      new Float32Array([0.1, 0.2, 0.3]),
      identity.model,
      new Date(10_002).toISOString(),
      1,
      identity.fingerprint,
      lease,
    );
    completeEmbeddingBuild(store.internal.db, lease, now + 2);
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "query-embedding",
    )).not.toThrow();

    store.internal.db.prepare(`
      UPDATE content_vectors
      SET embed_fingerprint = 'stale-fingerprint'
    `).run();
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      identity,
      "query-embedding",
    )).toThrow(expect.objectContaining({ code: "INDEX_NOT_READY" }));
  });

  test("capability probe sends one versioned sentinel only after consent and persists no probe state", async () => {
    const provider = remoteProvider();
    await expect(probeRemoteEmbeddingDimension(store.internal.db, provider)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    expect(provider.embed).not.toHaveBeenCalled();

    const preflight = createRemoteEmbeddingPreflight(store.internal.db, provider);
    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: preflight.preflightId,
      fingerprint: preflight.fingerprint,
      policyVersion: preflight.policyVersion,
      surface: "sdk",
    });
    const before = store.internal.db.prepare(`
      SELECT name, type FROM sqlite_master ORDER BY type, name
    `).all();

    const result = await probeRemoteEmbeddingDimension(store.internal.db, provider);

    expect(result).toMatchObject({ dimension: 3, requested: true });
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith(REMOTE_CAPABILITY_PROBE_SENTINEL, {
      purpose: "capability-probe",
      kind: "document",
      identityFingerprint: remoteEmbeddingIdentity(provider).fingerprint,
    });
    expect(store.internal.db.prepare(`
      SELECT name, type FROM sqlite_master ORDER BY type, name
    `).all()).toEqual(before);
  });

  test("binds remote preflight consent to the exact chunking strategy", () => {
    const provider = remoteProvider();
    const regexPreflight = createRemoteEmbeddingPreflight(store.internal.db, provider, {
      chunkStrategy: "regex",
    });
    const autoPreflight = createRemoteEmbeddingPreflight(store.internal.db, provider, {
      chunkStrategy: "auto",
    });

    expect(autoPreflight.fingerprint).not.toBe(regexPreflight.fingerprint);
    expect(autoPreflight.preflightId).not.toBe(regexPreflight.preflightId);
    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: regexPreflight.preflightId,
      fingerprint: regexPreflight.fingerprint,
      policyVersion: regexPreflight.policyVersion,
      surface: "sdk",
    });
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      remoteEmbeddingIdentity(provider, "auto"),
      "capability-probe",
    )).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    acceptRemoteEmbeddingPreflight(store.internal.db, provider, {
      preflightId: autoPreflight.preflightId,
      fingerprint: autoPreflight.fingerprint,
      policyVersion: autoPreflight.policyVersion,
      surface: "sdk",
    });
    expect(() => authorizeRemoteEmbeddingPurpose(
      store.internal.db,
      remoteEmbeddingIdentity(provider, "auto"),
      "capability-probe",
    )).not.toThrow();
  });

  test("SDK opens remote config without a key and gates every remote operation", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const remote = await createStore({
      dbPath: join(root, "remote-index.sqlite"),
      config: {
        collections: { docs: { path: documents, pattern: "**/*.md" } },
        embedding: { provider: "openai" },
      },
    });

    try {
      await remote.update();
      await expect(remote.searchLex("台灣")).resolves.not.toHaveLength(0);
      await expect(remote.search({
        query: "台灣",
        expansion: "skip",
        rerank: false,
      })).resolves.not.toHaveLength(0);
      await expect(remote.search({
        queries: [{ type: "lex", query: "台灣" }],
        rerank: false,
      })).resolves.not.toHaveLength(0);
      await expect(remote.searchVector("台灣")).resolves.toEqual([]);
      await expect(remote.embed()).rejects.toThrow("OPENAI_API_KEY is not configured");

      const preflight = await remote.preflightRemoteEmbedding();
      await remote.acceptRemoteEmbeddingPreflight({
        preflightId: preflight.preflightId,
        fingerprint: preflight.fingerprint,
        policyVersion: preflight.policyVersion,
      });
      const stateBefore = remote.internal.db.prepare(`
        SELECT * FROM embedding_index_state WHERE singleton = 1
      `).get();
      await expect(remote.embed()).rejects.toThrow("OPENAI_API_KEY is not configured");
      expect(remote.internal.db.prepare(`
        SELECT * FROM embedding_index_state WHERE singleton = 1
      `).get()).toEqual(stateBefore);
    } finally {
      await remote.close();
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test("SDK sends documents without an unnecessary probe and queries only when ready", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
      return new Response(JSON.stringify({
        object: "list",
        model: body.model,
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 1_536 }, () => 0.125),
        })),
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const remote = await createStore({
      dbPath: join(root, "authorized-remote-index.sqlite"),
      config: {
        collections: { docs: { path: documents, pattern: "**/*.md" } },
        embedding: { provider: "openai" },
      },
    });

    try {
      await remote.update();
      const preflight = await remote.preflightRemoteEmbedding();
      expect(fetch).not.toHaveBeenCalled();
      await expect(remote.embed()).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
      expect(fetch).not.toHaveBeenCalled();

      await remote.acceptRemoteEmbeddingPreflight({
        preflightId: preflight.preflightId,
        fingerprint: preflight.fingerprint,
        policyVersion: preflight.policyVersion,
      });
      const result = await remote.embed();

      expect(result.docsProcessed).toBe(1);
      expect(result.chunksEmbedded).toBeGreaterThan(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as {
        input: string[];
        model: string;
        dimensions: number;
      };
      expect(request.model).toBe("text-embedding-3-small");
      expect(request.dimensions).toBe(1_536);
      expect(request.input.every(input => input.startsWith("台灣部署指南\n"))).toBe(true);
      expect(remote.internal.db.prepare(`
        SELECT status, fingerprint FROM embedding_index_state WHERE singleton = 1
      `).get()).toEqual({ status: "ready", fingerprint: preflight.fingerprint });

      await expect(remote.searchVector("已確認且ready的查詢")).resolves.not.toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      const queryRequest = JSON.parse(String(fetch.mock.calls[1]![1]?.body)) as { input: string[] };
      expect(queryRequest.input).toEqual(["已確認且ready的查詢"]);

      await expect(remote.search({
        queries: [{ type: "vec", query: "structured ready query" }],
        rerank: false,
      })).resolves.not.toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      const structuredQueryRequest = JSON.parse(String(fetch.mock.calls[2]![1]?.body)) as { input: string[] };
      expect(structuredQueryRequest.input).toEqual(["structured ready query"]);

      await expect(remote.embed({ chunkStrategy: "auto" })).rejects.toMatchObject({
        code: "CONSENT_REQUIRED",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await remote.close();
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test("destructive remote rebuild probes before preserving old ready vectors on failure", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    let rejectRequests = false;
    let mutateDocumentsDuringProbe = false;
    let mutateIdentityDuringProbe = false;
    const inputs: string[][] = [];
    let remote!: QMDStore;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
      inputs.push(body.input);
      if (rejectRequests) return new Response(null, { status: 401 });
      if (body.input[0] === REMOTE_CAPABILITY_PROBE_SENTINEL) {
        if (mutateDocumentsDuringProbe) {
          mutateDocumentsDuringProbe = false;
          await writeFile(join(documents, "guide.md"), "# 已變更\n\nprobe 後異動");
          await remote.update();
        }
        if (mutateIdentityDuringProbe) {
          mutateIdentityDuringProbe = false;
          remote.internal.db.prepare(`
            UPDATE embedding_index_state SET generation = generation + 1 WHERE singleton = 1
          `).run();
        }
      }
      return new Response(JSON.stringify({
        object: "list",
        model: body.model,
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 1_536 }, () => 0.125),
        })),
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    remote = await createStore({
      dbPath: join(root, "destructive-probe-index.sqlite"),
      config: {
        collections: { docs: { path: documents, pattern: "**/*.md" } },
        embedding: { provider: "openai" },
      },
    });

    try {
      await remote.update();
      const preflight = await remote.preflightRemoteEmbedding();
      await remote.acceptRemoteEmbeddingPreflight({
        preflightId: preflight.preflightId,
        fingerprint: preflight.fingerprint,
        policyVersion: preflight.policyVersion,
      });
      await remote.embed();
      const stateBefore = remote.internal.db.prepare(`
        SELECT * FROM embedding_index_state WHERE singleton = 1
      `).get();
      const metadataBefore = remote.internal.db.prepare(`
        SELECT hash, seq, embed_fingerprint FROM content_vectors ORDER BY hash, seq
      `).all();
      const vectorsBefore = remote.internal.db.prepare(`
        SELECT hash_seq FROM vectors_vec ORDER BY hash_seq
      `).all();
      rejectRequests = true;

      await expect(remote.embed({
        force: true,
        allowDestructiveRebuild: true,
      })).rejects.toMatchObject({ code: "HTTP_TERMINAL" });
      expect(inputs.at(-1)).toEqual([REMOTE_CAPABILITY_PROBE_SENTINEL]);
      expect(remote.internal.db.prepare(`
        SELECT * FROM embedding_index_state WHERE singleton = 1
      `).get()).toEqual(stateBefore);
      expect(remote.internal.db.prepare(`
        SELECT hash, seq, embed_fingerprint FROM content_vectors ORDER BY hash, seq
      `).all()).toEqual(metadataBefore);
      expect(remote.internal.db.prepare(`
        SELECT hash_seq FROM vectors_vec ORDER BY hash_seq
      `).all()).toEqual(vectorsBefore);
      rejectRequests = false;
      mutateDocumentsDuringProbe = true;
      await expect(remote.embed({
        force: true,
        allowDestructiveRebuild: true,
      })).rejects.toMatchObject({ code: "DOCUMENT_GENERATION_CHANGED" });
      expect(inputs.at(-1)).toEqual([REMOTE_CAPABILITY_PROBE_SENTINEL]);
      expect(remote.internal.db.prepare(`
        SELECT hash, seq, embed_fingerprint FROM content_vectors ORDER BY hash, seq
      `).all()).toEqual(metadataBefore);
      expect(remote.internal.db.prepare(`
        SELECT hash_seq FROM vectors_vec ORDER BY hash_seq
      `).all()).toEqual(vectorsBefore);

      const changedPreflight = await remote.preflightRemoteEmbedding();
      await remote.acceptRemoteEmbeddingPreflight({
        preflightId: changedPreflight.preflightId,
        fingerprint: changedPreflight.fingerprint,
        policyVersion: changedPreflight.policyVersion,
      });
      mutateIdentityDuringProbe = true;
      await expect(remote.embed({
        force: true,
        allowDestructiveRebuild: true,
      })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
      expect(inputs.at(-1)).toEqual([REMOTE_CAPABILITY_PROBE_SENTINEL]);
      expect(remote.internal.db.prepare(`
        SELECT hash, seq, embed_fingerprint FROM content_vectors ORDER BY hash, seq
      `).all()).toEqual(metadataBefore);
      expect(remote.internal.db.prepare(`
        SELECT hash_seq FROM vectors_vec ORDER BY hash_seq
      `).all()).toEqual(vectorsBefore);

      const successfulRequestStart = inputs.length;
      const rebuilt = await remote.embed({
        force: true,
        allowDestructiveRebuild: true,
      });
      expect(rebuilt.docsProcessed).toBe(1);
      expect(inputs[successfulRequestStart]).toEqual([REMOTE_CAPABILITY_PROBE_SENTINEL]);
      expect(inputs[successfulRequestStart + 1]?.every(
        input => input.startsWith("已變更\n"),
      )).toBe(true);
      expect(remote.internal.db.prepare(`
        SELECT status, fingerprint FROM embedding_index_state WHERE singleton = 1
      `).get()).toEqual({ status: "ready", fingerprint: changedPreflight.fingerprint });
    } finally {
      await remote.close();
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });
});
