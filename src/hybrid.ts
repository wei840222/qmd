import {
  ModelConfigurationError,
  type LLM,
  type EmbedOptions,
  type EmbeddingResult,
  type GenerateOptions,
  type GenerateResult,
  type ModelInfo,
  type ModelResolutionConfig,
  type Queryable,
  type RerankDocument,
  type RerankOptions,
  type RerankResult,
  type SearchIntentGuidance,
} from "./llm.js";
import { RemoteLLM } from "./remote-llm.js";
import { RemoteJev } from "./remote-jev.js";

/** How long a failed rerank API is skipped while Jev can rerank in its place. */
export const DEFAULT_RERANK_COOLDOWN_MS = 60_000;

export interface HybridOptions {
  /** Cooldown after a rerank API failure when Jev is the fallback. 0 never skips the API. */
  rerankCooldownMs?: number;
}

/** Remote query services. Embeddings are owned by the store's authorized provider. */
export class Hybrid implements LLM {
  private remoteRerankSkippedUntil = 0;
  private readonly rerankCooldownMs: number;

  constructor(
    private readonly remoteLLM?: RemoteLLM,
    private readonly remoteJev?: RemoteJev,
    options: HybridOptions = {},
  ) {
    const rerankCooldownMs = options.rerankCooldownMs ?? DEFAULT_RERANK_COOLDOWN_MS;
    if (!Number.isFinite(rerankCooldownMs) || rerankCooldownMs < 0) {
      throw new Error("Rerank cooldown must not be negative.");
    }
    this.rerankCooldownMs = rerankCooldownMs;
  }
  get jev(): RemoteJev | undefined {
    return this.remoteJev;
  }
  get remote(): RemoteLLM | undefined {
    return this.remoteLLM;
  }
  get supportsExpand(): boolean {
    return Boolean(this.remoteLLM?.supportsExpand);
  }
  get supportsRerank(): boolean {
    return Boolean(
      this.remoteJev?.supportsRerank || this.remoteLLM?.supportsRerank,
    );
  }
  /**
   * The configured rerank API is skipped only while Jev can answer in its place.
   * Without a fallback there is nothing to save by skipping it, so every request
   * tries it and a recovered backend is used on the next request.
   */
  private get remoteRerankAvailable(): boolean {
    if (!this.remoteLLM?.supportsRerank) return false;
    return !(this.remoteJev?.supportsRerank && Date.now() < this.remoteRerankSkippedUntil);
  }
  get rerankModelName(): string | undefined {
    if (this.remoteRerankAvailable) return this.remoteLLM?.rerankModelName;
    return this.remoteJev?.rerankModelName ?? this.remoteLLM?.rerankModelName;
  }
  get generateModelName(): string | undefined {
    return this.remoteLLM?.generateModelName;
  }
  async embed(
    _text: string,
    _options?: EmbedOptions,
  ): Promise<EmbeddingResult | null> {
    throw new ModelConfigurationError(
      "Embedding through an authorized remote embedding provider",
    );
  }
  async generate(
    prompt: string,
    options?: GenerateOptions,
  ): Promise<GenerateResult | null> {
    if (!this.remoteLLM?.supportsExpand)
      throw new ModelConfigurationError("Generation");
    return this.remoteLLM.generate(prompt, options);
  }
  async modelExists(model: string): Promise<ModelInfo> {
    if (
      this.remoteJev &&
      (model === this.remoteJev.model ||
        model.startsWith("jev:") ||
        model === "jev")
    )
      return { name: model, exists: true };
    return this.remoteLLM?.modelExists(model) ?? { name: model, exists: false };
  }
  async expandQuery(
    query: string,
    options?: {
      context?: string;
      includeLexical?: boolean;
      includeHyde?: boolean;
      searchIntent?: SearchIntentGuidance;
      signal?: AbortSignal;
    },
  ): Promise<Queryable[]> {
    if (!this.remoteLLM?.supportsExpand)
      throw new ModelConfigurationError("Query expansion");
    let targetOptions = options;
    if (this.remoteJev?.supportsExpand) {
      try {
        const intent = await this.remoteJev.classifyIntent(query, {
          context: options?.context,
          signal: options?.signal,
        });
        if (intent.confidence >= 0.5)
          targetOptions = {
            ...options,
            includeHyde: intent.needsHyde,
            searchIntent: intent.strategyDetails,
          };
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        // A configured remote generator can still expand without intent guidance.
      }
    }
    return this.remoteLLM.expandQuery(query, targetOptions);
  }
  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    // An explicitly configured rerank API wins; Jev reranks only when none is
    // configured, or as a fallback when the configured API fails. After a failure
    // the API is skipped for a cooldown so an outage does not make every query
    // wait for the request timeout before Jev answers.
    if (this.remoteRerankAvailable) {
      try {
        return await this.remoteLLM!.rerank(query, documents, options);
      } catch (error) {
        if (options?.signal?.aborted || !this.remoteJev?.supportsRerank)
          throw error;
        this.remoteRerankSkippedUntil = Date.now() + this.rerankCooldownMs;
      }
    }
    if (this.remoteJev?.supportsRerank)
      return this.remoteJev.rerank(query, documents, options);
    throw new ModelConfigurationError("Reranking");
  }
  async dispose(): Promise<void> {
    await Promise.all([this.remoteLLM?.dispose(), this.remoteJev?.dispose()]);
  }
}

/** Shared SDK/CLI setup; constructing services never sends a model request. */
export function createConfiguredLLM(
  models?: ModelResolutionConfig,
  options: { timeoutMs?: number } = {},
): Hybrid {
  const remote = new RemoteLLM({
    generateUrl: models?.generate_url,
    generateBaseUrl: models?.generate_base_url,
    generateApiUrl: models?.generate_api_url,
    generateApiModel: models?.generate_api_model,
    generateApiKey: models?.generate_api_key,
    rerankUrl: models?.rerank_url,
    rerankBaseUrl: models?.rerank_base_url,
    rerankApiUrl: models?.rerank_api_url,
    rerankApiModel: models?.rerank_api_model,
    rerankApiKey: models?.rerank_api_key,
    timeoutMs: options.timeoutMs,
  });
  const apiKey =
    models?.jev_api_key?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  const jev = apiKey
    ? new RemoteJev({
        apiKey,
        baseUrl:
          models?.jev_base_url?.trim() || process.env.TYPESAFE_BASE_URL?.trim(),
        model:
          models?.jev_api_model?.trim() ||
          process.env.TYPESAFE_DEFAULT_MODEL?.trim(),
        timeoutMs: options.timeoutMs,
      })
    : undefined;
  return new Hybrid(remote, jev);
}
