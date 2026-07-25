import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  OpenAIEmbeddingProvider as RuntimeOpenAIEmbeddingProvider,
  canonicalOpenAIEmbeddingIdentityMaterial,
  type OpenAIEmbeddingProviderOptions,
} from "../src/embedding/openai.js";
import {
  OPENAI_EMBEDDING_DIMENSION,
  OPENAI_EMBEDDING_MODEL,
} from "../src/embedding/config.js";
import { REMOTE_EMBEDDING_CHUNK_PROFILE } from "../src/embedding/remote-chunking.js";

const servers: Server[] = [];
const DOCUMENT_OPTIONS = {
  purpose: "index-build",
  kind: "document",
  identityFingerprint: "full-build-identity",
} as const;
const ALLOW_REMOTE_REQUEST = () => {};

class OpenAIEmbeddingProvider extends RuntimeOpenAIEmbeddingProvider {
  constructor(options: OpenAIEmbeddingProviderOptions) {
    super({ authorizeRequest: ALLOW_REMOTE_REQUEST, ...options });
  }
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
});

describe("OpenAIEmbeddingProvider", () => {
  test("rejects a remote request without a complete build identity before authorization or fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const authorizeRequest = vi.fn();
    const provider = new RuntimeOpenAIEmbeddingProvider({
      apiKey: String(process.pid),
      fetch,
      authorizeRequest,
      maxAttempts: 1,
    });

    await expect(provider.embed("query", {
      purpose: "query-embedding",
      kind: "query",
    })).rejects.toMatchObject({ code: "IDENTITY_FINGERPRINT_REQUIRED" });
    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("fails closed before fetch when no remote request guard is installed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    const provider = new RuntimeOpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(provider.embed("must stay local", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "REMOTE_AUTHORIZATION_REQUIRED",
    });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("reauthorizes after retry delay immediately before every fetch attempt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const authorizeRequest = vi.fn((request: { attempt: number }) => {
      if (request.attempt === 2) throw new Error("consent revoked");
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
      authorizeRequest,
    } as never);

    await expect(provider.embed("retry authorization", DOCUMENT_OPTIONS)).rejects.toThrow("consent revoked");
    expect(authorizeRequest.mock.calls.map(([request]) => request.attempt)).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("interrupts a pending asynchronous request guard at the operation deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new RuntimeOpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
      authorizeRequest: async () => new Promise<void>(() => {}),
    });

    await expect(provider.embed("deadline guarded", {
      ...DOCUMENT_OPTIONS,
      deadline: Date.now() + 20,
    })).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  }, 5_000);

  test("close interrupts a pending asynchronous request guard", async () => {
    let guardStarted!: () => void;
    const started = new Promise<void>(resolve => { guardStarted = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new RuntimeOpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
      authorizeRequest: async () => {
        guardStarted();
        await new Promise<void>(() => {});
      },
    });
    const operation = provider.embed("close guarded", DOCUMENT_OPTIONS);
    await started;

    await provider.close();
    await expect(operation).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
    expect(fetch).not.toHaveBeenCalled();
  }, 5_000);

  test("binds custom endpoints into canonical identity material without retaining their URLs", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "first-secret-key",
      baseUrl: "https://first.invalid/v1",
      maxAttempts: 1,
    });
    const otherProvider = new OpenAIEmbeddingProvider({
      apiKey: "second-secret-key",
      baseUrl: "https://second.invalid/v1",
      maxAttempts: 1,
    });
    const expectedDefault = JSON.stringify({
      provider: "openai",
      model: OPENAI_EMBEDDING_MODEL,
      dimension: OPENAI_EMBEDDING_DIMENSION,
      remote: true,
      format: "qmd-openai-embedding-v1",
      chunking: REMOTE_EMBEDDING_CHUNK_PROFILE,
    });

    expect(provider.canonicalIdentityMaterial()).not.toBe(otherProvider.canonicalIdentityMaterial());
    expect(provider.canonicalIdentityMaterial()).toContain("endpointFingerprint");
    expect(otherProvider.canonicalIdentityMaterial()).toContain("endpointFingerprint");
    expect(provider.canonicalIdentityMaterial()).not.toContain("secret");
    expect(provider.canonicalIdentityMaterial()).not.toContain("invalid");
    expect(canonicalOpenAIEmbeddingIdentityMaterial()).toBe(expectedDefault);
    await provider.close();
    await otherProvider.close();
  });

  test("rejects non-canonical dimensions in OpenAI identity material", async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", maxAttempts: 1 });

    for (const dimension of [OPENAI_EMBEDDING_DIMENSION - 1, NaN, Infinity]) {
      expect(() => provider.canonicalIdentityMaterialForDimension(dimension)).toThrow(
        "OpenAI embedding dimension",
      );
    }
    await provider.close();
  });

  test("fails closed when purpose and input kind are inconsistent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch });

    await expect(provider.embed("document disguised as query", {
      purpose: "query-embedding",
      kind: "document",
      identityFingerprint: DOCUMENT_OPTIONS.identityFingerprint,
    })).rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_REQUIRED" });
    await expect(provider.embed("query disguised as index input", {
      purpose: "index-build",
      kind: "query",
      identityFingerprint: DOCUMENT_OPTIONS.identityFingerprint,
    })).rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_REQUIRED" });
    await expect(provider.embed("unknown purpose", {
      purpose: "bogus",
      kind: "document",
      identityFingerprint: DOCUMENT_OPTIONS.identityFingerprint,
    } as never)).rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_REQUIRED" });
    await expect(provider.embed("unknown kind", {
      purpose: "index-build",
      kind: "bogus",
      identityFingerprint: DOCUMENT_OPTIONS.identityFingerprint,
    } as never)).rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("sends the canonical request and restores response index order", async () => {
    const requests: Array<{ authorization?: string; body: unknown }> = [];
    const first = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, (_, index) => index / 10_000);
    const second = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, (_, index) => -(index + 1) / 10_000);
    const server = createServer(async (request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        body: await readJson(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [
          { object: "embedding", index: 1, embedding: second },
          { object: "embedding", index: 0, embedding: first },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }));
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      baseUrl: await listen(server),
      maxAttempts: 1,
    });

    const result = await provider.embedBatch(["first", "second"], DOCUMENT_OPTIONS);

    expect(requests).toEqual([{
      authorization: "Bearer sk-test-secret-sentinel",
      body: {
        input: ["first", "second"],
        model: OPENAI_EMBEDDING_MODEL,
        dimensions: OPENAI_EMBEDDING_DIMENSION,
        encoding_format: "float",
      },
    }]);
    expect(result.map(item => item.vector)).toEqual([first, second]);
    expect(result.map(item => item.dimension)).toEqual([
      OPENAI_EMBEDDING_DIMENSION,
      OPENAI_EMBEDDING_DIMENSION,
    ]);
    expect(result.map(item => item.usage)).toEqual([
      { promptTokens: 4, totalTokens: 4 },
      { promptTokens: 4, totalTokens: 4 },
    ]);
    await provider.close();
  });

  test("preserves the configured large-model identity and dimension", async () => {
    const model = "text-embedding-3-large" as const;
    const dimension = 3072;
    const vector = Array.from({ length: dimension }, () => 0.25);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      object: "list",
      model,
      data: [{ object: "embedding", index: 0, embedding: vector }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      model,
      dimension,
      fetch,
      maxAttempts: 1,
    });

    await expect(provider.embed("large model", DOCUMENT_OPTIONS)).resolves.toMatchObject({
      model,
      dimension,
      vector,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model,
      dimensions: dimension,
    });
    await provider.close();
  });

  test("normalizes OPENAI_BASE_URL, preserves explicit base URL precedence, and defaults when blank", async () => {
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      object: "list",
      model: OPENAI_EMBEDDING_MODEL,
      data: [{
        object: "embedding",
        index: 0,
        embedding: Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25),
      }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    process.env.OPENAI_BASE_URL = "  https://proxy.example.test/v1/  ";

    try {
      const provider = new OpenAIEmbeddingProvider({ apiKey: "«redacted:sk-…»", fetch, maxAttempts: 1 });
      await provider.embed("proxy routing", DOCUMENT_OPTIONS);
      await provider.close();

      const explicitProvider = new OpenAIEmbeddingProvider({
        apiKey: "«redacted:sk-…»",
        baseUrl: "https://explicit.example.test/v1/",
        fetch,
        maxAttempts: 1,
      });
      await explicitProvider.embed("explicit routing", DOCUMENT_OPTIONS);
      await explicitProvider.close();

      process.env.OPENAI_BASE_URL = "   ";
      const defaultProvider = new OpenAIEmbeddingProvider({ apiKey: "«redacted:sk-…»", fetch, maxAttempts: 1 });
      await defaultProvider.embed("default routing", DOCUMENT_OPTIONS);
      await defaultProvider.close();

      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        "https://proxy.example.test/v1/embeddings",
        "https://explicit.example.test/v1/embeddings",
        "https://api.openai.com/v1/embeddings",
      ]);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });

  test("rejects input budget violations before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch,
      maxAttempts: 1,
    });
    const cases: string[][] = [
      [],
      [""],
      Array.from({ length: 129 }, () => "x"),
      ["x".repeat(8_193)],
      ["台".repeat(2_731)],
      Array.from({ length: 128 }, () => "x".repeat(2_344)),
    ];

    for (const input of cases) {
      await expect(provider.embedBatch(input, DOCUMENT_OPTIONS)).rejects.toMatchObject({
        name: "EmbeddingProviderError",
        code: "INPUT_BUDGET_EXCEEDED",
      });
    }
    expect(provider.estimateTokens("台灣")).toBe(6);
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("accepts the exact per-input and aggregate UTF-8 budget boundaries", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const requestSizes: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      requestSizes.push(input.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: input.map((_value, index) => ({ object: "embedding", index, embedding: vector })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      } as unknown as Response;
    });
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 1 });

    await expect(provider.embed("x".repeat(8_192), DOCUMENT_OPTIONS)).resolves.toBeDefined();
    await expect(provider.embedBatch(
      Array.from({ length: 120 }, () => "x".repeat(2_500)),
      DOCUMENT_OPTIONS,
    )).resolves.toHaveLength(120);
    await expect(provider.embedBatch(
      Array.from({ length: 128 }, () => "x"),
      DOCUMENT_OPTIONS,
    )).resolves.toHaveLength(128);
    expect(requestSizes).toEqual([8_192, 300_000, 128]);
    await provider.close();
  });

  test("rejects runtime non-string inputs before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 1 });

    await expect(provider.embedBatch([null] as unknown as string[], DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "INPUT_BUDGET_EXCEEDED",
    });
    await expect(provider.embedBatch([{}] as unknown as string[], DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "INPUT_BUDGET_EXCEEDED",
    });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("retries transient responses within budget and honors Retry-After", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { "retry-after": "0.25" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const sleep = vi.fn(async (_delayMs: number) => {});
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch,
      maxAttempts: 3,
      sleep,
      random: () => 0,
      baseRetryDelayMs: 100,
    });

    await expect(provider.embed("retry me", DOCUMENT_OPTIONS)).resolves.toMatchObject({ vector });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]![0]).toBe(250);
    await provider.close();
  });

  test("cancels an unread non-success response body before retrying", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      body: { cancel },
    } as unknown as Response);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
    });

    await expect(provider.embed("unread body", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RETRY_EXHAUSTED",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("parses Retry-After variants and caps retry delays", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const now = 1_000;
    const cases = [
      { header: "2", expectedDelay: 2_000 },
      { header: new Date(6_000).toUTCString(), expectedDelay: 5_000 },
      { header: new Date(0).toUTCString(), expectedDelay: 0 },
      { header: "invalid", expectedDelay: 50 },
      { header: "10", expectedDelay: 5_000 },
    ];

    for (const testCase of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, {
          status: 503,
          headers: { "retry-after": testCase.header },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: [{ object: "embedding", index: 0, embedding: vector }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }), { status: 200 }));
      const sleep = vi.fn(async (_delayMs: number) => {});
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "test-key",
        fetch,
        maxAttempts: 2,
        sleep,
        now: () => now,
        random: () => 0,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 5_000,
      });

      await provider.embed("retry", DOCUMENT_OPTIONS);
      expect(sleep).toHaveBeenCalledWith(testCase.expectedDelay, expect.any(AbortSignal));
      await provider.close();
    }
  });

  test("rejects a retry delay that would reach the operation deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 503, headers: { "retry-after": "1" } }),
    );
    const sleep = vi.fn(async () => {});
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep,
      now: () => 1_000,
    });

    await expect(provider.embed("retry", {
      ...DOCUMENT_OPTIONS,
      deadline: 1_500,
    })).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await provider.close();
  });

  test("chunks far-future deadline timers within the runtime delay limit", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      model: OPENAI_EMBEDDING_MODEL,
      data: [{ object: "embedding", index: 0, embedding: vector }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
      now: () => 0,
    });

    await provider.embed("far future", {
      ...DOCUMENT_OPTIONS,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const delays = timerSpy.mock.calls.map(([, delay]) => Number(delay));
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every(delay => delay <= 2_147_483_647)).toBe(true);
    timerSpy.mockRestore();
    await provider.close();
  });

  test("retries HTTP 408 within the attempt budget", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 408 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 2,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("retry 408", DOCUMENT_OPTIONS)).resolves.toMatchObject({ vector });
    expect(fetch).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  test("aborts and retries hung fetch attempts with the client timeout", async () => {
    let timeoutAborts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const safetyTimer = setTimeout(() => reject(new Error("test safety timeout")), 30);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(safetyTimer);
        timeoutAborts += 1;
        reject(new DOMException("timed out", "TimeoutError"));
      }, { once: true });
    }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      requestTimeoutMs: 5,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("timeout", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RETRY_EXHAUSTED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timeoutAborts).toBe(3);
    await provider.close();
  });

  test("applies the client timeout while consuming the response body", async () => {
    let timeoutAborts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise<never>((_resolve, reject) => {
        const safetyTimer = setTimeout(() => reject(new Error("test safety timeout")), 30);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(safetyTimer);
          timeoutAborts += 1;
          reject(new DOMException("timed out", "TimeoutError"));
        }, { once: true });
      }),
    } as unknown as Response));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      requestTimeoutMs: 5,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("timeout body", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RETRY_EXHAUSTED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timeoutAborts).toBe(3);
    await provider.close();
  });

  test("retries a response-body transport failure after successful headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"object\":\"list\","));
        controller.error(new TypeError("terminated"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("body transport", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RETRY_EXHAUSTED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    await provider.close();
  });

  test("does not retry response schema failures", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      model: OPENAI_EMBEDDING_MODEL,
      data: [
        { object: "embedding", index: 0, embedding: vector },
        { object: "embedding", index: 0, embedding: vector },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embedBatch(["first", "second"], DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RESPONSE_SCHEMA_INVALID",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("rejects impossible usage reconciliation and clears stale usage", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const valid = {
      object: "list",
      model: OPENAI_EMBEDDING_MODEL,
      data: [{ object: "embedding", index: 0, embedding: vector }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
    const invalid = {
      ...valid,
      usage: { prompt_tokens: 99, total_tokens: 1 },
    };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(valid), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(invalid), { status: 200 }));
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 1 });

    const successful = await provider.embed("x", DOCUMENT_OPTIONS);
    expect(successful.usage).toEqual({ promptTokens: 1, totalTokens: 1 });
    await expect(provider.embed("x", DOCUMENT_OPTIONS)).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(successful.usage).toEqual({ promptTokens: 1, totalTokens: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  test("rejects every invalid usage schema without retrying", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const invalidUsages: unknown[] = [
      undefined,
      {},
      { prompt_tokens: "1", total_tokens: 1 },
      { prompt_tokens: 1, total_tokens: 1.5 },
      { prompt_tokens: -1, total_tokens: 1 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { prompt_tokens: 1, total_tokens: 0 },
      { prompt_tokens: 2, total_tokens: 2 },
    ];

    for (const usage of invalidUsages) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage,
      }), { status: 200 }));
      const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 3 });

      await expect(provider.embed("x", DOCUMENT_OPTIONS)).rejects.toMatchObject({
        code: "PROVIDER_FAILURE",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      await provider.close();
    }
  });

  test("enforces an in-flight deadline and explicit abort without retrying", async () => {
    const hangingFetch = vi.fn<typeof globalThis.fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    }));
    const deadlineProvider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch: hangingFetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });
    await expect(deadlineProvider.embed("deadline", {
      ...DOCUMENT_OPTIONS,
      deadline: Date.now() + 10,
    })).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    await deadlineProvider.close();

    const controller = new AbortController();
    const abortProvider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch: hangingFetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });
    const operation = abortProvider.embed("abort", { ...DOCUMENT_OPTIONS, signal: controller.signal });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    await abortProvider.close();
  });

  test("does not retry when abort races with a transient response", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      return new Response(null, { status: 503 });
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("abort after headers", {
      ...DOCUMENT_OPTIONS,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("maps abort during response body parsing to the lifecycle error", async () => {
    const controller = new AbortController();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    } as unknown as Response;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 3 });

    await expect(provider.embed("abort body", {
      ...DOCUMENT_OPTIONS,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("maps deadline and close during response body parsing to lifecycle errors", async () => {
    const createHangingBody = () => {
      let markBodyStarted!: () => void;
      const bodyStarted = new Promise<void>(resolve => {
        markBodyStarted = resolve;
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => new Promise<never>((_resolve, reject) => {
          markBodyStarted();
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("interrupted", "AbortError"));
          }, { once: true });
        }),
      } as unknown as Response));
      return { fetch, bodyStarted };
    };

    const deadlineCase = createHangingBody();
    const deadlineProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch: deadlineCase.fetch,
      maxAttempts: 3,
      requestTimeoutMs: 1_000,
    });
    const deadlineOperation = deadlineProvider.embed("deadline body", {
      ...DOCUMENT_OPTIONS,
      deadline: Date.now() + 10,
    });
    await deadlineCase.bodyStarted;
    await expect(deadlineOperation).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(deadlineCase.fetch).toHaveBeenCalledTimes(1);
    await deadlineProvider.close();

    const closeCase = createHangingBody();
    const closeProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch: closeCase.fetch,
      maxAttempts: 3,
      requestTimeoutMs: 1_000,
    });
    const closeOutcome = closeProvider.embed("close body", DOCUMENT_OPTIONS)
      .then(() => "resolved", error => (error as { code?: string }).code);
    await closeCase.bodyStarted;
    await closeProvider.close();
    expect(await closeOutcome).toBe("PROVIDER_CLOSED");
    expect(closeCase.fetch).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent requests", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let active = 0;
    let maxActive = 0;
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      requestCount += 1;
      if (requestCount === 1) markFirstStarted();
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (requestCount === 1) await firstGate;
      active -= 1;
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch,
      maxAttempts: 1,
    });

    const first = provider.embed("first", DOCUMENT_OPTIONS);
    await firstStarted;
    const second = provider.embed("second", DOCUMENT_OPTIONS);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    await provider.close();
  });

  test("aborts a queued operation without waiting for the active request", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (fetch.mock.calls.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 1 });
    const controller = new AbortController();

    const first = provider.embed("first", DOCUMENT_OPTIONS);
    await firstStarted;
    const second = provider.embed("second", { ...DOCUMENT_OPTIONS, signal: controller.signal });
    const secondOutcome = second.then(() => "resolved", error => error?.code ?? "unknown");
    controller.abort();
    const outcomeWhileFirstIsActive = await Promise.race([
      secondOutcome,
      new Promise<string>(resolve => setTimeout(() => resolve("still-pending"), 20)),
    ]);

    releaseFirst();
    await Promise.all([first, secondOutcome]);
    expect(outcomeWhileFirstIsActive).toBe("OPERATION_ABORTED");
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("expires a queued operation at its deadline without waiting for the active request", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0.25) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch });

    const first = provider.embed("first", DOCUMENT_OPTIONS);
    const secondOutcome = provider.embed("second", {
      ...DOCUMENT_OPTIONS,
      deadline: Date.now() + 5,
    }).then(() => "resolved", error => (error as { code?: string }).code);
    const whileQueued = await Promise.race([
      secondOutcome,
      new Promise<string>(resolve => setTimeout(() => resolve("still-pending"), 50)),
    ]);

    releaseFirst();
    await first;
    await secondOutcome;
    expect(whileQueued).toBe("DEADLINE_EXCEEDED");
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("concurrent close calls drain active and queued operations without deadlock", async () => {
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => {
      markFetchStarted = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("closed", "AbortError"));
        }, { once: true });
      });
    });
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch });
    const activeOutcome = provider.embed("active", DOCUMENT_OPTIONS)
      .then(() => "resolved", error => (error as { code?: string }).code);
    const queuedOutcome = provider.embed("queued", DOCUMENT_OPTIONS)
      .then(() => "resolved", error => (error as { code?: string }).code);
    await fetchStarted;

    await Promise.all([provider.close(), provider.close()]);

    expect(await activeOutcome).toBe("PROVIDER_CLOSED");
    expect(await queuedOutcome).toBe("PROVIDER_CLOSED");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("serializes an immutable input snapshot after a queue wait", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const requestInputs: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      requestInputs.push(JSON.parse(String(init?.body)).input);
      if (fetch.mock.calls.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 1 });

    const first = provider.embed("first", DOCUMENT_OPTIONS);
    await firstStarted;
    const mutableInputs = ["x"];
    const second = provider.embedBatch(mutableInputs, DOCUMENT_OPTIONS);
    mutableInputs[0] = "x".repeat(8_193);
    releaseFirst();
    await Promise.all([first, second]);

    expect(requestInputs).toEqual([["first"], ["x"]]);
    await provider.close();
  });

  test("authorizes from an immutable operation-options snapshot after a queue wait", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (fetch.mock.calls.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      return new Response(JSON.stringify({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200 });
    });
    const authorizations: unknown[] = [];
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      authorizeRequest: request => { authorizations.push(request); },
    });
    const first = provider.embed("first", DOCUMENT_OPTIONS);
    await firstStarted;
    const lease = {
      fingerprint: "fingerprint",
      ownerId: "owner",
      generation: 1,
      leaseExpiresAt: 10_000,
      mode: "rebuild" as const,
    };
    const mutableOptions = {
      purpose: "index-build" as const,
      kind: "document" as const,
      buildLease: lease,
      identityFingerprint: "full-build-identity",
    };
    const second = provider.embed("second", mutableOptions);
    (mutableOptions as { purpose: string }).purpose = "query-embedding";
    (mutableOptions as { kind: string }).kind = "query";
    mutableOptions.identityFingerprint = "mutated-identity";
    lease.ownerId = "mutated-owner";
    releaseFirst();
    await Promise.all([first, second]);

    expect(authorizations[1]).toMatchObject({
      purpose: "index-build",
      kind: "document",
      fingerprint: "full-build-identity",
      buildLease: { ownerId: "owner", generation: 1 },
    });
    await provider.close();
  });

  test("returns a safe terminal error after network retry exhaustion", async () => {
    const secret = "sk-test-secret-sentinel";
    const native = Object.assign(new Error(`network failed ${secret}`), {
      cause: { authorization: `Bearer ${secret}` },
      input: "private document body",
      headers: { authorization: `Bearer ${secret}` },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(native);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: secret,
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
      random: () => 0,
    });

    const error = await provider.embed("private document body", DOCUMENT_OPTIONS).catch(value => value);
    expect(error).toMatchObject({ code: "RETRY_EXHAUSTED", cause: undefined });
    const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private document body");
    expect(fetch).toHaveBeenCalledTimes(3);
    await provider.close();
  });

  test("never inspects or retains hostile native error graphs", async () => {
    const secret = "nested-secret-value";
    let getterCalls = 0;
    const native = Object.assign(new Error(secret), {
      stack: `stack ${secret}`,
      headers: [{ authorization: secret }],
    }) as Error & { cause?: unknown; self?: unknown };
    native.cause = { body: secret, parent: native };
    native.self = native;
    Object.defineProperty(native, "input", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secret);
      },
    });
    Object.defineProperty(native, Symbol("secret"), { enumerable: true, value: secret });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(native);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 1,
    });

    const error = await provider.embed("private body", DOCUMENT_OPTIONS).catch(value => value);
    expect(error).toMatchObject({ code: "RETRY_EXHAUSTED", cause: undefined });
    expect(getterCalls).toBe(0);
    expect(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(secret);
    await provider.close();
  });

  test("does not split or fall back from a failed multi-input batch", async () => {
    const requestInputs: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      requestInputs.push((JSON.parse(String(init?.body)) as { input: unknown }).input);
      throw new Error("network unavailable");
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });
    const batch = ["first", "second", "third"];

    await expect(provider.embedBatch(batch, DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "RETRY_EXHAUSTED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requestInputs).toEqual([batch, batch, batch]);
    await provider.close();
  });

  test("rejects invalid top-level, data, item, and index schemas without retry", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const validItem = { object: "embedding", index: 0, embedding: vector };
    const cases: Array<{ body: unknown; code: string }> = [
      { body: null, code: "PROVIDER_FAILURE" },
      {
        body: { object: "wrong", model: OPENAI_EMBEDDING_MODEL, data: [], usage: {} },
        code: "PROVIDER_FAILURE",
      },
      {
        body: {
          object: "list", model: OPENAI_EMBEDDING_MODEL, data: {},
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
        code: "BATCH_CARDINALITY_MISMATCH",
      },
      {
        body: {
          object: "list", model: OPENAI_EMBEDDING_MODEL, data: [null],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
        code: "PROVIDER_FAILURE",
      },
      {
        body: {
          object: "list", model: OPENAI_EMBEDDING_MODEL,
          data: [{ ...validItem, object: "wrong" }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
        code: "PROVIDER_FAILURE",
      },
      {
        body: {
          object: "list", model: OPENAI_EMBEDDING_MODEL,
          data: [{ ...validItem, index: 0.5 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
        code: "PROVIDER_FAILURE",
      },
      {
        body: {
          object: "list", model: OPENAI_EMBEDDING_MODEL,
          data: [{ ...validItem, index: 1 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
        code: "PROVIDER_FAILURE",
      },
    ];

    for (const testCase of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
        JSON.stringify(testCase.body),
        { status: 200 },
      ));
      const provider = new OpenAIEmbeddingProvider({ apiKey: "test-key", fetch, maxAttempts: 3 });
      await expect(provider.embed("x", DOCUMENT_OPTIONS)).rejects.toMatchObject({
        code: testCase.code,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      await provider.close();
    }
  });

  test("rejects partial, non-finite, wrong-dimension, and wrong-model responses without retry", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    const responseCases: Array<{ body: unknown; code: string }> = [
      {
        body: {
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: [{ object: "embedding", index: 0, embedding: vector }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
        code: "BATCH_CARDINALITY_MISMATCH",
      },
      {
        body: {
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: [
            { object: "embedding", index: 0, embedding: [null, ...vector.slice(1)] },
            { object: "embedding", index: 1, embedding: vector },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
        code: "DIMENSION_MISMATCH",
      },
      {
        body: {
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: [
            { object: "embedding", index: 0, embedding: [Number.MAX_VALUE, ...vector.slice(1)] },
            { object: "embedding", index: 1, embedding: vector },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
        code: "DIMENSION_MISMATCH",
      },
      {
        body: {
          object: "list",
          model: OPENAI_EMBEDDING_MODEL,
          data: [
            { object: "embedding", index: 0, embedding: vector.slice(1) },
            { object: "embedding", index: 1, embedding: vector },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
        code: "DIMENSION_MISMATCH",
      },
      {
        body: {
          object: "list",
          model: "unexpected-model",
          data: [
            { object: "embedding", index: 0, embedding: vector },
            { object: "embedding", index: 1, embedding: vector },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
        code: "PROVIDER_FAILURE",
      },
    ];

    for (const testCase of responseCases) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
        JSON.stringify(testCase.body),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test-secret-sentinel",
        fetch,
        maxAttempts: 3,
        sleep: vi.fn(async () => {}),
      });
      await expect(provider.embedBatch(["first", "second"], DOCUMENT_OPTIONS)).rejects.toMatchObject({
        code: testCase.code,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      await provider.close();
    }

    const badRequestFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 400 }),
    );
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch: badRequestFetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });
    await expect(provider.embed("bad request", DOCUMENT_OPTIONS)).rejects.toMatchObject({ code: "HTTP_TERMINAL" });
    expect(badRequestFetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("rejects a mocked NaN vector component before returning it", async () => {
    const vector = Array.from({ length: OPENAI_EMBEDDING_DIMENSION }, () => 0.25);
    vector[0] = NaN;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      json: async () => ({
        object: "list",
        model: OPENAI_EMBEDDING_MODEL,
        data: [{ object: "embedding", index: 0, embedding: vector }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    } as unknown as Response);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      fetch,
      maxAttempts: 3,
      sleep: vi.fn(async () => {}),
    });

    await expect(provider.embed("NaN", DOCUMENT_OPTIONS)).rejects.toMatchObject({
      code: "DIMENSION_MISMATCH",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  test("close aborts an in-flight retry delay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>(resolve => { markSleepStarted = resolve; });
    const sleep = vi.fn((_: number, signal?: AbortSignal) => {
      markSleepStarted();
      if (!signal) return Promise.reject(new Error("missing retry abort signal"));
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test-secret-sentinel",
      fetch,
      maxAttempts: 3,
      sleep,
    });

    const operation = provider.embed("close during retry", DOCUMENT_OPTIONS);
    await sleepStarted;
    await provider.close();
    await expect(operation).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
