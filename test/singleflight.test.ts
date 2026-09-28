import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  createStore,
  expandQuery,
  embedQueriesForStore,
  resetInflightState,
  memoryLlmCache,
  memoryEmbeddingCache,
  LRUCache,
  DEFAULT_MEMORY_CACHE_TTL_MS,
  DEFAULT_MEMORY_LLM_CACHE_MAX_BYTES,
  DEFAULT_MEMORY_EMBED_CACHE_MAX_BYTES,
} from "../src/store.js";
import type { LLM, Queryable } from "../src/llm.js";
import type { EmbeddingProvider, EmbeddingVector } from "../src/embedding/provider.js";
import { remoteEmbeddingIdentity } from "../src/embedding/remote-embedding.js";
import { beginEmbeddingBuild, completeEmbeddingBuild } from "../src/embedding/identity.js";

function createMockLlm(overrides: Partial<LLM> = {}): LLM {
  return {
    embed: async () => null,
    generate: async () => null,
    modelExists: async (m: string) => ({ name: m, exists: true }),
    expandQuery: async (): Promise<Queryable[]> => [],
    rerank: async () => ({ results: [], model: "mock" }),
    dispose: async () => {},
    ...overrides,
  };
}

describe("In-flight Singleflight Deduplication & In-Memory LRU Cache", () => {
  beforeEach(() => {
    resetInflightState();
  });

  describe("LRUCache operations, TTL, and size limits", () => {
    test("evicts least recently used items when max is exceeded", () => {
      const lru = new LRUCache<string, number>({ max: 3 });
      lru.set("a", 1);
      lru.set("b", 2);
      lru.set("c", 3);
      expect(lru.size).toBe(3);

      // Access "a" to make it recently used
      expect(lru.get("a")).toBe(1);

      // Add "d", which should evict "b" (least recently used)
      lru.set("d", 4);
      expect(lru.size).toBe(3);
      expect(lru.has("b")).toBe(false);
      expect(lru.has("a")).toBe(true);
      expect(lru.has("c")).toBe(true);
      expect(lru.has("d")).toBe(true);
    });

    test("evicts entries exceeding maxSize based on sizeCalculation", () => {
      const lru = new LRUCache<string, string>({
        maxSize: 10,
        sizeCalculation: (val) => val.length,
      });

      lru.set("k1", "12345"); // size 5
      lru.set("k2", "12345"); // size 5, total 10
      expect(lru.size).toBe(2);
      expect(lru.calculatedSize).toBe(10);

      // Adding k3 (size 5) causes k1 to be evicted
      lru.set("k3", "12345");
      expect(lru.has("k1")).toBe(false);
      expect(lru.has("k2")).toBe(true);
      expect(lru.has("k3")).toBe(true);
      expect(lru.calculatedSize).toBe(10);
    });

    test("expires entries after TTL", async () => {
      const lru = new LRUCache<string, string>({
        max: 10,
        ttl: 40,
      });

      lru.set("temp", "value");
      expect(lru.get("temp")).toBe("value");

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(lru.get("temp")).toBeUndefined();
      expect(lru.has("temp")).toBe(false);
    });

    test("memoryLlmCache and memoryEmbeddingCache have configured size limits and TTL", () => {
      expect(DEFAULT_MEMORY_CACHE_TTL_MS).toBe(2 * 60 * 60 * 1000);
      expect(DEFAULT_MEMORY_LLM_CACHE_MAX_BYTES).toBe(50 * 1024 * 1024);
      expect(DEFAULT_MEMORY_EMBED_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);

      memoryLlmCache.set("test-key", "test-val");
      expect(memoryLlmCache.get("test-key")).toBe("test-val");
      expect(memoryLlmCache.calculatedSize).toBeGreaterThan(0);

      memoryEmbeddingCache.set("test-emb", [0.1, 0.2, 0.3]);
      expect(memoryEmbeddingCache.get("test-emb")).toEqual([0.1, 0.2, 0.3]);
      expect(memoryEmbeddingCache.calculatedSize).toBe(24); // 3 * 8 bytes
    });
  });

  describe("expandQuery singleflight & readOnly LRU cache", () => {
    test("deduplicates concurrent calls to expandQuery for the same query", async () => {
      const store = createStore(":memory:");
      let llmCallCount = 0;

      const mockLlm = createMockLlm({
        expandQuery: vi.fn(async (q: string): Promise<Queryable[]> => {
          llmCallCount++;
          await new Promise(resolve => setTimeout(resolve, 50));
          return [
            { type: "lex", text: `${q} expanded lex` },
            { type: "vec", text: `${q} expanded vec` },
          ];
        }),
      });

      // Launch 4 concurrent calls with the same query
      const [r1, r2, r3, r4] = await Promise.all([
        expandQuery("how to use taylor series", "test-model", store.db, undefined, mockLlm),
        expandQuery("how to use taylor series", "test-model", store.db, undefined, mockLlm),
        expandQuery("how to use taylor series", "test-model", store.db, undefined, mockLlm),
        expandQuery("how to use taylor series", "test-model", store.db, undefined, mockLlm),
      ]);

      expect(r1).toEqual([
        { type: "lex", query: "how to use taylor series expanded lex" },
        { type: "vec", query: "how to use taylor series expanded vec" },
      ]);
      expect(r2).toEqual(r1);
      expect(r3).toEqual(r1);
      expect(r4).toEqual(r1);

      // The LLM must only be called ONCE
      expect(llmCallCount).toBe(1);
    });

    test("caches expandQuery in memoryLlmCache when database is readOnly", async () => {
      // Create store with readOnly: true (like MCP server mode)
      const store = createStore(":memory:", { readOnly: true });
      let llmCallCount = 0;

      const mockLlm = createMockLlm({
        expandQuery: vi.fn(async (q: string): Promise<Queryable[]> => {
          llmCallCount++;
          return [
            { type: "lex", text: `${q} lex` },
            { type: "vec", text: `${q} vec` },
          ];
        }),
      });

      // First query on read-only store
      const res1 = await expandQuery("taylor series", "test-model", store.db, undefined, mockLlm);
      expect(res1).toEqual([
        { type: "lex", query: "taylor series lex" },
        { type: "vec", query: "taylor series vec" },
      ]);
      expect(llmCallCount).toBe(1);
      expect(memoryLlmCache.size).toBeGreaterThan(0);

      // Second sequential query on the same read-only store
      const res2 = await expandQuery("taylor series", "test-model", store.db, undefined, mockLlm);
      expect(res2).toEqual(res1);
      // LLM call count should still be 1 (hit in-memory LRU cache)
      expect(llmCallCount).toBe(1);
    });

    test("cleans up in-flight state and propagates error on failure", async () => {
      const store = createStore(":memory:");
      let attempt = 0;

      const mockLlm = createMockLlm({
        expandQuery: vi.fn(async (): Promise<Queryable[]> => {
          attempt++;
          await new Promise(resolve => setTimeout(resolve, 20));
          if (attempt === 1) {
            throw new Error("Temporary network timeout");
          }
          return [{ type: "vec", text: "recovered" }];
        }),
      });

      await expect(
        Promise.all([
          expandQuery("error query", "test-model", store.db, undefined, mockLlm),
          expandQuery("error query", "test-model", store.db, undefined, mockLlm),
        ])
      ).rejects.toThrow("Temporary network timeout");

      const retryResult = await expandQuery("error query", "test-model", store.db, undefined, mockLlm);
      expect(retryResult).toEqual([{ type: "vec", query: "recovered" }]);
      expect(attempt).toBe(2);
    });

    test("writes to SQLite llm_cache without duplicate writes or lock contention under concurrency", async () => {
      const store = createStore(":memory:");
      let llmCallCount = 0;

      const mockLlm = createMockLlm({
        expandQuery: vi.fn(async (q: string): Promise<Queryable[]> => {
          llmCallCount++;
          await new Promise(resolve => setTimeout(resolve, 30));
          return [{ type: "lex", text: `${q} test` }];
        }),
      });

      // Launch 5 concurrent calls on writable store
      const results = await Promise.all([
        expandQuery("concurrency query", "test-model", store.db, undefined, mockLlm),
        expandQuery("concurrency query", "test-model", store.db, undefined, mockLlm),
        expandQuery("concurrency query", "test-model", store.db, undefined, mockLlm),
        expandQuery("concurrency query", "test-model", store.db, undefined, mockLlm),
        expandQuery("concurrency query", "test-model", store.db, undefined, mockLlm),
      ]);

      expect(results).toHaveLength(5);
      expect(llmCallCount).toBe(1);

      // Verify the result is cached in SQLite table and written only once
      const cached = store.db.prepare("SELECT count(*) as count FROM llm_cache").get() as { count: number };
      expect(cached.count).toBe(1);
    });
  });

  describe("embedQueriesForStore singleflight & in-memory caching", () => {
    test("deduplicates concurrent batch embedding calls with provider and caches in memory", async () => {
      let providerBatchCallCount = 0;

      const mockProvider: EmbeddingProvider = {
        providerId: "remote-test",
        model: "openai/text-embedding-3-small",
        dimension: 2,
        remote: true,
        formatQuery: (q: string) => q,
        formatDocument: (t: string) => t,
        canonicalIdentityMaterial: () => JSON.stringify({ provider: "remote-test", model: "openai/text-embedding-3-small", dimension: 2 }),
        embed: vi.fn(async (text: string): Promise<EmbeddingVector> => ({
          vector: [0.1, 0.2],
          model: "openai/text-embedding-3-small",
          dimension: 2,
        })),
        embedBatch: vi.fn(async (texts: string[]): Promise<EmbeddingVector[]> => {
          providerBatchCallCount++;
          await new Promise(resolve => setTimeout(resolve, 50));
          return texts.map((t, idx) => ({
            vector: [0.1 * (idx + 1), 0.2 * (idx + 1)],
            model: "openai/text-embedding-3-small",
            dimension: 2,
          }));
        }),
        close: async () => {},
      };

      const store = createStore(":memory:", { embeddingProvider: mockProvider });
      store.authorizeRemoteRequest = () => {};
      const identity = remoteEmbeddingIdentity(mockProvider);
      const lease = beginEmbeddingBuild(store.db, identity, {
        ownerId: "test-singleflight",
        now: 1_000,
        leaseMs: 1_000,
        allowDestructiveRebuild: true,
      });
      store.ensureVecTable(identity.dimension);
      completeEmbeddingBuild(store.db, lease, 1_100);

      const queries = ["query 1", "query 2"];

      // 1. Launch 3 concurrent calls
      const [res1, res2, res3] = await Promise.all([
        embedQueriesForStore(store, queries),
        embedQueriesForStore(store, queries),
        embedQueriesForStore(store, queries),
      ]);

      expect(res1.embeddings).toEqual([
        [0.1, 0.2],
        [0.2, 0.4],
      ]);
      expect(res2.embeddings).toEqual(res1.embeddings);
      expect(res3.embeddings).toEqual(res1.embeddings);
      expect(providerBatchCallCount).toBe(1);

      // 2. Sequential call with the same queries should hit memoryEmbeddingCache directly
      const res4 = await embedQueriesForStore(store, queries);
      expect(res4.embeddings).toEqual(res1.embeddings);
      expect(providerBatchCallCount).toBe(1); // Still 1! No new embedding call

      // 3. Partial overlap: ["query 1", "query 3"] -> only "query 3" needs embedding
      const res5 = await embedQueriesForStore(store, ["query 1", "query 3"]);
      expect(providerBatchCallCount).toBe(2);
      expect(mockProvider.embedBatch).toHaveBeenLastCalledWith(["query 3"], expect.anything());
      expect(res5.embeddings[0]).toEqual([0.1, 0.2]); // query 1 was from cache
    });

    test("deduplicates concurrent batch embedding calls with local LLM and caches in memory", async () => {
      const store = createStore(":memory:");
      let llmBatchCallCount = 0;

      const mockLlama = {
        embedModelName: "local-embedding-model",
        embedBatch: vi.fn(async (texts: string[]) => {
          llmBatchCallCount++;
          await new Promise(resolve => setTimeout(resolve, 50));
          return texts.map((t, idx) => ({
            embedding: [0.5 * (idx + 1), 0.6 * (idx + 1)],
          }));
        }),
      };

      (store as { localLlm?: typeof mockLlama }).localLlm = mockLlama;

      const queries = ["alpha", "beta"];

      // Launch 3 concurrent calls
      const [res1, res2, res3] = await Promise.all([
        embedQueriesForStore(store, queries),
        embedQueriesForStore(store, queries),
        embedQueriesForStore(store, queries),
      ]);

      expect(res1.embeddings).toEqual([
        [0.5, 0.6],
        [1.0, 1.2],
      ]);
      expect(res2.embeddings).toEqual(res1.embeddings);
      expect(res3.embeddings).toEqual(res1.embeddings);
      expect(llmBatchCallCount).toBe(1);

      // Sequential call should hit memoryEmbeddingCache
      const res4 = await embedQueriesForStore(store, queries);
      expect(res4.embeddings).toEqual(res1.embeddings);
      expect(llmBatchCallCount).toBe(1);
    });

    test("falls back to sequential embed() with formatted query when embedBatch fails", async () => {
      const store = createStore(":memory:");
      const embeddedCalls: string[] = [];

      const mockLlama = {
        embedModelName: "local-embedding-model",
        embedBatch: vi.fn(async () => {
          throw new Error("Batch embed failed, please fall back");
        }),
        embed: vi.fn(async (text: string) => {
          embeddedCalls.push(text);
          return { embedding: [0.9, 0.8] };
        }),
      };

      (store as { localLlm?: typeof mockLlama }).localLlm = mockLlama;

      const queries = ["query A", "query B"];
      const res = await embedQueriesForStore(store, queries);

      expect(mockLlama.embedBatch).toHaveBeenCalledTimes(1);
      expect(mockLlama.embed).toHaveBeenCalledTimes(2);
      // Ensure formatted query was passed
      expect(embeddedCalls).toEqual([
        "task: search result | query: query A",
        "task: search result | query: query B",
      ]);
      expect(res.embeddings).toHaveLength(2);
      expect(res.embeddings[0]).toEqual([0.9, 0.8]);
      expect(res.embeddings[1]).toEqual([0.9, 0.8]);
    });
  });
});
