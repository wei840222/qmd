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
  RerankDocumentResult,
} from "./llm.js";

export interface RemoteLLMOptions {
  expandApiUrl?: string;
  expandApiModel?: string;
  expandApiKey?: string;
  rerankApiUrl?: string;
  rerankApiModel?: string;
  rerankApiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function normalizeRerankScore(score: number): number {
  // If score is outside [0, 1], apply sigmoid normalization
  if (score < 0 || score > 1) {
    return sigmoid(score);
  }
  return score;
}

export class RemoteLLM implements LLM {
  private readonly expandApiUrl?: string;
  private readonly expandApiModel?: string;
  private readonly expandApiKey?: string;
  private readonly rerankApiUrl?: string;
  private readonly rerankApiModel?: string;
  private readonly rerankApiKey?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  private expandCircuitBroken = false;
  private rerankCircuitBroken = false;

  constructor(options: RemoteLLMOptions) {
    this.expandApiUrl = options.expandApiUrl?.trim().replace(/\/+$/, "");
    this.expandApiModel = options.expandApiModel?.trim();
    this.expandApiKey = options.expandApiKey?.trim();
    this.rerankApiUrl = options.rerankApiUrl?.trim().replace(/\/+$/, "");
    this.rerankApiModel = options.rerankApiModel?.trim();
    this.rerankApiKey = options.rerankApiKey?.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get supportsExpand(): boolean {
    return Boolean(this.expandApiUrl && this.expandApiModel && !this.expandCircuitBroken);
  }

  get supportsRerank(): boolean {
    return Boolean(this.rerankApiUrl && this.rerankApiModel && !this.rerankCircuitBroken);
  }

  async embed(_text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    // Embedding is handled separately by EmbeddingProvider
    return null;
  }

  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    return null;
  }

  async modelExists(_model: string): Promise<ModelInfo> {
    return { name: _model, path: _model, exists: true };
  }

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    if (!this.supportsExpand) {
      throw new Error("Remote expansion is not configured or circuit is broken.");
    }

    const systemPrompt = `You are a query expansion assistant for document search. Output variations for search backends using prefix lines:
lex: keyword search phrase
vec: semantic search question
hyde: hypothetical passage answer (50-100 words)`;

    const userPrompt = options?.context
      ? `Context: ${options.context}\nQuery: ${query}`
      : `Query: ${query}`;

    try {
      const url = this.expandApiUrl!.endsWith("/chat/completions")
        ? this.expandApiUrl!
        : `${this.expandApiUrl}/chat/completions`;

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.expandApiKey ? { authorization: `Bearer ${this.expandApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.expandApiModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        this.expandCircuitBroken = true;
        throw new Error(`Remote expansion API returned status ${res.status}`);
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const rawText = data.choices?.[0]?.message?.content ?? "";

      const results: Queryable[] = [];
      const lines = rawText.split("\n");
      for (const line of lines) {
        const match = /^(lex|vec|hyde)\s*:\s*(.+)$/i.exec(line.trim());
        if (match && match[1] && match[2]) {
          const type = match[1].toLowerCase() as "lex" | "vec" | "hyde";
          results.push({ type, text: match[2].trim() });
        }
      }

      if (results.length === 0) {
        results.push({ type: "vec", text: query });
      }

      return results;
    } catch (err) {
      this.expandCircuitBroken = true;
      throw err;
    }
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    const model = options?.model ?? this.rerankApiModel ?? "remote-rerank";
    if (!this.supportsRerank) {
      throw new Error("Remote reranking is not configured or circuit is broken.");
    }

    if (documents.length === 0) {
      return { results: [], model };
    }

    try {
      const url = this.rerankApiUrl!.endsWith("/rerank")
        ? this.rerankApiUrl!
        : `${this.rerankApiUrl}/rerank`;

      const docsPayload = documents.map(d => typeof d === "string" ? d : d.text);

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.rerankApiKey ? { authorization: `Bearer ${this.rerankApiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          query,
          documents: docsPayload,
        }),
      });

      if (!res.ok) {
        this.rerankCircuitBroken = true;
        throw new Error(`Remote rerank API returned status ${res.status}`);
      }

      const data = (await res.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };

      const rawResults = data.results ?? [];
      const formattedResults: RerankDocumentResult[] = rawResults.map(r => {
        const doc = documents[r.index];
        const file = typeof doc === "string" ? doc : doc?.file ?? `doc_${r.index}`;
        return {
          file,
          score: normalizeRerankScore(r.relevance_score),
          index: r.index,
        };
      });

      return { results: formattedResults, model };
    } catch (err) {
      this.rerankCircuitBroken = true;
      throw err;
    }
  }

  async dispose(): Promise<void> {}
}
