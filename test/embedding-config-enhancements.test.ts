import { describe, expect, test } from "vitest";
import {
  resolveEmbeddingConfig,
  EmbeddingConfigError,
  DEFAULT_OPENAI_BASE_URL,
} from "../src/embedding/config.js";

describe("Embedding Config Enhancements (TODO 2, 3, 4)", () => {
  const defaultLocalModel = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

  describe("TODO 2: models.embed shorthand syntax", () => {
    test("parses openai:text-embedding-3-small shorthand", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: { embed: "openai:text-embedding-3-small" },
        },
        defaultLocalModel,
        env: { OPENAI_API_KEY: "test-key" },
      });

      expect(resolved.canonical).toEqual({
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        baseUrl: DEFAULT_OPENAI_BASE_URL,
      });
      expect(resolved.source).toBe("legacy-models");
    });

    test("parses openai:text-embedding-3-large shorthand", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          models: { embed: "openai:text-embedding-3-large" },
        },
        defaultLocalModel,
        env: { OPENAI_API_KEY: "test-key" },
      });

      expect(resolved.canonical).toEqual({
        provider: "openai",
        model: "text-embedding-3-large",
        dimension: 3072,
        baseUrl: DEFAULT_OPENAI_BASE_URL,
      });
    });

    test("throws on invalid openai shorthand model", () => {
      expect(() =>
        resolveEmbeddingConfig({
          config: {
            models: { embed: "openai:non-existent-model" },
          },
          defaultLocalModel,
        }),
      ).toThrowError(EmbeddingConfigError);
    });
  });

  describe("TODO 3: embedding block baseUrl support", () => {
    test("parses custom baseUrl in embedding block", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            dimension: 1536,
            baseUrl: "https://bifrost.home-infra.weii.cloud/v1/",
          },
        },
        defaultLocalModel,
      });

      expect(resolved.canonical).toEqual({
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        baseUrl: "https://bifrost.home-infra.weii.cloud/v1",
      });
      expect(resolved.source).toBe("embedding-block");
    });
  });

  describe("TODO 4: optional OPENAI_API_KEY for custom endpoints", () => {
    test("allows missing OPENAI_API_KEY when custom baseUrl is specified", () => {
      const resolved = resolveEmbeddingConfig({
        config: {
          embedding: {
            provider: "openai",
            baseUrl: "https://bifrost.home-infra.weii.cloud/v1",
          },
        },
        defaultLocalModel,
        env: {}, // No OPENAI_API_KEY
      });

      expect(resolved.credentialAvailable).toBe(true);
      expect(resolved.remoteRequestsEnabled).toBe(true);
    });

    test("requires OPENAI_API_KEY when default OpenAI endpoint is used", () => {
      const resolvedWithoutKey = resolveEmbeddingConfig({
        config: {
          embedding: {
            provider: "openai",
          },
        },
        defaultLocalModel,
        env: {}, // No OPENAI_API_KEY
      });

      expect(resolvedWithoutKey.credentialAvailable).toBe(false);
      expect(resolvedWithoutKey.remoteRequestsEnabled).toBe(false);

      const resolvedWithKey = resolveEmbeddingConfig({
        config: {
          embedding: {
            provider: "openai",
          },
        },
        defaultLocalModel,
        env: { OPENAI_API_KEY: "sk-test" },
      });

      expect(resolvedWithKey.credentialAvailable).toBe(true);
      expect(resolvedWithKey.remoteRequestsEnabled).toBe(true);
    });
  });
});
