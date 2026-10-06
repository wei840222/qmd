import type { Database } from "../db.js";

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const OPENAI_EMBEDDING_DIMENSION = 1536 as const;
export const EMBEDDING_CONFIG_DB_KEY = "embedding_config" as const;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1" as const;

/** Supported remote OpenAI embedding models and their default/native dimensions. */
export const OPENAI_EMBEDDING_MODELS: ReadonlyMap<string, number> = new Map([
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
]);

export const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1" as const;
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4" as const;
export const DEFAULT_VOYAGE_EMBEDDING_DIMENSION = 1024 as const;

/** Supported Voyage AI embedding models and their default/native dimensions. */
export const VOYAGE_EMBEDDING_MODELS: ReadonlyMap<string, number> = new Map([
  ["voyage-4", 1024],
  ["voyage-4-large", 1024],
  ["voyage-4-lite", 1024],
  ["voyage-3.5", 1024],
  ["voyage-3.5-lite", 512],
  ["voyage-3", 1024],
  ["voyage-3-large", 1024],
  ["voyage-3-lite", 512],
  ["voyage-code-3", 1024],
  ["voyage-finance-2", 1024],
  ["voyage-law-2", 1024],
  ["voyage-multilingual-2", 1024],
  ["voyage-2", 1024],
]);

export type OpenAIEmbeddingModel = "text-embedding-3-small" | "text-embedding-3-large" | (string & {});
export type VoyageEmbeddingModel = "voyage-4" | "voyage-4-large" | (string & {});

export type EmbeddingProviderName = "local" | "openai" | "voyageai";

export type EmbeddingConfig =
  | {
      provider: "local";
      model?: string;
      dimension?: number;
    }
  | {
      provider: "openai";
      model?: OpenAIEmbeddingModel;
      dimension?: number;
      baseUrl?: string;
    }
  | {
      provider: "voyageai" | "voyage";
      model?: VoyageEmbeddingModel;
      dimension?: number;
      baseUrl?: string;
    };

export type CanonicalEmbeddingConfig = Readonly<
  | {
      provider: "local";
      model: string;
      dimension: number | null;
    }
  | {
      provider: "openai";
      model: OpenAIEmbeddingModel;
      dimension: number;
      baseUrl: string;
    }
  | {
      provider: "voyageai";
      model: VoyageEmbeddingModel;
      dimension: number;
      baseUrl: string;
    }
>;

export type EmbeddingConfigSource =
  | "embedding-block"
  | "legacy-models"
  | "database"
  | "local-default";

export interface ResolvedEmbeddingConfig {
  readonly canonical: CanonicalEmbeddingConfig;
  readonly source: EmbeddingConfigSource;
  readonly credentialAvailable: boolean;
  /** Remote transport is configured; consent and purpose guards still apply per request. */
  readonly remoteRequestsEnabled: boolean;
}

export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

export interface ResolveEmbeddingConfigOptions {
  /** Per-store SDK inline/configPath or CLI YAML snapshot. */
  config?: unknown;
  /** Canonical, non-secret configuration restored from SQLite. */
  dbConfig?: unknown;
  defaultLocalModel: string;
  env?: Readonly<Record<string, string | undefined>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new EmbeddingConfigError(`${label} must be an object.`);
  }
  return value;
}

function requireModel(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmbeddingConfigError(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseDimension(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new EmbeddingConfigError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function requireBaseUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmbeddingConfigError(`${label} must be a non-empty string.`);
  }
  return value.trim().replace(/\/+$/, "");
}

function assertKnownKeys(value: Record<string, unknown>, label: string): void {
  const allowed = new Set(["provider", "model", "dimension", "baseUrl"]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new EmbeddingConfigError(`${label} contains unsupported field ${unknown[0]}.`);
  }
}

export function inferRemoteProviderFromModel(
  model: string | undefined,
  baseUrl?: string,
): "voyageai" | "openai" {
  if (model) {
    const trimmed = model.trim().toLowerCase();
    if (
      trimmed.startsWith("voyage")
      || trimmed.includes("voyage-")
      || trimmed.includes("voyageai")
      || VOYAGE_EMBEDDING_MODELS.has(trimmed)
    ) {
      return "voyageai";
    }
    if (
      trimmed.startsWith("text-embedding")
      || trimmed.includes("openai")
      || OPENAI_EMBEDDING_MODELS.has(trimmed)
    ) {
      return "openai";
    }
  }
  if (baseUrl) {
    const lowerUrl = baseUrl.toLowerCase();
    if (lowerUrl.includes("voyage")) {
      return "voyageai";
    }
  }
  return "openai";
}

function parseEmbeddingBlock(
  input: unknown,
  defaultLocalModel: string,
  label: string,
  requireCanonicalValues: boolean,
): CanonicalEmbeddingConfig {
  const value = requireRecord(input, label);
  assertKnownKeys(value, label);

  const rawProvider = hasOwn(value, "provider") ? value.provider : undefined;
  const rawBaseUrl = hasOwn(value, "baseUrl") ? value.baseUrl : undefined;
  const rawModel = hasOwn(value, "model") ? String(value.model) : undefined;

  // Infer provider if omitted
  let provider = rawProvider;
  if (!provider) {
    if (rawBaseUrl) {
      provider = inferRemoteProviderFromModel(rawModel, String(rawBaseUrl));
    } else {
      provider = "local";
    }
  }

  if (provider === "local") {
    const model = hasOwn(value, "model")
      ? requireModel(value.model, `${label}.model`)
      : requireCanonicalValues
        ? requireModel(undefined, `${label}.model`)
        : defaultLocalModel;
    const dimension = hasOwn(value, "dimension")
      ? value.dimension === null && requireCanonicalValues
        ? null
        : parseDimension(value.dimension, `${label}.dimension`)
      : requireCanonicalValues
        ? null
        : null;
    return Object.freeze({ provider: "local", model, dimension });
  }

  if (provider === "voyageai" || provider === "voyage") {
    const model = hasOwn(value, "model")
      ? requireModel(value.model, `${label}.model`)
      : DEFAULT_VOYAGE_EMBEDDING_MODEL;
    const baseUrl = rawBaseUrl
      ? requireBaseUrl(rawBaseUrl, `${label}.baseUrl`)
      : DEFAULT_VOYAGE_BASE_URL;

    const knownDimension = VOYAGE_EMBEDDING_MODELS.get(model);
    let dimension: number;
    if (hasOwn(value, "dimension")) {
      dimension = parseDimension(value.dimension, `${label}.dimension`);
    } else if (knownDimension !== undefined) {
      dimension = knownDimension;
    } else {
      dimension = DEFAULT_VOYAGE_EMBEDDING_DIMENSION;
    }

    return Object.freeze({
      provider: "voyageai",
      model: model as VoyageEmbeddingModel,
      dimension,
      baseUrl,
    });
  }

  if (provider === "openai") {
    const model = hasOwn(value, "model")
      ? requireModel(value.model, `${label}.model`)
      : OPENAI_EMBEDDING_MODEL;
    const baseUrl = rawBaseUrl
      ? requireBaseUrl(rawBaseUrl, `${label}.baseUrl`)
      : DEFAULT_OPENAI_BASE_URL;

    if (baseUrl === DEFAULT_OPENAI_BASE_URL) {
      const expectedDimension = OPENAI_EMBEDDING_MODELS.get(model);
      if (expectedDimension === undefined || !model.startsWith("text-embedding-3")) {
        throw new EmbeddingConfigError(
          `${label}.model must be one of: text-embedding-3-small, text-embedding-3-large. Got: ${model}`,
        );
      }
      const dimension = hasOwn(value, "dimension")
        ? parseDimension(value.dimension, `${label}.dimension`)
        : expectedDimension;
      if (dimension !== expectedDimension) {
        throw new EmbeddingConfigError(
          `${label}.dimension must be ${expectedDimension} for model ${model}.`,
        );
      }
      return Object.freeze({
        provider: "openai",
        model: model as OpenAIEmbeddingModel,
        dimension: expectedDimension,
        baseUrl,
      });
    }

    // Custom or non-default endpoints (e.g. Bifrost proxy, self-hosted LLM)
    const knownDimension = OPENAI_EMBEDDING_MODELS.get(model);
    let dimension: number;
    if (hasOwn(value, "dimension")) {
      dimension = parseDimension(value.dimension, `${label}.dimension`);
    } else if (knownDimension !== undefined) {
      dimension = knownDimension;
    } else {
      throw new EmbeddingConfigError(
        `${label}.dimension must be specified for custom model ${model}.`,
      );
    }

    return Object.freeze({
      provider: "openai",
      model: model as OpenAIEmbeddingModel,
      dimension,
      baseUrl,
    });
  }

  throw new EmbeddingConfigError(`${label}.provider must be local, openai, or voyageai.`);
}

function resolveSource(
  options: ResolveEmbeddingConfigOptions,
): { canonical: CanonicalEmbeddingConfig; source: EmbeddingConfigSource } {
  const defaultLocalModel = requireModel(options.defaultLocalModel, "default local embedding model");

  if (options.config !== undefined) {
    const config = requireRecord(options.config, "embedding config source");
    if (hasOwn(config, "embedding")) {
      const canonical = parseEmbeddingBlock(
        config.embedding,
        defaultLocalModel,
        "embedding config",
        false,
      );
      if (canonical.provider === "openai" || canonical.provider === "voyageai") {
        throw new EmbeddingConfigError(
          "embedding config no longer selects remote embeddings; configure models.embed_api_url and models.embed_api_model instead.",
        );
      }
      return {
        canonical,
        source: "embedding-block",
      };
    }
    if (hasOwn(config, "models")) {
      const models = requireRecord(config.models, "models");
      const hasEmbed = hasOwn(models, "embed");
      const embedModel = hasEmbed ? requireModel(models.embed, "models.embed") : undefined;
      if (embedModel === "openai" || embedModel?.startsWith("openai:")) {
        throw new EmbeddingConfigError(
          "models.embed no longer accepts OpenAI shorthand; configure models.embed_api_url (or models.embed_url/models.embed_base_url) and models.embed_api_model instead.",
        );
      }
      const rawProvider = models.embed_provider ?? models.provider;
      const isExplicitVoyage = rawProvider === "voyageai" || rawProvider === "voyage";
      const rawEmbedBaseUrl = models.embed_url ?? models.embed_base_url ?? models.embed_api_url
        ?? (isExplicitVoyage ? DEFAULT_VOYAGE_BASE_URL : undefined);
      const hasEmbedBaseUrl = rawEmbedBaseUrl !== undefined && String(rawEmbedBaseUrl).trim() !== "";
      const customDimension = hasOwn(models, "embed_dimension")
        ? parseDimension(models.embed_dimension, "models.embed_dimension")
        : undefined;
      const env = options.env ?? process.env;
      const rawEnvModel = (typeof env.EMBEDDING_MODEL === "string" && env.EMBEDDING_MODEL.trim() !== "")
        ? env.EMBEDDING_MODEL.trim()
        : (typeof env.EMBED_API_MODEL === "string" && env.EMBED_API_MODEL.trim() !== "")
          ? env.EMBED_API_MODEL.trim()
          : undefined;

      const embedApiModel = hasOwn(models, "embed_api_model")
        ? requireModel(models.embed_api_model, "models.embed_api_model")
        : (hasEmbedBaseUrl && hasOwn(models, "embed_model")
            ? requireModel(models.embed_model, "models.embed_model")
            : (hasEmbedBaseUrl && hasOwn(models, "embed") && typeof models.embed === "string" && models.embed.trim() !== "" && !models.embed.startsWith("hf:") && !models.embed.startsWith("ollama:") && models.embed !== "default"
                ? models.embed.trim()
                : (isExplicitVoyage ? DEFAULT_VOYAGE_EMBEDDING_MODEL : rawEnvModel)));

      if (hasEmbedBaseUrl && embedApiModel !== undefined) {
        let provider: "voyageai" | "openai";
        if (rawProvider === "voyageai" || rawProvider === "voyage") {
          provider = "voyageai";
        } else if (rawProvider === "openai") {
          provider = "openai";
        } else {
          provider = inferRemoteProviderFromModel(embedApiModel, String(rawEmbedBaseUrl));
        }

        return {
          canonical: parseEmbeddingBlock({
            provider,
            model: embedApiModel,
            ...(customDimension === undefined ? {} : { dimension: customDimension }),
            baseUrl: requireBaseUrl(rawEmbedBaseUrl, "models.embed_api_url"),
          }, defaultLocalModel, "models", false),
          source: "legacy-models",
        };
      }

      if (hasEmbed || hasEmbedBaseUrl || embedApiModel !== undefined || customDimension !== undefined) {
        return {
          canonical: Object.freeze({
            provider: "local",
            model: embedModel ?? defaultLocalModel,
            dimension: customDimension ?? null,
          }),
          source: "legacy-models",
        };
      }
    }
  }

  if (options.dbConfig !== undefined) {
    return {
      canonical: parseEmbeddingBlock(
        options.dbConfig,
        defaultLocalModel,
        "database embedding config",
        true,
      ),
      source: "database",
    };
  }

  return {
    canonical: Object.freeze({
      provider: "local",
      model: defaultLocalModel,
      dimension: null,
    }),
    source: "local-default",
  };
}

export function isCustomVoyageEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return baseUrl.trim().replace(/\/+$/, "") !== DEFAULT_VOYAGE_BASE_URL;
}

export function resolveVoyageApiKey(options: {
  apiKey?: string;
  configApiKey?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = options.env ?? process.env;
  const directKey = options.apiKey?.trim() || options.configApiKey?.trim() || env.VOYAGE_API_KEY?.trim();
  if (directKey) return directKey;

  const baseUrl = options.baseUrl?.trim() || env.VOYAGE_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_VOYAGE_BASE_URL;
  if (isCustomVoyageEndpoint(baseUrl) && env.OPENAI_API_KEY?.trim()) {
    return env.OPENAI_API_KEY.trim();
  }
  return undefined;
}

export function resolveEmbeddingConfig(
  options: ResolveEmbeddingConfigOptions,
): ResolvedEmbeddingConfig {
  const resolved = resolveSource(options);
  const env = options.env ?? process.env;
  const isVoyage = resolved.canonical.provider === "voyageai";
  const isOpenAI = resolved.canonical.provider === "openai";
  const baseUrl = "baseUrl" in resolved.canonical ? resolved.canonical.baseUrl : undefined;
  const isCustomVoyage = isVoyage && isCustomVoyageEndpoint(baseUrl);
  const isCustomOpenAI = isOpenAI && baseUrl !== DEFAULT_OPENAI_BASE_URL;

  let configApiKey: string | undefined;
  if (isRecord(options.config) && isRecord(options.config.models)) {
    const rawKey = options.config.models.embed_api_key;
    if (typeof rawKey === "string") {
      configApiKey = rawKey;
    }
  }

  const hasApiKey = isVoyage
    ? Boolean(resolveVoyageApiKey({ configApiKey, baseUrl, env }))
    : Boolean(configApiKey?.trim() || env.OPENAI_API_KEY?.trim());

  // For non-default endpoints (self-hosted / proxy), API key is optional
  const isNonDefaultEndpoint = isCustomOpenAI || isCustomVoyage;
  const credentialAvailable = resolved.canonical.provider === "local"
    || hasApiKey
    || isNonDefaultEndpoint;

  return Object.freeze({
    canonical: resolved.canonical,
    source: resolved.source,
    credentialAvailable,
    remoteRequestsEnabled: (isOpenAI || isVoyage) && credentialAvailable,
  });
}

export function resolveEmbeddingModelOverride(
  resolved: ResolvedEmbeddingConfig,
  override: string | undefined,
): string {
  if (override === undefined) return resolved.canonical.model;
  const model = requireModel(override, "embedding model override");
  if ((resolved.canonical.provider === "openai" || resolved.canonical.provider === "voyageai") && model !== resolved.canonical.model) {
    throw new EmbeddingConfigError(
      `${resolved.canonical.provider === "voyageai" ? "Voyage AI" : "OpenAI"} embedding model override must be ${resolved.canonical.model}.`,
    );
  }
  return model;
}

export function readCanonicalEmbeddingConfig(
  db: Database,
): CanonicalEmbeddingConfig | undefined {
  try {
    const row = db.prepare(
      "SELECT value FROM store_config WHERE key = ?",
    ).get(EMBEDDING_CONFIG_DB_KEY) as { value?: unknown } | undefined;
    if (row?.value === undefined) return undefined;
    if (typeof row.value !== "string") {
      throw new EmbeddingConfigError("database embedding config must be stored as JSON text.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      throw new EmbeddingConfigError("database embedding config contains invalid JSON.");
    }
    return parseEmbeddingBlock(
      parsed,
      "unused-for-canonical-config",
      "database embedding config",
      true,
    );
  } catch (err) {
    if (err instanceof EmbeddingConfigError) throw err;
    return undefined;
  }
}

export function writeCanonicalEmbeddingConfig(
  db: Database,
  config: CanonicalEmbeddingConfig,
): void {
  const canonical = parseEmbeddingBlock(
    config,
    "unused-for-canonical-config",
    "canonical embedding config",
    true,
  );
  const newValue = JSON.stringify(canonical);
  const existing = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(EMBEDDING_CONFIG_DB_KEY) as { value: string } | undefined;
  if (existing?.value === newValue) return;

  db.prepare(`
    INSERT INTO store_config(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(EMBEDDING_CONFIG_DB_KEY, newValue);
}
