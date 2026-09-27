import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type {
  RerankDocument,
  RerankOptions,
  RerankResult,
} from "./llm.js";

export interface JevSystemOneClient {
  systemOne(request: any, options?: any): Promise<any>;
}

export interface RemoteJevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  concurrency?: number;
  timeoutMs?: number;
  client?: TypeSafeClient | JevSystemOneClient;
}

export interface JevIntentClassification {
  strategy: string;
  confidence: number;
  needsHyde: boolean;
  needsHydeConfidence?: number;
}

export class RemoteJev {
  readonly model: string;
  readonly concurrency: number;
  readonly client: TypeSafeClient | JevSystemOneClient;
  private circuitBroken = false;

  constructor(options: RemoteJevOptions = {}) {
    this.model = options.model?.trim() || "jev-1.13";
    this.concurrency = options.concurrency ?? 10;

    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim();
      const baseURL = options.baseUrl?.trim() || process.env.TYPESAFE_BASE_URL?.trim();
      this.client = new TypeSafeClient({
        apiKey,
        baseURL: baseURL || undefined,
        defaultModel: this.model,
        timeout: options.timeoutMs,
      });
    }
  }

  get supportsRerank(): boolean {
    return !this.circuitBroken;
  }

  get supportsExpand(): boolean {
    return !this.circuitBroken;
  }

  resetCircuitBreaker(): void {
    this.circuitBroken = false;
  }

  async classifyIntent(
    query: string,
    options?: { context?: string },
  ): Promise<JevIntentClassification> {
    if (this.circuitBroken) {
      throw new Error("RemoteJev circuit is broken.");
    }

    const state: Record<string, string> = { query };
    if (options?.context) {
      state.context = options.context;
    }

    try {
      const response = await this.client.systemOne({
        state,
        model: this.model,
        questions: {
          strategy: choice(
            "What type of search is the user performing given the query and optional context?",
            {
              code_search: "Looking for specific code, functions, APIs, or implementations",
              concept_search: "Looking for explanations, concepts, or documentation",
              factual_lookup: "Looking for specific facts, configurations, or settings",
              broad_exploration: "Exploring a topic broadly without a specific target",
            },
          ),
          needs_hyde: noul(
            "Is this query specific enough that a hypothetical answer document could be written?",
            {
              true: "The query asks about a concrete topic with a definable answer.",
              false: "The query is too vague, broad, or exploratory for a useful hypothetical answer.",
            },
          ),
        },
      });

      return {
        strategy: response.answers.strategy.choice,
        confidence: response.answers.strategy.confidence,
        needsHyde: response.answers.needs_hyde.noul > 0.6,
        needsHydeConfidence: response.answers.needs_hyde.noul,
      };
    } catch (err) {
      this.circuitBroken = true;
      throw err;
    }
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    _options?: RerankOptions,
  ): Promise<RerankResult> {
    if (this.circuitBroken) {
      throw new Error("RemoteJev circuit is broken.");
    }

    if (documents.length === 0) {
      return { results: [], model: `jev:${this.model}` };
    }

    const rerankQuestion = noul(
      "Does this candidate document answer or address the search query?",
      {
        true: "The candidate directly addresses the query's specific question, requirement, or topic.",
        false: "The candidate is only on a similar topic or is unrelated to the query's specific need.",
      },
    );

    try {
      const results = await pMap(
        documents,
        async (doc, index) => {
          const text = typeof doc === "string" ? doc : doc.text;
          const file = typeof doc === "string" ? doc : doc.file;
          const candidate = text.slice(0, 1500);

          const state: Record<string, string> = { query, candidate };
          if (typeof doc !== "string" && doc.title) {
            state.title = doc.title;
          }

          const response = await this.client.systemOne({
            state,
            model: this.model,
            questions: { is_relevant: rerankQuestion },
          });

          return {
            file,
            score: response.answers.is_relevant.noul,
            index,
          };
        },
        this.concurrency,
      );

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      return {
        results,
        model: `jev:${this.model}`,
      };
    } catch (err) {
      this.circuitBroken = true;
      throw err;
    }
  }

  async dispose(): Promise<void> {
    // No persistent connections or handles to close
  }
}

async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await mapper(item, currentIndex);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}
