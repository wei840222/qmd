import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankOptions,
  RerankResult,
  SearchIntentGuidance,
} from "./llm.js";
import type { RemoteLLM } from "./remote-llm.js";
import type { RemoteJev } from "./remote-jev.js";

export class Hybrid implements LLM {
  constructor(
    private readonly localLLM: LLM,
    private readonly remoteLLM?: RemoteLLM,
    private readonly remoteJev?: RemoteJev,
  ) {}

  get jev(): RemoteJev | undefined {
    return this.remoteJev;
  }

  get remote(): RemoteLLM | undefined {
    return this.remoteLLM;
  }

  get local(): LLM {
    return this.localLLM;
  }

  get supportsExpand(): boolean {
    return Boolean(this.remoteJev?.supportsExpand || this.remoteLLM?.supportsExpand);
  }

  get supportsRerank(): boolean {
    return Boolean(this.remoteJev?.supportsRerank || this.remoteLLM?.supportsRerank);
  }

  get rerankModelName(): string | undefined {
    if (this.remoteJev?.supportsRerank) {
      return this.remoteJev.rerankModelName;
    }
    if (this.remoteLLM?.supportsRerank && this.remoteLLM.rerankModelName) {
      return this.remoteLLM.rerankModelName;
    }
    return (this.localLLM as any).rerankModelName;
  }

  get generateModelName(): string | undefined {
    if (this.remoteLLM?.supportsExpand && this.remoteLLM.generateModelName) {
      return this.remoteLLM.generateModelName;
    }
    return (this.localLLM as any).generateModelName;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.localLLM.embed(text, options);
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    return this.localLLM.generate(prompt, options);
  }

  async modelExists(model: string): Promise<ModelInfo> {
    if (this.remoteJev && (model.startsWith("jev:") || model === "jev")) {
      return { name: model, path: model, exists: true };
    }
    if (this.remoteLLM) {
      const remoteInfo = await this.remoteLLM.modelExists(model);
      if (remoteInfo.exists) return remoteInfo;
    }
    return this.localLLM.modelExists(model);
  }

  async expandQuery(
    query: string,
    options?: {
      context?: string;
      includeLexical?: boolean;
      includeHyde?: boolean;
      searchIntent?: SearchIntentGuidance;
    },
  ): Promise<Queryable[]> {
    let targetOptions = options;

    if (this.remoteJev?.supportsExpand) {
      try {
        const intent = await this.remoteJev.classifyIntent(query, { context: options?.context });
        if (intent.confidence >= 0.5) {
          targetOptions = {
            ...options,
            includeHyde: intent.needsHyde,
            searchIntent: intent.strategyDetails,
          };
        }
      } catch (err) {
        console.warn("Remote Jev query expansion classification failed, falling back to direct LLM expansion:", (err as Error).message);
      }
    }

    if (this.remoteLLM?.supportsExpand) {
      try {
        return await this.remoteLLM.expandQuery(query, targetOptions);
      } catch (err) {
        // Fallback to local LLM expansion on error
        console.warn("Remote query expansion failed, falling back to local model:", (err as Error).message);
      }
    }

    return this.localLLM.expandQuery(query, targetOptions);
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    if (this.remoteJev?.supportsRerank) {
      try {
        return await this.remoteJev.rerank(query, documents, options);
      } catch (err) {
        console.warn("Remote Jev rerank failed, falling back to remote/local LLM:", (err as Error).message);
      }
    }

    if (this.remoteLLM?.supportsRerank) {
      try {
        return await this.remoteLLM.rerank(query, documents, options);
      } catch (err) {
        // Fallback to local LLM reranking on error
        console.warn("Remote rerank failed, falling back to local model:", (err as Error).message);
      }
    }

    return this.localLLM.rerank(query, documents, options);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.localLLM.dispose(),
      this.remoteLLM?.dispose(),
      this.remoteJev?.dispose(),
    ]);
  }
}
