import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RemoteLLM, resolveEndpointUrl, sigmoid } from "../src/remote-llm.js";
import { HybridLLM } from "../src/hybrid-llm.js";
import type { LLM, Queryable, RerankDocument, RerankResult } from "../src/llm.js";
import { resolveExpansionPolicy } from "../src/search/query-expansion.js";

describe("TODO 1: RemoteLLM & HybridLLM Integration", () => {
  let mockServer: Server;
  let serverPort: number;
  let lastRequestBody: any = null;
  let mockResponseStatus = 200;
  let mockResponseBody: any = {};

  beforeEach(async () => {
    lastRequestBody = null;
    mockResponseStatus = 200;
    mockResponseBody = {};

    await new Promise<void>((resolve) => {
      mockServer = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          if (body) {
            try { lastRequestBody = JSON.parse(body); } catch {}
          }
          res.writeHead(mockResponseStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(mockResponseBody));
        });
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        serverPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  describe("RemoteLLM", () => {
    test("supportsExpand and supportsRerank flags work correctly with URL aliases and smart endpoint resolution", () => {

      // Smart resolution: Base URL gets default endpoint appended
      expect(resolveEndpointUrl("http://127.0.0.1:8080/v1", "/chat/completions")).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(resolveEndpointUrl("http://127.0.0.1:8080/v1/", "/rerank")).toBe("http://127.0.0.1:8080/v1/rerank");

      // Explicit endpoint URLs are preserved as-is
      expect(resolveEndpointUrl("http://127.0.0.1:8080/v1/chat/completions", "/chat/completions")).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(resolveEndpointUrl("http://127.0.0.1:8080/v1/rerank", "/rerank")).toBe("http://127.0.0.1:8080/v1/rerank");

      // Supports generate_url / generate_base_url / generate_api_url aliases
      const llm = new RemoteLLM({
        generateUrl: `http://127.0.0.1:${serverPort}/v1`,
        generateApiModel: "gpt-4o-mini",
        rerankBaseUrl: `http://127.0.0.1:${serverPort}/v1`,
        rerankApiModel: "bge-reranker-v2-m3",
      });

      expect(llm.supportsExpand).toBe(true);
      expect(llm.supportsRerank).toBe(true);
    });

    test("expandQuery calls chat completions endpoint and parses typed lines", async () => {
      mockResponseBody = {
        choices: [
          {
            message: {
              content: "lex: database pool timeout\nvec: why is database connection pool timing out under load?\nhyde: Connection pool exhaustion occurs when...",
            },
          },
        ],
      };

      const llm = new RemoteLLM({
        generateApiUrl: `http://127.0.0.1:${serverPort}/v1/chat/completions`,
        generateApiModel: "gpt-4o-mini",
      });

      const result = await llm.expandQuery("db pool timeout");
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: "lex", text: "database pool timeout" });
      expect(result[1]).toEqual({ type: "vec", text: "why is database connection pool timing out under load?" });
      expect(result[2]).toEqual({ type: "hyde", text: "Connection pool exhaustion occurs when..." });

      expect(lastRequestBody.model).toBe("gpt-4o-mini");
    });

    test("rerank calls rerank endpoint and applies sigmoid normalization to log-odds scores", async () => {
      mockResponseBody = {
        results: [
          { index: 0, relevance_score: 5.2 }, // log-odds score > 1
          { index: 1, relevance_score: -2.1 }, // log-odds score < 0
          { index: 2, relevance_score: 0.85 }, // already 0..1
        ],
      };

      const llm = new RemoteLLM({
        rerankApiUrl: `http://127.0.0.1:${serverPort}/v1/rerank`,
        rerankApiModel: "bge-reranker-v2-m3",
      });

      const docs: RerankDocument[] = [
        { file: "a.md", text: "Doc A" },
        { file: "b.md", text: "Doc B" },
        { file: "c.md", text: "Doc C" },
      ];

      const res = await llm.rerank("query text", docs);
      expect(res.results).toHaveLength(3);
      expect(res.results[0]?.score).toBeCloseTo(sigmoid(5.2), 4);
      expect(res.results[1]?.score).toBeCloseTo(sigmoid(-2.1), 4);
      expect(res.results[2]?.score).toBe(0.85);
    });

    test("rerank falls back to LLM chat completions reranking on 404 or when /chat/completions is configured", async () => {
      mockResponseBody = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { index: 0, score: 0.92 },
                  { index: 1, score: 0.15 },
                ],
              }),
            },
          },
        ],
      };

      const llm = new RemoteLLM({
        rerankApiUrl: `http://127.0.0.1:${serverPort}/v1/chat/completions`,
        rerankApiModel: "gpt-4o-mini",
      });

      const docs: RerankDocument[] = [
        { file: "doc1.md", text: "First candidate text" },
        { file: "doc2.md", text: "Second candidate text" },
      ];

      const res = await llm.rerank("connection pool timeout", docs);
      expect(res.results).toHaveLength(2);
      expect(res.results[0]).toEqual({ file: "doc1.md", score: 0.92, index: 0 });
      expect(res.results[1]).toEqual({ file: "doc2.md", score: 0.15, index: 1 });
    });

    test("circuit breaker triggers when remote API fails", async () => {
      mockResponseStatus = 500;

      const llm = new RemoteLLM({
        rerankApiUrl: `http://127.0.0.1:${serverPort}/v1/rerank`,
        rerankApiModel: "bge-reranker-v2-m3",
      });

      expect(llm.supportsRerank).toBe(true);

      await expect(llm.rerank("query", [{ file: "a.md", text: "doc" }])).rejects.toThrow();

      // Circuit breaker is now active
      expect(llm.supportsRerank).toBe(false);
    });
  });

  describe("HybridLLM", () => {
    test("routes expand & rerank to remote, with local fallback on error", async () => {
      const mockLocalLLM: LLM = {
        embed: async () => null,
        generate: async () => null,
        modelExists: async (m) => ({ name: m, exists: true }),
        expandQuery: async (q) => [{ type: "vec", text: `local:${q}` }],
        rerank: async (_q, docs) => ({
          results: docs.map((d, i) => ({ file: typeof d === "string" ? d : d.file, score: 0.5, index: i })),
          model: "local-rerank",
        }),
        dispose: async () => {},
      };

      // Remote that fails immediately (status 500)
      mockResponseStatus = 500;
      const remoteLLM = new RemoteLLM({
        generateApiUrl: `http://127.0.0.1:${serverPort}/v1/chat/completions`,
        generateApiModel: "gpt-4o-mini",
        rerankApiUrl: `http://127.0.0.1:${serverPort}/v1/rerank`,
        rerankApiModel: "bge-reranker",
      });

      const hybrid = new HybridLLM(mockLocalLLM, remoteLLM);

      // Should fall back to local model gracefully without throwing
      const expanded = await hybrid.expandQuery("test query");
      expect(expanded).toEqual([{ type: "vec", text: "local:test query" }]);

      const reranked = await hybrid.rerank("test query", [{ file: "doc1.md", text: "content" }]);
      expect(reranked.model).toBe("local-rerank");
      expect(reranked.results[0]?.score).toBe(0.5);
    });

    test("allows CJK query expansion when remote LLM generate_api_url is configured", () => {
      // Without allowCjkExpand: skips CJK
      const defaultDecision = resolveExpansionPolicy({
        query: "搜尋關鍵字",
        mode: "auto",
        strongSignal: false,
        allowCjkExpand: false,
      });
      expect(defaultDecision.action).toBe("skip");
      expect(defaultDecision.reason).toBe("cjk-default");

      // With allowCjkExpand (remote LLM active): auto-expands CJK query
      const remoteDecision = resolveExpansionPolicy({
        query: "搜尋關鍵字",
        mode: "auto",
        strongSignal: false,
        allowCjkExpand: true,
      });
      expect(remoteDecision.action).toBe("expand");
      expect(remoteDecision.reason).toBe("auto-expand");
    });
  });
});
