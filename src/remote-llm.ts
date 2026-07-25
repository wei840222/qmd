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
  generateUrl?: string;
  generateBaseUrl?: string;
  generateApiUrl?: string;
  generateApiModel?: string;
  generateApiKey?: string;
  rerankUrl?: string;
  rerankBaseUrl?: string;
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

export function resolveEndpointUrl(
  rawUrl: string | undefined,
  defaultEndpoint: "/chat/completions" | "/rerank",
): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  if (trimmed.endsWith("/chat/completions") || trimmed.endsWith("/rerank")) {
    return trimmed;
  }
  return `${trimmed}${defaultEndpoint}`;
}

export class RemoteLLM implements LLM {
  private readonly generateApiUrl?: string;
  private readonly generateApiModel?: string;
  private readonly generateApiKey?: string;
  private readonly rerankApiUrl?: string;
  private readonly rerankApiModel?: string;
  private readonly rerankApiKey?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  private generateCircuitBroken = false;
  private rerankCircuitBroken = false;

  constructor(options: RemoteLLMOptions) {
    const rawGenerateUrl = options.generateUrl ?? options.generateBaseUrl ?? options.generateApiUrl;
    const rawRerankUrl = options.rerankUrl ?? options.rerankBaseUrl ?? options.rerankApiUrl;

    this.generateApiUrl = resolveEndpointUrl(rawGenerateUrl, "/chat/completions");
    this.generateApiModel = options.generateApiModel?.trim();
    this.generateApiKey = options.generateApiKey?.trim();
    this.rerankApiUrl = resolveEndpointUrl(rawRerankUrl, "/rerank");
    this.rerankApiModel = options.rerankApiModel?.trim();
    this.rerankApiKey = options.rerankApiKey?.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get supportsExpand(): boolean {
    return Boolean(this.generateApiUrl && this.generateApiModel && !this.generateCircuitBroken);
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
hyde: hypothetical passage answer (50-100 words)

Rules:
- Generate all variations in the SAME language and script as the user query (e.g. Traditional Chinese query -> Traditional Chinese variations). Do NOT switch to Japanese or other languages unless explicitly requested by the query.`;

    const userPrompt = options?.context
      ? `Context: ${options.context}\nQuery: ${query}`
      : `Query: ${query}`;

    try {
      const url = this.generateApiUrl!;

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.generateApiKey ? { authorization: `Bearer ${this.generateApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.generateApiModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        this.generateCircuitBroken = true;
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
      this.generateCircuitBroken = true;
      throw err;
    }
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions | string): Promise<RerankResult> {
    const model = this.rerankApiModel || (typeof options === "string" ? options : options?.model) || "remote-rerank";
    if (!this.supportsRerank) {
      throw new Error("Remote reranking is not configured or circuit is broken.");
    }

    if (documents.length === 0) {
      return { results: [], model };
    }

    // If explicit chat completions URL is configured for rerank, route directly to LLM chat rerank
    if (this.rerankApiUrl!.endsWith("/chat/completions")) {
      return this.rerankViaChatCompletions(query, documents, model);
    }

    try {
      const url = this.rerankApiUrl!;

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

      // If /rerank returns 404 (endpoint not supported), fallback to LLM Chat Reranking
      if (res.status === 404) {
        return this.rerankViaChatCompletions(query, documents, model);
      }

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

  /**
   * Rerank documents via LLM Chat Completions API (/v1/chat/completions).
   * Useful when server has no dedicated /v1/rerank endpoint (e.g. standard LLM endpoint).
   */
  private async rerankViaChatCompletions(
    query: string,
    documents: RerankDocument[],
    model: string,
  ): Promise<RerankResult> {
    const systemPrompt = `You are a document relevance reranker. Rank candidate documents by relevance to the search query.
Output ONLY a single JSON object. DO NOT include markdown codeblocks (\`\`\`json), markdown formatting, preamble, or commentary.
JSON format:
{
  "results": [
    {"index": 0, "score": 0.95},
    {"index": 2, "score": 0.85}
  ]
}
Rules:
1. "index": integer matching candidate index (0 to ${documents.length - 1}).
2. "score": float between 0.0 (irrelevant) and 1.0 (highly relevant).
3. Include relevant candidates. You may omit items with 0 relevance to conserve tokens.`;

    const docItems = documents.map((d, i) => {
      const text = typeof d === "string" ? d : d.text;
      return `[Candidate ${i}]\n${text.slice(0, 1000)}`;
    }).join("\n\n");

    const userPrompt = `Query: ${query}\n\nCandidate Documents:\n${docItems}\n\nReturn raw JSON only. Start with { and end with }. No Markdown fences.`;

    const url = this.rerankApiUrl!;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.rerankApiKey ? { authorization: `Bearer ${this.rerankApiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.rerankCircuitBroken = true;
      throw new Error(`LLM Chat Rerank API returned status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawContent = data.choices?.[0]?.message?.content ?? "";

    const formattedResults: RerankDocumentResult[] = [];
    try {
      // Clean markdown codeblock fences (e.g. ```json ... ```)
      const cleaned = rawContent
        .replace(/^```(?:json)?/gi, "")
        .replace(/```$/g, "")
        .trim();

      const jsonMatch = /\{[\s\S]*\}/.exec(cleaned);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned) as {
        results?: Array<{ index: number; score: number }>;
      };

      const resultsList = Array.isArray(parsed?.results) ? parsed.results : [];
      const seenIndices = new Set<number>();

      for (const item of resultsList) {
        if (
          item &&
          typeof item.index === "number" &&
          !isNaN(item.index) &&
          item.index >= 0 &&
          item.index < documents.length &&
          !seenIndices.has(item.index)
        ) {
          seenIndices.add(item.index);
          const doc = documents[item.index];
          const file = typeof doc === "string" ? doc : doc?.file ?? `doc_${item.index}`;
          const rawScore = typeof item.score === "number" && !isNaN(item.score) ? item.score : 0;
          const clampedScore = Math.max(0, Math.min(1, rawScore));
          formattedResults.push({
            file,
            score: normalizeRerankScore(clampedScore),
            index: item.index,
          });
        }
      }
    } catch {
      // Fallback handled below if formattedResults is empty
    }

    if (formattedResults.length === 0) {
      // Fallback: preserve original candidate ordering with default score
      documents.forEach((d, i) => {
        const file = typeof d === "string" ? d : d.file;
        formattedResults.push({ file, score: 0.5, index: i });
      });
    }

    return { results: formattedResults, model };
  }

  async dispose(): Promise<void> {}
}
