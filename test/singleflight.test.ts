import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  createStore,
  expandQuery,
  embedQueriesForStore,
  resetInflightState,
  memoryLlmCache,
  LruCache,
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

  describe("LruCache basic operations", () => {
    test("evicts least recently used items when maxSize is exceeded", () => {
      const lru = new LruCache<string, number>(3);
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
  });
});
