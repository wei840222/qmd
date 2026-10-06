import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  VoyageEmbeddingProvider as RuntimeVoyageEmbeddingProvider,
  UnavailableVoyageEmbeddingProvider,
  canonicalVoyageEmbeddingIdentityMaterial,
  getMaxInputTokenLimit,
  supportsOutputDimension,
  type VoyageEmbeddingProviderOptions,
} from "../src/embedding/voyage.js";
import {
  DEFAULT_VOYAGE_BASE_URL,
  isCustomVoyageEndpoint,
  resolveEmbeddingConfig,
  resolveEmbeddingModelOverride,
  resolveVoyageApiKey,
} from "../src/embedding/config.js";

const servers: Server[] = [];
const DOCUMENT_OPTIONS = {
  purpose: "index-build",
  kind: "document",
  identityFingerprint: "full-build-identity",
} as const;
const QUERY_OPTIONS = {
  purpose: "query-embedding",
  kind: "query",
  identityFingerprint: "full-build-identity",
} as const;
const ALLOW_REMOTE_REQUEST = () => {};

class VoyageEmbeddingProvider extends RuntimeVoyageEmbeddingProvider {
  constructor(options: VoyageEmbeddingProviderOptions) {
    super({ authorizeRequest: ALLOW_REMOTE_REQUEST, ...options });
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
});

describe("canonicalVoyageEmbeddingIdentityMaterial", () => {
  test("generates identity material for default voyage-4 model", () => {
    const material = canonicalVoyageEmbeddingIdentityMaterial();
    const parsed = JSON.parse(material);
    expect(parsed.provider).toBe("voyageai");
    expect(parsed.model).toBe("voyage-4");
    expect(parsed.dimension).toBe(1024);
    expect(parsed.format).toBe("qmd-voyage-embedding-v1");
    expect(parsed.endpointFingerprint).toBeUndefined();
  });

  test("resolves known dimension for voyage-3.5-lite", () => {
    const material = canonicalVoyageEmbeddingIdentityMaterial("voyage-3.5-lite");
    const parsed = JSON.parse(material);
    expect(parsed.provider).toBe("voyageai");
    expect(parsed.model).toBe("voyage-3.5-lite");
    expect(parsed.dimension).toBe(512);
  });

  test("includes endpoint fingerprint for custom base URL", () => {
    const material = canonicalVoyageEmbeddingIdentityMaterial("voyage-4", 1024, "https://my-proxy.com/v1");
    const parsed = JSON.parse(material);
    expect(parsed.provider).toBe("voyageai");
    expect(parsed.endpointFingerprint).toBeDefined();
  });
});

describe("UnavailableVoyageEmbeddingProvider", () => {
  test("fails closed with provider failure message and default reason", async () => {
    const provider = new UnavailableVoyageEmbeddingProvider();
    expect(provider.providerId).toBe("voyageai");
    await expect(provider.embed("hello", DOCUMENT_OPTIONS as any)).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
      message: expect.stringContaining("missing VOYAGE_API_KEY or embed_api_key configuration"),
    });
  });

  test("reports custom reason when configured", async () => {
    const provider = new UnavailableVoyageEmbeddingProvider({ reason: "custom test reason" });
    await expect(provider.embed("hello", DOCUMENT_OPTIONS as any)).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
      message: expect.stringContaining("custom test reason"),
    });
  });
});

describe("VoyageEmbeddingProvider", () => {
  test("formats Voyage AI requests with output_dimension and input_type, and parses response without prompt_tokens", async () => {
    let capturedBody: any;
    let capturedHeaders: any;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          object: "embedding",
          index: 0,
          embedding: new Array(1024).fill(0.42),
        }],
        model: "voyage-4",
        usage: {
          total_tokens: 8,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "pa-voyage-secret",
      baseUrl: "https://api.voyageai.com/v1",
      model: "voyage-4",
      dimension: 1024,
      fetch,
      maxAttempts: 1,
    });

    const result = await provider.embed("hello voyage", DOCUMENT_OPTIONS);
    expect(result.dimension).toBe(1024);
    expect(result.vector[0]).toBeCloseTo(0.42);
    expect(result.usage?.totalTokens).toBe(8);
    expect(result.usage?.promptTokens).toBe(8);
    expect(capturedHeaders.authorization).toBe("Bearer pa-voyage-secret");
    expect(capturedBody).toEqual({
      input: ["hello voyage"],
      model: "voyage-4",
      output_dimension: 1024,
      input_type: "document",
    });
    // Strict Voyage payload assertions:
    expect(capturedBody.dimensions).toBeUndefined();
    expect(capturedBody.encoding_format).toBeUndefined();
    await provider.close();
  });

  test("sends input_type: query when kind is query", async () => {
    let capturedBody: any;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          object: "embedding",
          index: 0,
          embedding: new Array(1024).fill(0.1),
        }],
        model: "voyage-4",
        usage: { total_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "pa-voyage-secret",
      fetch,
      maxAttempts: 1,
    });

    await provider.embed("search term", QUERY_OPTIONS);
    expect(capturedBody.input_type).toBe("query");
    await provider.close();
  });

  test("requires active identity fingerprint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new RuntimeVoyageEmbeddingProvider({
      apiKey: "test",
      fetch,
      maxAttempts: 1,
    });

    await expect(provider.embed("test", { purpose: "query-embedding", kind: "query" } as any))
      .rejects.toMatchObject({ code: "IDENTITY_FINGERPRINT_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled();
    await provider.close();
  });

  test("omits output_dimension for older models like voyage-2 to prevent HTTP 400", async () => {
    let capturedBody: any;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          object: "embedding",
          index: 0,
          embedding: new Array(1024).fill(0.2),
        }],
        model: "voyage-2",
        usage: { total_tokens: 4 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: "pa-voyage-secret",
      model: "voyage-2",
      dimension: 1024,
      fetch,
      maxAttempts: 1,
    });

    await provider.embed("older model test", DOCUMENT_OPTIONS);
    expect(capturedBody.model).toBe("voyage-2");
    expect(capturedBody.output_dimension).toBeUndefined();
    expect(capturedBody.input_type).toBe("document");
    await provider.close();
  });

  test("refuses to send OPENAI_API_KEY to official Voyage API endpoint preventing credential leak", async () => {
    const originalEnv = { ...process.env };
    try {
      delete process.env.VOYAGE_API_KEY;
      process.env.OPENAI_API_KEY = "sk-secret-openai-key-do-not-leak";

      const fetch = vi.fn<typeof globalThis.fetch>();
      const provider = new VoyageEmbeddingProvider({
        baseUrl: "https://api.voyageai.com/v1",
        fetch,
        maxAttempts: 1,
      });

      // Calling embed without a Voyage key on official endpoint fails fast before network request
      await expect(provider.embed("test", DOCUMENT_OPTIONS)).rejects.toMatchObject({
        code: "PROVIDER_FAILURE",
        message: expect.stringContaining("requires VOYAGE_API_KEY or embed_api_key for the official Voyage API endpoint"),
      });

      expect(fetch).not.toHaveBeenCalled();
      await provider.close();
    } finally {
      process.env = originalEnv;
    }
  });
});

describe("resolveEmbeddingConfig with voyageai", () => {
  test("resolves voyageai provider from models config with voyage model", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_api_url: "https://bifrost.home-infra.weii.cloud/openai/v1",
          embed_api_model: "voyage-4",
        },
      },
      defaultLocalModel: "default-local",
      env: { VOYAGE_API_KEY: "vy-key" },
    });

    expect(resolved.canonical.provider).toBe("voyageai");
    expect(resolved.canonical.model).toBe("voyage-4");
    expect(resolved.canonical.dimension).toBe(1024);
    expect((resolved.canonical as any).baseUrl).toBe("https://bifrost.home-infra.weii.cloud/openai/v1");
    expect(resolved.credentialAvailable).toBe(true);
    expect(resolved.remoteRequestsEnabled).toBe(true);
  });

  test("resolves explicit embed_provider: voyageai", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_provider: "voyageai",
          embed_api_url: "https://custom-gateway.local/v1",
          embed_api_model: "custom-voyage",
          embed_dimension: 1024,
        },
      },
      defaultLocalModel: "default-local",
      env: {},
    });

    expect(resolved.canonical.provider).toBe("voyageai");
    expect(resolved.canonical.model).toBe("custom-voyage");
    expect(resolved.canonical.dimension).toBe(1024);
  });

  test("enforces model override matching voyage canonical model", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_provider: "voyageai",
          embed_api_url: "https://api.voyageai.com/v1",
          embed_api_model: "voyage-4",
        },
      },
      defaultLocalModel: "default-local",
      env: { VOYAGE_API_KEY: "key" },
    });

    expect(resolveEmbeddingModelOverride(resolved, undefined)).toBe("voyage-4");
    expect(resolveEmbeddingModelOverride(resolved, "voyage-4")).toBe("voyage-4");
    expect(() => resolveEmbeddingModelOverride(resolved, "other-model")).toThrow(
      "Voyage AI embedding model override must be voyage-4",
    );
  });

  test("auto-detects voyageai from EMBEDDING_MODEL environment variable when only embed_api_url is given", () => {
    const resolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_api_url: "https://bifrost.home-infra.weii.cloud/openai/v1",
        },
      },
      defaultLocalModel: "default-local",
      env: {
        EMBEDDING_MODEL: "voyage-4",
        VOYAGE_API_KEY: "test-key",
      },
    });

    expect(resolved.canonical.provider).toBe("voyageai");
    expect(resolved.canonical.model).toBe("voyage-4");
    expect(resolved.canonical.dimension).toBe(1024);
  });

  test("auto-detects openai vs voyageai without embed_provider based on model name", () => {
    const voyageResolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_api_url: "https://any-proxy.domain/v1",
          embed_api_model: "voyage-3.5",
        },
      },
      defaultLocalModel: "default-local",
      env: { VOYAGE_API_KEY: "test-key" },
    });
    expect(voyageResolved.canonical.provider).toBe("voyageai");
    expect(voyageResolved.canonical.dimension).toBe(1024);

    const openaiResolved = resolveEmbeddingConfig({
      config: {
        models: {
          embed_api_url: "https://any-proxy.domain/v1",
          embed_api_model: "text-embedding-3-large",
        },
      },
      defaultLocalModel: "default-local",
      env: { OPENAI_API_KEY: "test-key" },
    });
    expect(openaiResolved.canonical.provider).toBe("openai");
    expect(openaiResolved.canonical.dimension).toBe(3072);
  });

  test("getMaxInputTokenLimit returns appropriate limits per model family", () => {
    expect(getMaxInputTokenLimit("voyage-2")).toBe(4_000);
    expect(getMaxInputTokenLimit("voyage-law-2")).toBe(16_000);
    expect(getMaxInputTokenLimit("voyage-multilingual-2")).toBe(16_000);
    expect(getMaxInputTokenLimit("voyage-3")).toBe(32_000);
    expect(getMaxInputTokenLimit("voyage-4")).toBe(32_000);
    expect(getMaxInputTokenLimit("custom-model")).toBe(32_000);
  });

  test("supportsOutputDimension accurately identifies version 2 vs version 3+ models", () => {
    expect(supportsOutputDimension("voyage-2")).toBe(false);
    expect(supportsOutputDimension("voyage-law-2")).toBe(false);
    expect(supportsOutputDimension("voyage-code-2")).toBe(false);
    expect(supportsOutputDimension("voyage-3")).toBe(true);
    expect(supportsOutputDimension("voyage-3.5")).toBe(true);
    expect(supportsOutputDimension("voyage-4")).toBe(true);
  });

  test("credential leak prevention: resolveVoyageApiKey rejects OPENAI_API_KEY for default endpoint", () => {
    const defaultEnv = { OPENAI_API_KEY: "sk-openai-key" };
    expect(resolveVoyageApiKey({
      baseUrl: DEFAULT_VOYAGE_BASE_URL,
      env: defaultEnv,
    })).toBeUndefined();

    // But custom proxy endpoints DO allow OPENAI_API_KEY
    expect(resolveVoyageApiKey({
      baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
      env: defaultEnv,
    })).toBe("sk-openai-key");

    // VOYAGE_API_KEY is always respected
    expect(resolveVoyageApiKey({
      baseUrl: DEFAULT_VOYAGE_BASE_URL,
      env: { ...defaultEnv, VOYAGE_API_KEY: "pa-voyage-key" },
    })).toBe("pa-voyage-key");
  });

  test("resolveEmbeddingConfig disables remote requests when only OPENAI_API_KEY exists for official Voyage endpoint", () => {
    const config = resolveEmbeddingConfig({
      config: {
        models: {
          embed_provider: "voyageai",
          embed_api_model: "voyage-4",
        },
      },
      defaultLocalModel: "default-local",
      env: { OPENAI_API_KEY: "sk-openai-only" },
    });

    expect(config.canonical.provider).toBe("voyageai");
    expect(config.credentialAvailable).toBe(false);
    expect(config.remoteRequestsEnabled).toBe(false);
  });
});

