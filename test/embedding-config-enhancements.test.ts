import { describe, expect, test } from "vitest";
import { resolveEmbeddingConfig } from "../src/embedding/config.js";

describe("Embedding Config Enhancements", () => {
  const defaultLocalModel = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
  describe("remote embedding configuration", () => {
    test("uses the remote provider only when embed_api_url and embed_api_model are both configured", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed: defaultLocalModel,
            embed_api_url: "https://api.example.com/v1/",
            embed_api_model: "text-embedding-3-small",
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        baseUrl: "https://api.example.com/v1",
      });
      expect(resolved.source).toBe("legacy-models");
    });

    test.each(["embed_url", "embed_base_url"] as const)(
      "uses the remote provider when %s and embed_api_model are both configured",
      (urlKey) => {
        const resolved = resolveEmbeddingConfig({
          config: {
            models: {
              embed: defaultLocalModel,
              [urlKey]: "https://api.example.com/v1/",
              embed_api_model: "text-embedding-3-small",
            },
          },
          defaultLocalModel,
        });

        expect(resolved.canonical).toEqual({
          provider: "openai",
          model: "text-embedding-3-small",
          dimension: 1536,
          baseUrl: "https://api.example.com/v1",
        });
      },
    );

    test("keeps the configured local model when embed_api_url has no embed_api_model", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed: defaultLocalModel,
            embed_api_url: "https://api.example.com/openai/v1",
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "local",
        model: defaultLocalModel,
        dimension: null,
      });
      expect(resolved.credentialAvailable).toBe(true);
      expect(resolved.remoteRequestsEnabled).toBe(false);
    });

    test("keeps the configured local model when embed_api_model has no embed_api_url", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed: defaultLocalModel,
            embed_api_model: "text-embedding-3-small",
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "local",
        model: defaultLocalModel,
        dimension: null,
      });
      expect(resolved.credentialAvailable).toBe(true);
      expect(resolved.remoteRequestsEnabled).toBe(false);
    });

    test("keeps the default local provider when only embed_api_url is configured", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed_api_url: "https://api.example.com/v1",
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "local",
        model: defaultLocalModel,
        dimension: null,
      });
    });

    test("rejects the legacy embedding block as a remote provider selection path", () => {
      expect(() => resolveEmbeddingConfig({
        config: {
          embedding: { provider: "openai" },
        },
        defaultLocalModel,
      })).toThrowError(/models\.embed_api_url/);
    });

    test.each(["openai", "openai:text-embedding-3-small"])(
      "rejects the deprecated models.embed shorthand %s",
      (embed) => {
        expect(() => resolveEmbeddingConfig({
          config: { models: { embed } },
          defaultLocalModel,
        })).toThrowError(/models\.embed_api_url/);
      },
    );

    test("retains embed_dimension for local response validation without selecting a remote provider", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed: defaultLocalModel,
            embed_dimension: 1024,
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "local",
        model: defaultLocalModel,
        dimension: 1024,
      });
    });
  });

  describe("remote credentials", () => {
    test("allows a missing OPENAI_API_KEY for a configured custom endpoint", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: {
            embed_api_url: "https://api.example.com/v1",
            embed_api_model: "text-embedding-3-small",
          },
        },
        defaultLocalModel,
        env: {}, // No OPENAI_API_KEY
      });

      expect(resolved.credentialAvailable).toBe(true);
      expect(resolved.remoteRequestsEnabled).toBe(true);
    });
  });
});
