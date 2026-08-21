import { describe, expect, test, vi } from "vitest";
import { withLLMSessionForLlm, type EmbeddingResult, type ILLMSession, type LlamaCpp } from "../src/llm.js";
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingVector,
} from "../src/embedding/provider.js";
import {
  LocalEmbeddingProvider,
  LocalEmbeddingProviderOwner,
} from "../src/embedding/local.js";
import { CompositeEmbeddingProviderOwner } from "../src/embedding/owner.js";
import { createCliEmbeddingProviderOwner } from "../src/cli/embedding-owner.js";
import {
  EmbeddingConfigError,
  OPENAI_EMBEDDING_DIMENSION,
  OPENAI_EMBEDDING_MODEL,
  readCanonicalEmbeddingConfig,
  resolveEmbeddingConfig,
  resolveEmbeddingModelOverride,
  writeCanonicalEmbeddingConfig,
} from "../src/embedding/config.js";

const DOCUMENT_OPTIONS = { purpose: "index-build", kind: "document", identityFingerprint: "test-fingerprint" } as const;
const QUERY_OPTIONS = { purpose: "query-embedding", kind: "query", identityFingerprint: "test-fingerprint" } as const;
import {
  createStore,
  generateEmbeddings,
  hybridQuery,
  structuredSearch,
} from "../src/store.js";

function createSession(overrides: Partial<ILLMSession> = {}): ILLMSession {
  const controller = new AbortController();
  const embeddingModel = overrides.embeddingModel ?? "local-model";
  return {
    embeddingModel,
    embed: vi.fn(async (_text: string, options?: { model?: string }) => ({
      embedding: [0.1, 0.2, 0.3],
      model: embeddingModel,
    })),
    embedBatch: vi.fn(async (texts: string[], options?: { model?: string }) => texts.map((_, index) => ({
      embedding: [index, index + 0.5, index + 1],
      model: embeddingModel,
    }))),
    expandQuery: vi.fn(async () => []),
    rerank: vi.fn(async () => ({ results: [], model: "unused" })),
    isValid: true,
    signal: controller.signal,
    ...overrides,
  };
}

function expectProviderError(error: unknown, code: EmbeddingProviderError["code"]): void {
  expect(error).toBeInstanceOf(EmbeddingProviderError);
  expect(error).toMatchObject({ code });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("LocalEmbeddingProvider", () => {
  test("preserves query/document formatting and canonical identity material", () => {
    const model = "hf:org/Qwen3-Embedding-model.gguf";
    const provider = new LocalEmbeddingProvider(createSession({ embeddingModel: model }), {
      model,
      dimension: 3,
    });

    expect(provider.providerId).toBe("local-llama-cpp");
    expect(provider.model).toBe("hf:org/Qwen3-Embedding-model.gguf");
    expect(provider.dimension).toBe(3);
    expect(provider.remote).toBe(false);
    expect(provider.formatQuery("快取失效")).toBe(
      "Instruct: Retrieve relevant documents for the given query\nQuery: 快取失效",
    );
    expect(provider.formatDocument("本文", "標題")).toBe("標題\n本文");

    expect(JSON.parse(provider.canonicalIdentityMaterial())).toEqual({
      provider: "local-llama-cpp",
      model: "hf:org/Qwen3-Embedding-model.gguf",
      dimension: 3,
      remote: false,
      query_format: "Instruct: Retrieve relevant documents for the given query\nQuery: __qmd_query_identity__",
      document_format: "__qmd_document_identity_title__\n__qmd_document_identity__",
    });
  });

  test("binds identity to the model actually loaded by the borrowed session", () => {
    const actualModel = "hf:org/actual-model.gguf";
    const session = createSession({ embeddingModel: actualModel });
    const provider = new LocalEmbeddingProvider(session);
    expect(provider.model).toBe(actualModel);

    let mismatch: unknown;
    try {
      new LocalEmbeddingProvider(session, { model: "hf:org/claimed-model.gguf" });
    } catch (error) {
      mismatch = error;
    }
    expectProviderError(mismatch, "MODEL_MISMATCH");
  });

  test("forwards a single embedding operation and learns its dimension", async () => {
    const session = createSession();
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });

    let identityError: unknown;
    try {
      provider.canonicalIdentityMaterial();
    } catch (error) {
      identityError = error;
    }
    expectProviderError(identityError, "DIMENSION_UNKNOWN");

    const result = await provider.embed("formatted query", QUERY_OPTIONS);

    expect(result).toEqual<EmbeddingVector>({
      vector: [0.1, 0.2, 0.3],
      model: "local-model",
      dimension: 3,
    });
    expect(provider.dimension).toBe(3);
    expect(JSON.parse(provider.canonicalIdentityMaterial())).toMatchObject({ dimension: 3 });
    expect(session.embed).toHaveBeenCalledWith("formatted query", {
      model: "local-model",
      isQuery: true,
    });
  });

  test("keeps batch cardinality and order", async () => {
    const session = createSession();
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });

    const results = await provider.embedBatch(["first", "second"], DOCUMENT_OPTIONS);

    expect(results.map(result => result.vector)).toEqual([
      [0, 0.5, 1],
      [1, 1.5, 2],
    ]);
    expect(session.embedBatch).toHaveBeenCalledWith(["first", "second"], {
      model: "local-model",
      isQuery: false,
    });
  });

  test("rejects null, empty, non-finite, and dimension-changing vectors with typed errors", async () => {
    const cases: Array<{
      result: EmbeddingResult | null;
      code: EmbeddingProviderError["code"];
    }> = [
      { result: null, code: "MISSING_EMBEDDING" },
      { result: { embedding: [], model: "local-model" }, code: "EMPTY_VECTOR" },
      { result: { embedding: [1, Number.NaN], model: "local-model" }, code: "NON_FINITE_VECTOR" },
      { result: { embedding: [1, 2], model: "local-model" }, code: "DIMENSION_MISMATCH" },
    ];

    for (const testCase of cases) {
      const session = createSession({ embed: vi.fn(async () => testCase.result) });
      const provider = new LocalEmbeddingProvider(session, {
        model: "local-model",
        dimension: testCase.code === "DIMENSION_MISMATCH" ? 3 : undefined,
      });
      await provider.embed("input", DOCUMENT_OPTIONS).then(
        () => { throw new Error("Expected embedding to fail"); },
        error => expectProviderError(error, testCase.code),
      );
    }
  });

  test("rejects vectors produced by a different model identity", async () => {
    const session = createSession({
      embed: vi.fn(async () => ({ embedding: [1, 2, 3], model: "unexpected-model" })),
    });
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });

    await provider.embed("input", DOCUMENT_OPTIONS).then(
      () => { throw new Error("Expected model identity validation to fail"); },
      error => expectProviderError(error, "MODEL_MISMATCH"),
    );
  });

  test("wraps borrowed session failures in a typed provider error", async () => {
    const secret = "private-native-error-sentinel";
    const nativeError = new Error(`native failure: ${secret}`);
    Object.assign(nativeError, {
      input: secret,
      headers: { authorization: secret },
      cause: nativeError,
    });
    const session = createSession({
      embed: vi.fn(async () => { throw nativeError; }),
    });
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });

    await provider.embed("input", DOCUMENT_OPTIONS).then(
      () => { throw new Error("Expected session failure to be wrapped"); },
      error => {
        expectProviderError(error, "PROVIDER_FAILURE");
        expect(error.cause).toBeUndefined();
        const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
        expect(serialized).not.toContain(secret);
      },
    );
  });

  test("rejects batch cardinality changes and null batch items", async () => {
    const tooShort = new LocalEmbeddingProvider(createSession({
      embedBatch: vi.fn(async () => [{ embedding: [1, 2], model: "local-model" }]),
    }), { model: "local-model" });
    await tooShort.embedBatch(["first", "second"], DOCUMENT_OPTIONS).then(
      () => { throw new Error("Expected batch cardinality validation to fail"); },
      error => expectProviderError(error, "BATCH_CARDINALITY_MISMATCH"),
    );

    const missingItem = new LocalEmbeddingProvider(createSession({
      embedBatch: vi.fn(async () => [
        { embedding: [1, 2], model: "local-model" },
        null,
      ]),
    }), { model: "local-model" });
    await missingItem.embedBatch(["first", "second"], DOCUMENT_OPTIONS).then(
      () => { throw new Error("Expected missing item validation to fail"); },
      error => expectProviderError(error, "MISSING_EMBEDDING"),
    );
    expect(missingItem.dimension).toBeNull();
  });

  test("honors pre-aborted and in-flight abort signals", async () => {
    const session = createSession();
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });
    const preAborted = new AbortController();
    preAborted.abort();

    await provider.embed("input", { ...DOCUMENT_OPTIONS, signal: preAborted.signal }).then(
      () => { throw new Error("Expected pre-aborted operation to fail"); },
      error => expectProviderError(error, "OPERATION_ABORTED"),
    );
    expect(session.embed).not.toHaveBeenCalled();

    const pending = deferred<EmbeddingResult | null>();
    const inFlightSession = createSession({ embed: vi.fn(() => pending.promise) });
    const inFlightProvider = new LocalEmbeddingProvider(inFlightSession, { model: "local-model" });
    const controller = new AbortController();
    const operation = inFlightProvider.embed("input", { ...DOCUMENT_OPTIONS, signal: controller.signal });
    controller.abort();

    await operation.then(
      () => { throw new Error("Expected in-flight operation to abort"); },
      error => expectProviderError(error, "OPERATION_ABORTED"),
    );
    expect(inFlightSession.embed).not.toHaveBeenCalled();
    pending.resolve({ embedding: [1, 2, 3], model: "local-model" });
  });

  test("honors absolute deadlines before and during operations", async () => {
    const session = createSession();
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });

    await provider.embed("input", { ...DOCUMENT_OPTIONS, deadline: Date.now() - 1 }).then(
      () => { throw new Error("Expected expired deadline to fail"); },
      error => expectProviderError(error, "DEADLINE_EXCEEDED"),
    );
    expect(session.embed).not.toHaveBeenCalled();

    const pending = deferred<EmbeddingResult | null>();
    const timedSession = createSession({ embed: vi.fn(() => pending.promise) });
    const timedProvider = new LocalEmbeddingProvider(timedSession, { model: "local-model" });
    await timedProvider.embed("input", { ...DOCUMENT_OPTIONS, deadline: Date.now() + 5 }).then(
      () => { throw new Error("Expected in-flight deadline to fail"); },
      error => expectProviderError(error, "DEADLINE_EXCEEDED"),
    );
    pending.resolve({ embedding: [1, 2, 3], model: "local-model" });
  });

  test("does not start queued work after an immediate close or setup-boundary deadline", async () => {
    const closePending = deferred<EmbeddingResult | null>();
    const closeSession = createSession({ embed: vi.fn(() => closePending.promise) });
    const closeProvider = new LocalEmbeddingProvider(closeSession, { model: "local-model" });
    const closeOperation = closeProvider.embed("input", DOCUMENT_OPTIONS);

    await closeProvider.close();
    await closeOperation.then(
      () => { throw new Error("Expected immediate close to abort queued work"); },
      error => expectProviderError(error, "OPERATION_ABORTED"),
    );
    expect(closeSession.embed).not.toHaveBeenCalled();
    closePending.resolve({ embedding: [1, 2, 3], model: "local-model" });

    const deadlinePending = deferred<EmbeddingResult | null>();
    const deadlineSession = createSession({ embed: vi.fn(() => deadlinePending.promise) });
    const deadlineProvider = new LocalEmbeddingProvider(deadlineSession, { model: "local-model" });
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_001);

    try {
      await deadlineProvider.embed("input", { ...DOCUMENT_OPTIONS, deadline: 1_001 }).then(
        () => { throw new Error("Expected setup-boundary deadline to fail"); },
        error => expectProviderError(error, "DEADLINE_EXCEEDED"),
      );
      expect(deadlineSession.embed).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      deadlinePending.resolve({ embedding: [1, 2, 3], model: "local-model" });
      await deadlineProvider.close();
    }
  });

  test("close is idempotent, rejects new work, and does not dispose its borrowed owner", async () => {
    const dispose = vi.fn();
    const pending = deferred<EmbeddingResult | null>();
    const session = Object.assign(createSession({ embed: vi.fn(() => pending.promise) }), { dispose });
    const provider = new LocalEmbeddingProvider(session, { model: "local-model" });
    const activeOperation = provider.embed("active", {
      ...DOCUMENT_OPTIONS,
      deadline: Date.now() + 50,
    });
    await Promise.resolve();
    expect(session.embed).toHaveBeenCalledOnce();

    await provider.close();
    await provider.close();

    await activeOperation.then(
      () => { throw new Error("Expected close to abort the active caller wait"); },
      error => expectProviderError(error, "OPERATION_ABORTED"),
    );
    pending.resolve({ embedding: [1, 2, 3], model: "local-model" });
    expect(dispose).not.toHaveBeenCalled();
    await provider.embed("input", DOCUMENT_OPTIONS).then(
      () => { throw new Error("Expected closed provider to reject work"); },
      error => expectProviderError(error, "PROVIDER_CLOSED"),
    );
  });
});

describe("embedding config resolver", () => {
  const defaultLocalModel = "hf:default/embed.gguf";

  test("uses new embedding config before legacy, DB, and defaults", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        collections: {},
        embedding: { provider: "local", model: "hf:explicit/embed.gguf", dimension: 768 },
        models: { embed: "hf:legacy/embed.gguf" },
      },
      dbConfig: { provider: "local", model: "hf:db/embed.gguf", dimension: 512 },
      defaultLocalModel,
      env: {},
    });

    expect(resolved).toEqual({
      canonical: { provider: "local", model: "hf:explicit/embed.gguf", dimension: 768 },
      source: "embedding-block",
      credentialAvailable: true,
      remoteRequestsEnabled: false,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.canonical)).toBe(true);
  });

  test("maps legacy models.embed to local, then falls back to DB and local defaults", () => {
    expect(resolveEmbeddingConfig({
      config: { collections: {}, models: { embed: "hf:legacy/embed.gguf" } },
      dbConfig: { provider: "openai", model: "text-embedding-3-small", dimension: 1536 },
      defaultLocalModel,
      env: {},
    })).toMatchObject({
      canonical: { provider: "local", model: "hf:legacy/embed.gguf", dimension: null },
      source: "legacy-models",
    });

    expect(resolveEmbeddingConfig({
      config: { collections: {} },
      dbConfig: { provider: "openai", model: "text-embedding-3-small", dimension: 1536 },
      defaultLocalModel,
      env: {},
    })).toMatchObject({
      canonical: { provider: "openai", model: "text-embedding-3-small", dimension: 1536 },
      source: "database",
      credentialAvailable: false,
      remoteRequestsEnabled: false,
    });

    expect(resolveEmbeddingConfig({
      config: { collections: {} },
      defaultLocalModel,
      env: {},
    })).toMatchObject({
      canonical: { provider: "local", model: defaultLocalModel, dimension: null },
      source: "local-default",
    });
  });

  test("fails closed on an invalid higher-precedence source instead of falling back", () => {
    expect(() => resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed: "hf:legacy/embed.gguf",
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-ada-002",
          embed_dimension: 1536,
        },
      },
      dbConfig: { provider: "local", model: "hf:db/embed.gguf", dimension: 768 },
      defaultLocalModel,
      env: {},
    })).toThrowError(EmbeddingConfigError);

    expect(() => resolveEmbeddingConfig({
      config: { collections: {}, models: { embed: "" } },
      dbConfig: { provider: "local", model: "hf:db/embed.gguf", dimension: 768 },
      defaultLocalModel,
      env: {},
    })).toThrowError(/models\.embed/);
  });

  test("accepts supported OpenAI models with their native dimensions without requiring the key at resolve time", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
      defaultLocalModel,
      env: {},
    });
    expect(resolved).toMatchObject({
      canonical: { provider: "openai", model: "text-embedding-3-small", dimension: 1536 },
      credentialAvailable: false,
      remoteRequestsEnabled: false,
    });
    expect(resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
      defaultLocalModel,
      env: { OPENAI_API_KEY: "[REDACTED]" },
    }).remoteRequestsEnabled).toBe(true);

    expect(resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-large",
        },
      },
      defaultLocalModel,
      env: { OPENAI_API_KEY: "[REDACTED]" },
    }).canonical).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      dimension: 3072,
      baseUrl: "https://api.openai.com/v1",
    });

    for (const config of [
      { collections: {}, models: { embed_api_url: "https://api.openai.com/v1", embed_api_model: "unknown-model" } },
      { collections: {}, models: { embed_api_url: "https://api.openai.com/v1", embed_api_model: "text-embedding-3-small", embed_dimension: 768 } },
      { collections: {}, embedding: { provider: "remote" } },
    ]) {
      expect(() => resolveEmbeddingConfig({
        config,
        defaultLocalModel,
        env: { OPENAI_API_KEY: "[REDACTED]" },
      })).toThrowError(EmbeddingConfigError);
    }
  });

  test("creates isolated immutable results for concurrent SDK configs", () => {
    const first = resolveEmbeddingConfig({
      config: { collections: {}, embedding: { provider: "local", model: "hf:first/embed.gguf" } },
      defaultLocalModel,
    });
    const second = resolveEmbeddingConfig({
      config: { collections: {}, embedding: { provider: "local", model: "hf:second/embed.gguf" } },
      defaultLocalModel,
    });

    expect(first.canonical.model).toBe("hf:first/embed.gguf");
    expect(second.canonical.model).toBe("hf:second/embed.gguf");
    expect(first.canonical).not.toBe(second.canonical);
  });

  test("preserves local model overrides and requires the configured OpenAI model", () => {
    const local = resolveEmbeddingConfig({
      config: { collections: {}, embedding: { provider: "local", model: "hf:configured/embed.gguf" } },
      defaultLocalModel,
    });
    const openai = resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
      defaultLocalModel,
    });

    expect(resolveEmbeddingModelOverride(local, "hf:override/embed.gguf")).toBe("hf:override/embed.gguf");
    expect(resolveEmbeddingModelOverride(openai, "text-embedding-3-small")).toBe("text-embedding-3-small");
    expect(() => resolveEmbeddingModelOverride(openai, "text-embedding-3-large")).toThrowError(EmbeddingConfigError);

    const largeOpenAI = resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-large",
        },
      },
      defaultLocalModel,
    });
    expect(resolveEmbeddingModelOverride(largeOpenAI, "text-embedding-3-large"))
      .toBe("text-embedding-3-large");
    expect(() => resolveEmbeddingModelOverride(largeOpenAI, "text-embedding-3-small"))
      .toThrowError(EmbeddingConfigError);
  });

  test("persists only canonical non-secret configuration in SQLite", () => {
    const store = createStore(":memory:");
    const resolved = resolveEmbeddingConfig({
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
      defaultLocalModel,
      env: { OPENAI_API_KEY: "[REDACTED]" },
    });

    try {
      writeCanonicalEmbeddingConfig(store.db, resolved.canonical);
      expect(readCanonicalEmbeddingConfig(store.db)).toEqual(resolved.canonical);
      const row = store.db.prepare(
        "SELECT value FROM store_config WHERE key = 'embedding_config'",
      ).get() as { value: string };
      expect(row.value).toBe(JSON.stringify(resolved.canonical));
      expect(row.value).not.toContain("OPENAI_API_KEY");
      expect(row.value).not.toContain("credentialAvailable");
      expect(row.value).not.toContain("source");
    } finally {
      store.close();
    }
  });
});

describe.skipIf(!!process.env.CI)("Store embedding provider seam", () => {
  test("borrows an injected provider for vector search without disposing it", async () => {
    const close = vi.fn(async () => {});
    const embed = vi.fn(async (): Promise<EmbeddingVector> => ({
      vector: [0.1, 0.2, 0.3],
      model: "borrowed-model",
      dimension: 3,
    }));
    const embedBatch = vi.fn(async (texts: string[]): Promise<EmbeddingVector[]> => texts.map(() => ({
      vector: [0.1, 0.2, 0.3],
      model: "borrowed-model",
      dimension: 3,
    })));
    const provider: EmbeddingProvider = {
      providerId: "test-provider",
      model: "borrowed-model",
      dimension: 3,
      remote: false,
      canonicalIdentityMaterial: () => "test-identity",
      formatQuery: query => `query:${query}`,
      formatDocument: text => `document:${text}`,
      embed,
      embedBatch,
      close,
    };
    const store = createStore(":memory:", { embeddingProvider: provider });

    try {
      expect(store.embeddingProvider).toBe(provider);
      store.ensureVecTable(3);
      await expect(store.searchVec("cache invalidation", provider.model)).resolves.toEqual([]);
      expect(embed).not.toHaveBeenCalled();

      const now = new Date().toISOString();
      store.insertContent("hash-one", "# Cache\nInvalidate stale entries.", now);
      store.insertDocument("notes", "cache.md", "Cache", "hash-one", now, now);
      await expect(generateEmbeddings(store)).resolves.toMatchObject({
        docsProcessed: 1,
        errors: 0,
      });
      expect(embedBatch).toHaveBeenCalled();
      expect(embedBatch.mock.calls[0]?.[0]?.[0]).toContain("document:");

      store.insertContent("hash-stale", "# Stale\nOld incompatible vector.", now);
      store.insertDocument("notes", "stale.md", "Stale", "hash-stale", now, now);
      // Simulate an incompatible leftover row. The production writer requires
      // the active build lease and intentionally cannot create this state.
      store.db.prepare(`
        INSERT INTO content_vectors(
          hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at
        ) VALUES (?, 0, 0, ?, 'stale-fingerprint', 1, ?)
      `).run("hash-stale", provider.model, now);
      store.db.prepare(`
        INSERT INTO vectors_vec(hash_seq, embedding) VALUES (?, ?)
      `).run("hash-stale_0", new Float32Array([0.1, 0.2, 0.3]));
      embed.mockClear();
      const vectorResults = await store.searchVec("cache invalidation", provider.model);
      const activeIdentity = store.db.prepare(`
        SELECT fingerprint FROM embedding_index_state WHERE singleton = 1
      `).get() as { fingerprint: string };
      expect(embed).toHaveBeenCalledWith("query:cache invalidation", {
        purpose: "query-embedding",
        kind: "query",
        identityFingerprint: activeIdentity.fingerprint,
      });
      expect(vectorResults.map(result => result.filepath)).toContain("qmd://notes/cache.md");
      expect(vectorResults.map(result => result.filepath)).not.toContain("qmd://notes/stale.md");

      embedBatch.mockClear();
      await structuredSearch(store, [{ type: "vec", query: "cache invalidation" }], {
        skipRerank: true,
      });
      expect(embedBatch.mock.calls[0]?.[0]).toEqual(["query:cache invalidation"]);

      embedBatch.mockClear();
      await hybridQuery(store, "cache invalidation", {
        expansion: "skip",
        skipRerank: true,
      });
      expect(embedBatch.mock.calls[0]?.[0]).toEqual(["query:cache invalidation"]);
    } finally {
      store.close();
    }

    expect(close).not.toHaveBeenCalled();
  }, 30_000);
});

describe("EmbeddingProviderOwner lifecycle", () => {
  test("drains active Llama sessions before disposing the OpenAI CLI runtime", async () => {
    const sessionStarted = deferred<void>();
    const sessionSettled = deferred<void>();
    const events: string[] = [];
    const runtime = {
      dispose: vi.fn(async () => { events.push("runtime:dispose"); }),
    } as any;
    const remoteProvider: EmbeddingProvider = {
      providerId: "openai",
      model: OPENAI_EMBEDDING_MODEL,
      dimension: OPENAI_EMBEDDING_DIMENSION,
      remote: true,
      canonicalIdentityMaterial: () => "openai-test",
      formatQuery: text => text,
      formatDocument: text => text,
      embed: vi.fn(async (): Promise<EmbeddingVector> => ({
        vector: [1],
        model: OPENAI_EMBEDDING_MODEL,
        dimension: 1,
      })),
      embedBatch: vi.fn(async (): Promise<EmbeddingVector[]> => []),
      close: vi.fn(async () => { events.push("provider:close"); }),
    };
    const owner = createCliEmbeddingProviderOwner({
      provider: "openai",
      model: OPENAI_EMBEDDING_MODEL,
      dimension: OPENAI_EMBEDDING_DIMENSION,
    }, runtime, remoteProvider);
    const activeSession = withLLMSessionForLlm(runtime, async () => {
      sessionStarted.resolve();
      await sessionSettled.promise;
    });
    await sessionStarted.promise;

    const close = owner.close();
    expect(remoteProvider.close).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();

    sessionSettled.resolve();
    await activeSession;
    await close;
    expect(events).toEqual(["provider:close", "runtime:dispose"]);
  });

  test("uses the same local embedding identity for CLI and SDK composition roots", async () => {
    const cliDispose = vi.fn(async () => undefined);
    const sdkDispose = vi.fn(async () => undefined);
    const config = {
      provider: "local" as const,
      model: "local-model",
      dimension: 3,
    };
    const cliOwner = createCliEmbeddingProviderOwner(
      config,
      { dispose: cliDispose } as any,
    );
    const sdkOwner = new LocalEmbeddingProviderOwner(
      { dispose: sdkDispose } as any,
      config,
    );

    expect(cliOwner.provider.providerId).toBe(sdkOwner.provider.providerId);
    expect(cliOwner.provider.canonicalIdentityMaterial()).toBe(
      sdkOwner.provider.canonicalIdentityMaterial(),
    );

    await Promise.all([cliOwner.close(), sdkOwner.close()]);
    expect(cliDispose).toHaveBeenCalledTimes(1);
    expect(sdkDispose).toHaveBeenCalledTimes(1);
  });

  test("owns and disposes the high-level store Llama instance exactly once", async () => {
    const dispose = vi.fn(async () => undefined);
    const owner = new LocalEmbeddingProviderOwner(
      { dispose } as any,
      { model: "local-model" },
    );
    const providerClose = vi.spyOn(owner.provider, "close");

    await Promise.all([owner.close(), owner.close()]);
    await owner.close();

    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("waits for an active local embedding operation before disposing its runtime", async () => {
    const started = deferred<void>();
    const pending = deferred<EmbeddingResult | null>();
    const dispose = vi.fn(async () => undefined);
    const llm = {
      embedModelName: "local-model",
      embed: vi.fn(async () => {
        started.resolve();
        return pending.promise;
      }),
      dispose,
    } as any;
    const owner = new LocalEmbeddingProviderOwner(llm, { model: "local-model" });
    const operation = owner.provider.embed("input", {
      ...DOCUMENT_OPTIONS,
      identityFingerprint: "test-fingerprint",
    }).then(
      () => "resolved" as const,
      error => {
        expectProviderError(error, "OPERATION_ABORTED");
        return "aborted" as const;
      },
    );

    await started.promise;
    const close = owner.close();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();

    pending.resolve({ embedding: [1, 2, 3], model: "local-model" });
    await expect(operation).resolves.toBe("aborted");
    await close;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("closes provider before runtime exactly once across concurrent callers", async () => {
    const events: string[] = [];
    const provider = {
      close: vi.fn(async () => { events.push("provider"); }),
    } as any;
    const runtime = {
      dispose: vi.fn(async () => { events.push("runtime"); }),
    };
    const owner = new CompositeEmbeddingProviderOwner(provider, runtime);

    await Promise.all([owner.close(), owner.close()]);

    expect(events).toEqual(["provider", "runtime"]);
    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  test("still disposes the runtime when provider close fails", async () => {
    const runtime = { dispose: vi.fn(async () => undefined) };
    const owner = new CompositeEmbeddingProviderOwner({
      close: vi.fn(async () => { throw new Error("provider close failed"); }),
    } as any, runtime);

    await expect(owner.close()).rejects.toThrow("provider close failed");
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
