import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import type {
  RerankDocument,
  RerankDocumentResult,
  RerankOptions,
  RerankResult,
  SearchIntentGuidance,
} from "./llm.js";
import { getFormattedLocalTime } from "./remote-llm.js";

export const DEFAULT_JEV_TIMEOUT_MS = 30000;
export const DEFAULT_JEV_RERANK_BATCH_SIZE = 40;

export interface JevSystemOneClient {
  systemOne(request: any, options?: any): Promise<any>;
}

export interface RemoteJevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  concurrency?: number;
  batchSize?: number;
  timeoutMs?: number;
  client?: TypeSafeClient | JevSystemOneClient;
}

export type JevStrategyDefinition = SearchIntentGuidance;

export const JEV_STRATEGY_PLAYBOOK: Record<string, JevStrategyDefinition> = {
  code_search: {
    label: "Code Search",
    objective: "Looking for specific code, functions, APIs, syntax, or implementations.",
    lexGuidance: "Prioritize exact function, method, class, API names, language syntax keywords, and library identifiers without extra filler words.",
    vecGuidance: "Formulate concrete implementation or usage questions (e.g., 'how to implement/call <API> with <options>').",
  },
  concept_search: {
    label: "Concept Search",
    objective: "Looking for explanations, architecture, principles, or documentation.",
    lexGuidance: "Prioritize domain terminology, conceptual keywords, architectural patterns, and core component names without extra filler words.",
    vecGuidance: "Formulate conceptual or explanatory questions (e.g., 'how does <concept> work and why is it used').",
  },
  factual_lookup: {
    label: "Factual Lookup",
    objective: "Looking for specific facts, configuration settings, defaults, or parameters.",
    lexGuidance: "Prioritize exact configuration keys, CLI flags, parameter names, environment variables, dates, or error codes without extra filler words.",
    vecGuidance: "Formulate direct lookup questions (e.g., 'what is the default configuration or value for <param>').",
  },
  broad_exploration: {
    label: "Broad Exploration",
    objective: "Exploring a topic broadly without a specific target.",
    lexGuidance: "Include major topical keywords and closely related sub-domain topics.",
    vecGuidance: "Formulate broad introductory or overview inquiries covering the topic landscape.",
  },
};

export interface JevIntentClassification {
  strategy: string;
  confidence: number;
  needsHyde: boolean;
  needsHydeConfidence?: number;
  strategyDetails?: JevStrategyDefinition;
}

export class RemoteJev {
  readonly model: string;
  readonly concurrency: number;
  readonly batchSize: number;
  readonly client: TypeSafeClient | JevSystemOneClient;

  constructor(options: RemoteJevOptions = {}) {
    this.model = options.model?.trim() || "jev-1.13";
    this.concurrency = options.concurrency ?? 10;
    this.batchSize = options.batchSize ?? DEFAULT_JEV_RERANK_BATCH_SIZE;

    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim();
      const baseURL = options.baseUrl?.trim() || process.env.TYPESAFE_BASE_URL?.trim();
      this.client = new TypeSafeClient({
        apiKey,
        baseURL: baseURL || undefined,
        defaultModel: this.model,
        timeout: options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS,
      });
    }
  }

  get supportsRerank(): boolean {
    return true;
  }

  get supportsExpand(): boolean {
    return true;
  }

  get rerankModelName(): string {
    return `jev:${this.model}`;
  }

  resetCircuitBreaker(): void {
    // Kept for interface compatibility; error handling is handled per-request in caller/fallback
  }

  async classifyIntent(
    query: string,
    options?: { context?: string; timeZone?: string },
  ): Promise<JevIntentClassification> {
    const state: Record<string, string> = { query };
    if (options?.context) {
      state.context = options.context;
    }
    state.current_time = getFormattedLocalTime(new Date(), options?.timeZone);

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

    const strategyChoice = response.answers.strategy.choice;
    return {
      strategy: strategyChoice,
      confidence: response.answers.strategy.confidence,
      needsHyde: response.answers.needs_hyde.noul > 0.6,
      needsHydeConfidence: response.answers.needs_hyde.noul,
      strategyDetails: JEV_STRATEGY_PLAYBOOK[strategyChoice],
    };
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    if (documents.length === 0) {
      return { results: [], model: `jev:${this.model}` };
    }

    const state: Record<string, string> = { query };
    const timeZone = typeof options === "object" && options !== null ? (options as any).timeZone : undefined;
    state.current_time = getFormattedLocalTime(new Date(), timeZone);
    if (typeof options === "object" && options !== null && (options as any).context) {
      state.context = (options as any).context;
    }

    const criteria = {
      true: "The candidate directly addresses the query's specific question, requirement, or topic, satisfying any time or entity constraints.",
      false: "The candidate is only on a similar topic, outside the requested time window, or unrelated to the query's specific need.",
    };

    const batches: { docs: RerankDocument[]; offset: number }[] = [];
    for (let offset = 0; offset < documents.length; offset += this.batchSize) {
      batches.push({ docs: documents.slice(offset, offset + this.batchSize), offset });
    }

    const batchResults = await pMap(
      batches,
      async ({ docs: batchDocs, offset }) => {
        const questions: Record<string, any> = {};

        for (let i = 0; i < batchDocs.length; i++) {
          const doc = batchDocs[i]!;
          const text = typeof doc === "string" ? doc : doc.text;
          const candidate = truncateCandidateText(text, 1500);

          const instructions: Record<string, any> = {
            candidate,
            question: "Does `candidate` directly answer or address the search query in `query`?",
          };
          if (typeof doc !== "string" && doc.title) {
            instructions.title = doc.title;
          }
          if (typeof doc !== "string" && doc.file) {
            instructions.file = doc.file;
          }

          questions[`cand_${i}`] = noul(instructions, criteria);
        }

        const response = await this.client.systemOne({
          state,
          model: this.model,
          questions,
        });

        const results: RerankDocumentResult[] = [];
        for (let i = 0; i < batchDocs.length; i++) {
          const doc = batchDocs[i]!;
          const file = typeof doc === "string" ? doc : doc.file;
          const key = `cand_${i}`;
          const answer = response?.answers?.[key];
          const score = typeof answer?.noul === "number" ? answer.noul : 0;
          results.push({
            file,
            score,
            index: offset + i,
          });
        }
        return results;
      },
      this.concurrency,
    );

    const flattened = batchResults.flat();
    // Sort by score descending
    flattened.sort((a, b) => b.score - a.score);

    return {
      results: flattened,
      model: `jev:${this.model}`,
    };
  }

  async dispose(): Promise<void> {
    // No persistent connections or handles to close
  }
}

function truncateCandidateText(text: string, maxChars = 1500): string {
  if (text.length <= maxChars) return text;
  let sliced = text.slice(0, maxChars);
  // Avoid malformed surrogate pairs when slicing by UTF-16 code units
  if (/[\uD800-\uDBFF]$/.test(sliced)) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let hasFailed = false;

  async function worker() {
    while (nextIndex < items.length && !hasFailed) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item !== undefined) {
        try {
          results[currentIndex] = await mapper(item, currentIndex);
        } catch (err) {
          hasFailed = true;
          throw err;
        }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}
