import { describe, expect, test, vi } from "vitest";
import { RemoteJev, type JevSystemOneClient } from "../src/remote-jev.js";
import { Hybrid } from "../src/hybrid.js";
import type { LLM } from "../src/llm.js";

describe("RemoteJev & Hybrid Integration", () => {
  describe("RemoteJev", () => {
    test("initializes with default options", () => {
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(),
      };

      const jev = new RemoteJev({ client: mockClient });
      expect(jev.model).toBe("jev-1.13");
      expect(jev.concurrency).toBe(10);
      expect(jev.supportsRerank).toBe(true);
      expect(jev.supportsExpand).toBe(true);
    });

    test("classifyIntent passes query and optional context to Jev state", async () => {
      let capturedRequest: any = null;
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async (req) => {
          capturedRequest = req;
          return {
            answers: {
              strategy: {
                type: "choice",
                choice: "code_search",
                confidence: 0.92,
                probabilities: { code_search: 0.92, concept_search: 0.08 },
              },
              needs_hyde: {
                type: "noul",
                noul: 0.85,
              },
            },
          };
        }),
      };

      const jev = new RemoteJev({ client: mockClient, model: "jev-1.13" });

      // Call without context
      const res1 = await jev.classifyIntent("sqlite-vec indexing");
      expect(capturedRequest.state).toEqual({ query: "sqlite-vec indexing" });
      expect(res1.strategy).toBe("code_search");
      expect(res1.confidence).toBe(0.92);
      expect(res1.needsHyde).toBe(true);

      // Call with context (user comment 2: context passed to jev state)
      const res2 = await jev.classifyIntent("fix connection error", { context: "in postgres pool handler" });
      expect(capturedRequest.state).toEqual({
        query: "fix connection error",
        context: "in postgres pool handler",
      });
      expect(res2.strategy).toBe("code_search");
    });

    test("rerank computes scores via noul and sorts descending", async () => {
      const calls: any[] = [];
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async (req) => {
          calls.push(req);
          const candidate = req.state.candidate;
          // Return higher score for doc2 than doc1
          const noulScore = candidate.includes("perfect match") ? 0.95 : 0.42;
          return {
            answers: {
              is_relevant: {
                type: "noul",
                noul: noulScore,
              },
            },
          };
        }),
      };

      const jev = new RemoteJev({ client: mockClient });
      const docs = [
        { file: "doc1.md", text: "this is somewhat relevant", title: "Doc 1" },
        { file: "doc2.md", text: "this is a perfect match for the query" },
      ];

      const result = await jev.rerank("search query", docs);
      expect(result.model).toBe("jev:jev-1.13");
      expect(result.results.length).toBe(2);
      // doc2 should be ranked first because score is 0.95
      expect(result.results[0]?.file).toBe("doc2.md");
      expect(result.results[0]?.score).toBe(0.95);
      expect(result.results[1]?.file).toBe("doc1.md");
      expect(result.results[1]?.score).toBe(0.42);

      // Verify title was included in state when present
      const doc1Call = calls.find(c => c.state.file === "doc1.md" || c.state.title === "Doc 1");
      expect(doc1Call.state.title).toBe("Doc 1");
    });

    test("rerank handles empty documents", async () => {
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(),
      };

      const jev = new RemoteJev({ client: mockClient });
      const result = await jev.rerank("query", []);
      expect(result.results).toEqual([]);
      expect(mockClient.systemOne).not.toHaveBeenCalled();
    });

    test("trips circuit breaker on failure and can be reset", async () => {
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          throw new Error("Network error");
        }),
      };

      const jev = new RemoteJev({ client: mockClient });
      expect(jev.supportsRerank).toBe(true);

      await expect(jev.rerank("query", [{ file: "a.md", text: "content" }])).rejects.toThrow("Network error");
      expect(jev.supportsRerank).toBe(false);
      expect(jev.supportsExpand).toBe(false);

      // Subsequent call fails immediately due to broken circuit
      await expect(jev.classifyIntent("query")).rejects.toThrow("RemoteJev circuit is broken");

      // Reset
      jev.resetCircuitBreaker();
      expect(jev.supportsRerank).toBe(true);
      expect(jev.supportsExpand).toBe(true);
    });
  });

  describe("Hybrid (3-way fallback: Jev -> RemoteLLM -> LocalLLM)", () => {
    test("rerank prioritizes Jev, falls back to RemoteLLM, then LocalLLM", async () => {
      let localRerankCalled = false;
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async (m) => ({ name: m, exists: true }),
        expandQuery: async (q) => [{ type: "vec", text: `local:${q}` }],
        rerank: async (_q, docs) => {
          localRerankCalled = true;
          return {
            results: docs.map((d, i) => ({ file: typeof d === "string" ? d : d.file, score: 0.3, index: i })),
            model: "local-rerank",
          };
        },
        dispose: async () => {},
      };

      let jevShouldFail = false;
      const mockJevClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          if (jevShouldFail) throw new Error("Jev service unavailable");
          return {
            answers: {
              is_relevant: { type: "noul", noul: 0.88 },
            },
          };
        }),
      };
      const jev = new RemoteJev({ client: mockJevClient });

      const hybrid = new Hybrid(mockLocalLLM, undefined, jev);

      // 1. Jev succeeds
      const res1 = await hybrid.rerank("query", [{ file: "f.md", text: "t" }]);
      expect(res1.model).toBe("jev:jev-1.13");
      expect(res1.results[0]?.score).toBe(0.88);
      expect(localRerankCalled).toBe(false);

      // 2. Jev fails -> fallback to LocalLLM
      jevShouldFail = true;
      jev.resetCircuitBreaker();
      const res2 = await hybrid.rerank("query", [{ file: "f.md", text: "t" }]);
      expect(res2.model).toBe("local-rerank");
      expect(localRerankCalled).toBe(true);
    });

    test("expandQuery uses Jev intent classification to guide LLM expansion", async () => {
      let passedOptionsToLocal: any = null;
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async (m) => ({ name: m, exists: true }),
        expandQuery: async (q, opts) => {
          passedOptionsToLocal = opts;
          return [{ type: "vec", text: `expanded:${q}` }];
        },
        rerank: async () => ({ results: [], model: "local" }),
        dispose: async () => {},
      };

      const mockJevClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          return {
            answers: {
              strategy: {
                type: "choice",
                choice: "code_search",
                confidence: 0.85,
                probabilities: { code_search: 0.85 },
              },
              needs_hyde: {
                type: "noul",
                noul: 0.9,
              },
            },
          };
        }),
      };
      const jev = new RemoteJev({ client: mockJevClient });

      const hybrid = new Hybrid(mockLocalLLM, undefined, jev);

      const expanded = await hybrid.expandQuery("fetch user token", { context: "auth module" });
      expect(expanded).toEqual([{ type: "vec", text: "expanded:fetch user token" }]);

      // Verify that options passed to LLM include Jev guidance:
      // includeHyde set to true (since needs_hyde.noul > 0.6)
      // and context includes Intent strategy
      expect(passedOptionsToLocal.includeHyde).toBe(true);
      expect(passedOptionsToLocal.context).toContain("auth module");
      expect(passedOptionsToLocal.context).toContain("Intent strategy: code_search");
    });

    test("expandQuery skips Jev guidance when confidence is below 0.5", async () => {
      let passedOptionsToLocal: any = null;
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async (m) => ({ name: m, exists: true }),
        expandQuery: async (q, opts) => {
          passedOptionsToLocal = opts;
          return [{ type: "vec", text: `expanded:${q}` }];
        },
        rerank: async () => ({ results: [], model: "local" }),
        dispose: async () => {},
      };

      const mockJevClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          return {
            answers: {
              strategy: {
                type: "choice",
                choice: "broad_exploration",
                confidence: 0.35, // low confidence
                probabilities: { broad_exploration: 0.35 },
              },
              needs_hyde: {
                type: "noul",
                noul: 0.2,
              },
            },
          };
        }),
      };
      const jev = new RemoteJev({ client: mockJevClient });

      const hybrid = new Hybrid(mockLocalLLM, undefined, jev);

      const initialOpts = { context: "original context" };
      await hybrid.expandQuery("ambiguous query", initialOpts);

      // Low confidence skips guidance, original options passed unmodified
      expect(passedOptionsToLocal).toEqual(initialOpts);
    });

    test("expandQuery gracefully falls back when Jev throws", async () => {
      let passedOptionsToLocal: any = null;
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async (m) => ({ name: m, exists: true }),
        expandQuery: async (q, opts) => {
          passedOptionsToLocal = opts;
          return [{ type: "vec", text: `expanded:${q}` }];
        },
        rerank: async () => ({ results: [], model: "local" }),
        dispose: async () => {},
      };

      const mockJevClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          throw new Error("Jev network error");
        }),
      };
      const jev = new RemoteJev({ client: mockJevClient });

      const hybrid = new Hybrid(mockLocalLLM, undefined, jev);

      const initialOpts = { context: "original context" };
      const res = await hybrid.expandQuery("query", initialOpts);
      expect(res).toEqual([{ type: "vec", text: "expanded:query" }]);
      expect(passedOptionsToLocal).toEqual(initialOpts);
    });
  });
});
