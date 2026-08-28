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
} from "./llm.js";
import type { RemoteLLM } from "./remote-llm.js";

export class HybridLLM implements LLM {
  constructor(
    private readonly localLLM: LLM,
    private readonly remoteLLM?: RemoteLLM,
  ) {}

  get supportsExpand(): boolean {
    return Boolean(this.remoteLLM?.supportsExpand);
  }

  get supportsRerank(): boolean {
    return Boolean(this.remoteLLM?.supportsRerank);
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.localLLM.embed(text, options);
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    return this.localLLM.generate(prompt, options);
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return this.localLLM.modelExists(model);
  }

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean; includeHyde?: boolean }): Promise<Queryable[]> {
    if (this.remoteLLM?.supportsExpand) {
      try {
        return await this.remoteLLM.expandQuery(query, options);
      } catch (err) {
        // Fallback to local LLM expansion on error
        console.warn("Remote query expansion failed, falling back to local model:", (err as Error).message);
      }
    }
    return this.localLLM.expandQuery(query, options);
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
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
    ]);
  }
}
