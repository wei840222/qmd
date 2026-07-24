import {
  formatDocForEmbedding,
  formatQueryForEmbedding,
  waitForLLMSessionsToDrain,
  withLLMSessionForLlm,
  type EmbeddingResult,
  type ILLMSession,
  type LlamaCpp,
} from "../llm.js";
import {
  EmbeddingProviderError,
  type EmbeddingOperationOptions,
  type EmbeddingProvider,
  type EmbeddingProviderOwner,
  type EmbeddingVector,
} from "./provider.js";
import { canonicalLocalEmbeddingIdentityMaterial } from "./local-identity.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface LocalEmbeddingProviderOptions {
  model?: string;
  dimension?: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "local-llama-cpp";
  readonly remote = false;
  readonly model: string;

  private readonly session: ILLMSession;

  canonicalIdentityMaterialForDimension(dimension: number): string {
    return canonicalLocalEmbeddingIdentityMaterial(this.model, dimension);
  }

  private readonly closeController = new AbortController();
  private currentDimension: number | null;
  private closed = false;

  constructor(session: ILLMSession, options: LocalEmbeddingProviderOptions = {}) {
    this.session = session;
    const requestedModel = options.model ?? session.embeddingModel;
    if (requestedModel !== session.embeddingModel) {
      throw new EmbeddingProviderError(
        "MODEL_MISMATCH",
        `Configured embedding model ${requestedModel} does not match session model ${session.embeddingModel}.`,
      );
    }
    this.model = session.embeddingModel;
    if (options.dimension !== undefined && (!Number.isInteger(options.dimension) || options.dimension < 1)) {
      throw new EmbeddingProviderError(
        "DIMENSION_MISMATCH",
        "Configured embedding dimension must be a positive integer.",
      );
    }
    this.currentDimension = options.dimension ?? null;
  }

  get dimension(): number | null {
    return this.currentDimension;
  }

  canonicalIdentityMaterial(): string {
    if (this.dimension === null) {
      throw new EmbeddingProviderError(
        "DIMENSION_UNKNOWN",
        "Embedding provider identity is unavailable until its vector dimension is known.",
      );
    }
    return JSON.stringify({
      provider: this.providerId,
      model: this.model,
      dimension: this.dimension,
      remote: this.remote,
      query_format: this.formatQuery("__qmd_query_identity__"),
      document_format: this.formatDocument(
        "__qmd_document_identity__",
        "__qmd_document_identity_title__",
      ),
    });
  }

  formatQuery(query: string): string {
    return formatQueryForEmbedding(query, this.model);
  }

  formatDocument(text: string, title?: string): string {
    return formatDocForEmbedding(text, title, this.model);
  }

  async embed(
    text: string,
    options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector> {
    const result = await this.runOperation(
      "embed",
      options,
      () => this.session.embed(text, {
        model: this.model,
        isQuery: options.kind === "query",
      }),
    );
    const vector = this.validateResult(result, "embed", undefined, this.currentDimension);
    if (this.currentDimension === null) this.currentDimension = vector.dimension;
    return vector;
  }

  async embedBatch(
    texts: string[],
    options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector[]> {
    const results = await this.runOperation(
      "embedBatch",
      options,
      () => texts.length === 0
        ? Promise.resolve([])
        : this.session.embedBatch(texts, {
            model: this.model,
            isQuery: options.kind === "query",
          }),
    );

    if (results.length !== texts.length) {
      throw new EmbeddingProviderError(
        "BATCH_CARDINALITY_MISMATCH",
        `Embedding batch returned ${results.length} results for ${texts.length} inputs.`,
        { operation: "embedBatch" },
      );
    }

    let batchDimension = this.currentDimension;
    const vectors = results.map((result, index) => {
      const vector = this.validateResult(result, "embedBatch", index, batchDimension);
      batchDimension ??= vector.dimension;
      return vector;
    });
    if (this.currentDimension === null) this.currentDimension = batchDimension;
    return vectors;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
  }

  private validateResult(
    result: EmbeddingResult | null,
    operation: "embed" | "embedBatch",
    index: number | undefined,
    expectedDimension: number | null,
  ): EmbeddingVector {
    if (result === null) {
      throw new EmbeddingProviderError(
        "MISSING_EMBEDDING",
        index === undefined
          ? "Embedding provider returned no vector."
          : `Embedding provider returned no vector for batch item ${index}.`,
        { operation, index },
      );
    }

    if (result.model !== this.model) {
      throw new EmbeddingProviderError(
        "MODEL_MISMATCH",
        `Embedding result model ${result.model} does not match provider model ${this.model}.`,
        { operation, index },
      );
    }

    const vector = result.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new EmbeddingProviderError(
        "EMPTY_VECTOR",
        "Embedding provider returned an empty vector.",
        { operation, index },
      );
    }
    if (!vector.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new EmbeddingProviderError(
        "NON_FINITE_VECTOR",
        "Embedding provider returned a vector containing a non-finite value.",
        { operation, index },
      );
    }

    if (expectedDimension !== null && vector.length !== expectedDimension) {
      throw new EmbeddingProviderError(
        "DIMENSION_MISMATCH",
        `Embedding vector dimension ${vector.length} does not match provider dimension ${expectedDimension}.`,
        { operation, index },
      );
    }

    return {
      vector: [...vector],
      model: result.model,
      dimension: vector.length,
    };
  }

  private async runOperation<T>(
    operation: "embed" | "embedBatch",
    options: EmbeddingOperationOptions,
    invoke: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new EmbeddingProviderError(
        "PROVIDER_CLOSED",
        "Embedding provider is closed.",
        { operation },
      );
    }

    const signals = [...new Set(
      [options.signal, this.session.signal, this.closeController.signal]
        .filter((signal): signal is AbortSignal => signal !== undefined),
    )];
    if (signals.some(signal => signal.aborted)) {
      throw new EmbeddingProviderError(
        "OPERATION_ABORTED",
        "Embedding operation was aborted.",
        { operation },
      );
    }
    if (options.deadline !== undefined) {
      if (!Number.isFinite(options.deadline) || options.deadline <= Date.now()) {
        throw new EmbeddingProviderError(
          "DEADLINE_EXCEEDED",
          "Embedding operation deadline was exceeded.",
          { operation },
        );
      }
    }

    try {
      return await this.waitForOperation(operation, signals, options.deadline, invoke);
    } catch (error) {
      if (error instanceof EmbeddingProviderError) throw error;
      throw new EmbeddingProviderError(
        "PROVIDER_FAILURE",
        "Embedding provider operation failed.",
        { operation },
      );
    }
  }

  private waitForOperation<T>(
    operation: "embed" | "embedBatch",
    signals: AbortSignal[],
    deadline: number | undefined,
    invoke: () => Promise<T>,
  ): Promise<T> {
    if (signals.length === 0 && deadline === undefined) {
      return Promise.resolve().then(invoke);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        for (const signal of signals) signal.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onAbort = (): void => finish(() => reject(new EmbeddingProviderError(
        "OPERATION_ABORTED",
        "Embedding operation was aborted.",
        { operation },
      )));
      const scheduleDeadline = (): void => {
        if (deadline === undefined || settled) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          finish(() => reject(new EmbeddingProviderError(
            "DEADLINE_EXCEEDED",
            "Embedding operation deadline was exceeded.",
            { operation },
          )));
          return;
        }
        deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
        deadlineTimer.unref?.();
      };

      for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
      scheduleDeadline();
      void Promise.resolve().then(() => {
        if (settled) return;
        if (deadline !== undefined && deadline <= Date.now()) {
          finish(() => reject(new EmbeddingProviderError(
            "DEADLINE_EXCEEDED",
            "Embedding operation deadline was exceeded.",
            { operation },
          )));
          return;
        }

        try {
          void invoke().then(
            value => finish(() => resolve(value)),
            error => finish(() => reject(error)),
          );
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }
}

class ScopedLocalEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "local-llama-cpp";
  readonly remote = false;
  readonly model: string;

  private readonly llm: LlamaCpp;

  canonicalIdentityMaterialForDimension(dimension: number): string {
    return canonicalLocalEmbeddingIdentityMaterial(this.model, dimension);
  }

  private readonly closeController = new AbortController();
  private currentDimension: number | null;
  private closed = false;

  constructor(llm: LlamaCpp, options: LocalEmbeddingProviderOptions = {}) {
    this.llm = llm;
    this.model = options.model ?? llm.embedModelName;
    this.currentDimension = options.dimension ?? null;
  }

  get dimension(): number | null {
    return this.currentDimension;
  }

  canonicalIdentityMaterial(): string {
    if (this.dimension === null) {
      throw new EmbeddingProviderError(
        "DIMENSION_UNKNOWN",
        "Embedding provider identity is unavailable until its vector dimension is known.",
      );
    }
    return JSON.stringify({
      provider: this.providerId,
      model: this.model,
      dimension: this.dimension,
      remote: this.remote,
      query_format: this.formatQuery("__qmd_query_identity__"),
      document_format: this.formatDocument(
        "__qmd_document_identity__",
        "__qmd_document_identity_title__",
      ),
    });
  }

  formatQuery(query: string): string {
    return formatQueryForEmbedding(query, this.model);
  }

  formatDocument(text: string, title?: string): string {
    return formatDocForEmbedding(text, title, this.model);
  }

  embed(
    text: string,
    options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector> {
    return this.runScoped(options, (provider, scopedOptions) => (
      provider.embed(text, scopedOptions)
    ));
  }

  embedBatch(
    texts: string[],
    options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector[]> {
    return this.runScoped(options, (provider, scopedOptions) => (
      provider.embedBatch(texts, scopedOptions)
    ));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
  }

  private async runScoped<T extends EmbeddingVector | EmbeddingVector[]>(
    options: EmbeddingOperationOptions,
    invoke: (
      provider: LocalEmbeddingProvider,
      scopedOptions: EmbeddingOperationOptions,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new EmbeddingProviderError("PROVIDER_CLOSED", "Embedding provider is closed.");
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.closeController.signal])
      : this.closeController.signal;
    const maxDuration = options.deadline === undefined
      ? undefined
      : Math.max(1, options.deadline - Date.now());

    return withLLMSessionForLlm(this.llm, async session => {
      const provider = new LocalEmbeddingProvider(session, {
        model: this.model,
        dimension: this.currentDimension ?? undefined,
      });
      try {
        const result = await invoke(provider, { ...options, signal });
        const vectors = Array.isArray(result) ? result : [result];
        for (const vector of vectors) this.captureDimension(vector.dimension);
        return result;
      } finally {
        await provider.close();
      }
    }, {
      maxDuration,
    });
  }

  private captureDimension(dimension: number): void {
    if (this.currentDimension !== null && this.currentDimension !== dimension) {
      throw new EmbeddingProviderError(
        "DIMENSION_MISMATCH",
        `Embedding dimension changed from ${this.currentDimension} to ${dimension}.`,
      );
    }
    this.currentDimension = dimension;
  }
}

export class LocalEmbeddingProviderOwner implements EmbeddingProviderOwner {
  readonly provider: EmbeddingProvider;

  private readonly llm: LlamaCpp;
  private closePromise: Promise<void> | undefined;

  constructor(llm: LlamaCpp, options: LocalEmbeddingProviderOptions = {}) {
    this.llm = llm;
    this.provider = new ScopedLocalEmbeddingProvider(llm, options);
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        await this.provider.close();
        await waitForLLMSessionsToDrain(this.llm);
        await this.llm.dispose();
      })();
    }
    return this.closePromise;
  }
}
