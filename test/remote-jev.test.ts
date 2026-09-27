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
        systemOne: vi.fn(async (req: any) => {
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
      expect(capturedRequest.state.query).toBe("sqlite-vec indexing");
      expect(capturedRequest.state.current_time).toBeDefined();
      expect(res1.strategy).toBe("code_search");
      expect(res1.confidence).toBe(0.92);
      expect(res1.needsHyde).toBe(true);

      // Call with context (user comment 2: context passed to jev state)
      const res2 = await jev.classifyIntent("fix connection error", { context: "in postgres pool handler" });
      expect(capturedRequest.state.query).toBe("fix connection error");
      expect(capturedRequest.state.context).toBe("in postgres pool handler");
      expect(capturedRequest.state.current_time).toBeDefined();
      expect(res2.strategy).toBe("code_search");
    });

    test("rerank computes scores via noul and sorts descending in a single batch request", async () => {
      const calls: any[] = [];
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async (req: any) => {
          calls.push(req);
          return {
            answers: {
              cand_0: {
                type: "noul",
                noul: 0.42,
              },
              cand_1: {
                type: "noul",
                noul: 0.95,
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

      const result = await jev.rerank("search query", docs, { context: "technical documentation" });
      expect(result.model).toBe("jev:jev-1.13");
      expect(result.results.length).toBe(2);
      // doc2 should be ranked first because score is 0.95
      expect(result.results[0]?.file).toBe("doc2.md");
      expect(result.results[0]?.score).toBe(0.95);
      expect(result.results[1]?.file).toBe("doc1.md");
      expect(result.results[1]?.score).toBe(0.42);

      // Verify single request was made
      expect(calls.length).toBe(1);
      const req = calls[0];

      // Verify state has query, current_time, and context
      expect(req.state.query).toBe("search query");
      expect(req.state.current_time).toBeDefined();
      expect(req.state.context).toBe("technical documentation");

      // Verify cand_0 instructions contain structured metadata and question
      expect(req.questions.cand_0).toBeDefined();
      expect(req.questions.cand_0.instructions.candidate).toBe("this is somewhat relevant");
      expect(req.questions.cand_0.instructions.title).toBe("Doc 1");
      expect(req.questions.cand_0.instructions.file).toBe("doc1.md");
      expect(req.questions.cand_0.instructions.question).toContain("`candidate`");
      expect(req.questions.cand_0.instructions.question).toContain("`query`");

      // Verify cand_1 instructions
      expect(req.questions.cand_1).toBeDefined();
      expect(req.questions.cand_1.instructions.candidate).toBe("this is a perfect match for the query");
    });

    test("rerank splits documents into micro-batches when count exceeds batchSize", async () => {
      const calls: any[] = [];
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async (req: any) => {
          calls.push(req);
          const answers: Record<string, any> = {};
          for (const key of Object.keys(req.questions)) {
            answers[key] = { type: "noul", noul: 0.5 };
          }
          return { answers };
        }),
      };

      // batchSize 2, 5 documents -> 3 batches
      const jev = new RemoteJev({ client: mockClient, batchSize: 2 });
      const docs = Array.from({ length: 5 }, (_, i) => ({ file: `doc${i}.md`, text: `chunk ${i}` }));

      const res = await jev.rerank("query", docs);
      expect(res.results.length).toBe(5);
      expect(calls.length).toBe(3);
      expect(Object.keys(calls[0].questions).length).toBe(2); // cand_0, cand_1
      expect(Object.keys(calls[1].questions).length).toBe(2); // cand_0, cand_1
      expect(Object.keys(calls[2].questions).length).toBe(1); // cand_0
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

    test("does not permanently disable provider on transient failure", async () => {
      let callCount = 0;
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          callCount++;
          if (callCount === 1) throw new Error("Transient network glitch");
          return {
            answers: {
              cand_0: { type: "noul", noul: 0.9 },
            },
          };
        }),
      };

      const jev = new RemoteJev({ client: mockClient });
      expect(jev.supportsRerank).toBe(true);

      // Call 1 fails
      await expect(jev.rerank("query", [{ file: "a.md", text: "content" }])).rejects.toThrow("Transient network glitch");
      // Call 2 succeeds immediately without permanent circuit lock
      const res = await jev.rerank("query", [{ file: "a.md", text: "content" }]);
      expect(res.results[0]?.score).toBe(0.9);
      expect(jev.supportsRerank).toBe(true);
    });

    test("pMap aborts remaining queue when a worker throws", async () => {
      let processed = 0;
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async () => {
          processed++;
          throw new Error("Batch error");
        }),
      };

      // batchSize 2, concurrency 1, 10 docs -> 5 batches
      const jev = new RemoteJev({ client: mockClient, batchSize: 2, concurrency: 1 });
      const docs = Array.from({ length: 10 }, (_, i) => ({ file: `doc${i}.md`, text: `text ${i}` }));

      await expect(jev.rerank("query", docs)).rejects.toThrow("Batch error");
      // Only the first batch should have run before aborting
      expect(processed).toBe(1);
    });

    test("safely truncates candidate text without breaking surrogate pairs", async () => {
      let capturedText = "";
      const mockClient: JevSystemOneClient = {
        systemOne: vi.fn(async (req: any) => {
          capturedText = req.questions.cand_0.instructions.candidate;
          return { answers: { cand_0: { type: "noul", noul: 0.5 } } };
        }),
      };

      const jev = new RemoteJev({ client: mockClient });
      // Create a string of 1499 ASCII characters + one emoji (surrogate pair, length 2)
      // Total length 1501. Truncating at 1500 without safe surrogate handling would leave a lone high surrogate.
      const text = "a".repeat(1499) + "🚀";
      await jev.rerank("query", [{ file: "test.md", text }]);
      // The high surrogate at 1500 should be safely dropped, leaving 1499 chars
      expect(capturedText).toBe("a".repeat(1499));
      expect(/[\uD800-\uDFFF]/.test(capturedText)).toBe(false);
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
              cand_0: { type: "noul", noul: 0.88 },
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
      // and searchIntent contains strategy playbook details without polluting context
      expect(passedOptionsToLocal.includeHyde).toBe(true);
      expect(passedOptionsToLocal.context).toBe("auth module");
      expect(passedOptionsToLocal.searchIntent).toBeDefined();
      expect(passedOptionsToLocal.searchIntent.label).toBe("Code Search");
      expect(passedOptionsToLocal.searchIntent.lexGuidance).toContain("Prioritize exact function");
      expect(passedOptionsToLocal.searchIntent.vecGuidance).toContain("concrete implementation");
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

    test("modelExists checks provider presence before returning true for jev models", async () => {
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async () => ({ name: "local", exists: false }),
        expandQuery: async () => [],
        rerank: async () => ({ results: [], model: "local" }),
        dispose: async () => {},
      };

      // When remoteJev is NOT configured
      const hybridWithoutJev = new Hybrid(mockLocalLLM);
      const resWithoutJev = await hybridWithoutJev.modelExists("jev:jev-1.13");
      expect(resWithoutJev.exists).toBe(false);

      // When remoteJev IS configured
      const mockJevClient: JevSystemOneClient = { systemOne: vi.fn() };
      const jev = new RemoteJev({ client: mockJevClient });
      const hybridWithJev = new Hybrid(mockLocalLLM, undefined, jev);
      const resWithJev = await hybridWithJev.modelExists("jev:jev-1.13");
      expect(resWithJev.exists).toBe(true);
    });

    test("rerankModelName provides isolated cache namespace for Jev, RemoteLLM, and LocalLLM", () => {
      const mockLocalLLM: any = {
        rerankModelName: "local-qwen",
      };
      const mockJevClient: JevSystemOneClient = { systemOne: vi.fn() };
      const jev = new RemoteJev({ client: mockJevClient, model: "jev-1.13" });
      expect(jev.rerankModelName).toBe("jev:jev-1.13");

      // Hybrid with Jev prioritizes Jev's model name
      const hybridWithJev = new Hybrid(mockLocalLLM, undefined, jev);
      expect(hybridWithJev.rerankModelName).toBe("jev:jev-1.13");

      // Hybrid with RemoteLLM (no Jev)
      const mockRemoteLLM: any = {
        supportsRerank: true,
        rerankModelName: "remote-bge-reranker",
      };
      const hybridWithRemote = new Hybrid(mockLocalLLM, mockRemoteLLM);
      expect(hybridWithRemote.rerankModelName).toBe("remote-bge-reranker");

      // Hybrid with LocalLLM only
      const hybridLocalOnly = new Hybrid(mockLocalLLM);
      expect(hybridLocalOnly.rerankModelName).toBe("local-qwen");
    });
  });
});
