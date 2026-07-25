import type { Database } from "../db.js";

export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const OPENAI_EMBEDDING_DIMENSION = 1536 as const;
export const EMBEDDING_CONFIG_DB_KEY = "embedding_config" as const;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1" as const;

/** Supported OpenAI embedding models and their native dimensions. */
export const OPENAI_EMBEDDING_MODELS: ReadonlyMap<string, number> = new Map([
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
]);

export type OpenAIEmbeddingModel = "text-embedding-3-small" | "text-embedding-3-large";

export type EmbeddingProviderName = "local" | "openai";

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

  // Infer provider: "openai" if provider is omitted but baseUrl is present
  const provider = rawProvider ?? (rawBaseUrl ? "openai" : "local");

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

  if (provider === "openai") {
    const model = hasOwn(value, "model")
      ? requireModel(value.model, `${label}.model`)
      : OPENAI_EMBEDDING_MODEL;
    if (model !== OPENAI_EMBEDDING_MODEL) {
      throw new EmbeddingConfigError(
        `${label}.model must be ${OPENAI_EMBEDDING_MODEL}.`,
      );
    }
    const expectedDimension = OPENAI_EMBEDDING_MODELS.get(model)!;

    const dimension = hasOwn(value, "dimension")
      ? parseDimension(value.dimension, `${label}.dimension`)
      : expectedDimension;
    if (dimension !== expectedDimension) {
      throw new EmbeddingConfigError(
        `${label}.dimension must be ${expectedDimension} for model ${model}.`,
      );
    }

    const baseUrl = rawBaseUrl
      ? requireBaseUrl(rawBaseUrl, `${label}.baseUrl`)
      : DEFAULT_OPENAI_BASE_URL;

    return Object.freeze({
      provider: "openai",
      model: model as OpenAIEmbeddingModel,
      dimension: expectedDimension,
      baseUrl,
    });
  }

  throw new EmbeddingConfigError(`${label}.provider must be local or openai.`);
}

function resolveSource(
  options: ResolveEmbeddingConfigOptions,
): { canonical: CanonicalEmbeddingConfig; source: EmbeddingConfigSource } {
  const defaultLocalModel = requireModel(options.defaultLocalModel, "default local embedding model");

  if (options.config !== undefined) {
    const config = requireRecord(options.config, "embedding config source");
    if (hasOwn(config, "embedding")) {
      return {
        canonical: parseEmbeddingBlock(
          config.embedding,
          defaultLocalModel,
          "embedding config",
          false,
        ),
        source: "embedding-block",
      };
    }
    if (hasOwn(config, "models")) {
      const models = requireRecord(config.models, "models");
      const hasEmbed = hasOwn(models, "embed");
      const rawEmbedBaseUrl = models.embed_url ?? models.embed_base_url ?? models.embed_api_url;
      const hasEmbedBaseUrl = rawEmbedBaseUrl !== undefined && String(rawEmbedBaseUrl).trim() !== "";
      const customDimension = hasOwn(models, "embed_dimension")
        ? parseDimension(models.embed_dimension, "models.embed_dimension")
        : undefined;

      if (hasEmbed || hasEmbedBaseUrl || customDimension !== undefined) {
        const baseUrl = hasEmbedBaseUrl
          ? requireBaseUrl(rawEmbedBaseUrl, "models.embed_base_url")
          : DEFAULT_OPENAI_BASE_URL;

        if (hasEmbed) {
          const embedValue = requireModel(models.embed, "models.embed");
          if (embedValue.startsWith("openai:") || hasEmbedBaseUrl) {
            const rawModel = embedValue.startsWith("openai:")
              ? embedValue.slice("openai:".length)
              : embedValue === "openai" ? OPENAI_EMBEDDING_MODEL : embedValue;
            const model = rawModel || OPENAI_EMBEDDING_MODEL;
            const expectedDimension = OPENAI_EMBEDDING_MODELS.get(model);
            if (expectedDimension === undefined && embedValue.startsWith("openai:")) {
              const supported = Array.from(OPENAI_EMBEDDING_MODELS.keys()).join(", ");
              throw new EmbeddingConfigError(
                `models.embed OpenAI model must be one of: ${supported}. Got: ${model}`,
              );
            }
            const dimension = customDimension ?? expectedDimension ?? OPENAI_EMBEDDING_DIMENSION;

            return {
              canonical: Object.freeze({
                provider: "openai",
                model: model as OpenAIEmbeddingModel,
                dimension,
                baseUrl,
              }),
              source: "legacy-models",
            };
          }
          return {
            canonical: Object.freeze({
              provider: "local",
              model: embedValue,
              dimension: customDimension ?? null,
            }),
            source: "legacy-models",
          };
        }

        // Only embed_base_url / embed_dimension is provided under models
        return {
          canonical: Object.freeze({
            provider: "openai",
            model: OPENAI_EMBEDDING_MODEL,
            dimension: customDimension ?? OPENAI_EMBEDDING_DIMENSION,
            baseUrl,
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

export function resolveEmbeddingConfig(
  options: ResolveEmbeddingConfigOptions,
): ResolvedEmbeddingConfig {
  const resolved = resolveSource(options);
  const env = options.env ?? process.env;
  const hasApiKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim() !== "";
  // For non-default endpoints (self-hosted / proxy), API key is optional
  const isNonDefaultEndpoint = resolved.canonical.provider === "openai"
    && resolved.canonical.baseUrl !== DEFAULT_OPENAI_BASE_URL;
  const credentialAvailable = resolved.canonical.provider === "local"
    || hasApiKey
    || isNonDefaultEndpoint;

  return Object.freeze({
    canonical: resolved.canonical,
    source: resolved.source,
    credentialAvailable,
    remoteRequestsEnabled: resolved.canonical.provider === "openai" && credentialAvailable,
  });
}

export function resolveEmbeddingModelOverride(
  resolved: ResolvedEmbeddingConfig,
  override: string | undefined,
): string {
  if (override === undefined) return resolved.canonical.model;
  const model = requireModel(override, "embedding model override");
  if (resolved.canonical.provider === "openai" && model !== resolved.canonical.model) {
    throw new EmbeddingConfigError(
      `OpenAI embedding model override must be ${resolved.canonical.model}.`,
    );
  }
  return model;
}

export function readCanonicalEmbeddingConfig(
  db: Database,
): CanonicalEmbeddingConfig | undefined {
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
  db.prepare(`
    INSERT INTO store_config(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(EMBEDDING_CONFIG_DB_KEY, JSON.stringify(canonical));
}
