import { createHash } from "node:crypto";
import {
  DEFAULT_VOYAGE_BASE_URL,
  DEFAULT_VOYAGE_EMBEDDING_DIMENSION,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  VOYAGE_EMBEDDING_MODELS,
  type VoyageEmbeddingModel,
} from "./config.js";
import {
  EmbeddingProviderError,
  type EmbeddingOperationOptions,
  type EmbeddingProvider,
  type RemoteEmbeddingRequestGuard,
  type EmbeddingVector,
} from "./provider.js";
import { canonicalRemoteChunkProfile } from "./remote-chunking.js";

const MAX_INPUTS_PER_REQUEST = 128;
export const DEFAULT_MAX_INPUT_TOKEN_UPPER_BOUND = 32_000;
const MAX_BATCH_TOKEN_UPPER_BOUND = 320_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const utf8Encoder = new TextEncoder();

export function getMaxInputTokenLimit(model: string): number {
  if (model === "voyage-2") return 4_000;
  if (model.includes("-2")) return 16_000;
  return DEFAULT_MAX_INPUT_TOKEN_UPPER_BOUND;
}

function normalizeVoyageBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl?.trim() || DEFAULT_VOYAGE_BASE_URL).replace(/\/+$/, "");
}

function endpointFingerprint(baseUrl: string): string | undefined {
  if (baseUrl === DEFAULT_VOYAGE_BASE_URL) return undefined;
  return createHash("sha256").update(baseUrl).digest("hex");
}

export interface VoyageEmbeddingUsage {
  readonly promptTokens: number;
  readonly totalTokens: number;
}

export interface VoyageEmbeddingProviderOptions {
  apiKey?: string;
  model?: VoyageEmbeddingModel;
  dimension?: number;
  /** Override the base URL. Falls back to VOYAGE_BASE_URL, OPENAI_BASE_URL, or official Voyage API. */
  baseUrl?: string;
  maxAttempts?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Internal per-attempt timeout test seam. This is deliberately not part of public qmd config. */
  requestTimeoutMs?: number;
  /** Mandatory fail-closed policy boundary, invoked immediately before every fetch attempt. */
  authorizeRequest?: RemoteEmbeddingRequestGuard;
}

export function canonicalVoyageEmbeddingIdentityMaterial(
  model: VoyageEmbeddingModel = DEFAULT_VOYAGE_EMBEDDING_MODEL,
  dimension?: number,
  baseUrl: string | undefined = undefined,
): string {
  const expectedDimension = VOYAGE_EMBEDDING_MODELS.get(model);
  const effectiveDimension = dimension ?? expectedDimension ?? DEFAULT_VOYAGE_EMBEDDING_DIMENSION;
  const endpoint = endpointFingerprint(normalizeVoyageBaseUrl(baseUrl));
  return JSON.stringify({
    provider: "voyageai",
    model,
    dimension: effectiveDimension,
    remote: true,
    format: "qmd-voyage-embedding-v1",
    chunking: canonicalRemoteChunkProfile(),
    ...(endpoint === undefined ? {} : { endpointFingerprint: endpoint }),
  });
}

export class UnavailableVoyageEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "voyageai";
  readonly model: VoyageEmbeddingModel;
  readonly dimension: number;
  readonly remote = true;
  private readonly configuredBaseUrl: string | undefined;

  constructor(options?: { model?: VoyageEmbeddingModel; dimension?: number; baseUrl?: string }) {
    this.model = options?.model ?? DEFAULT_VOYAGE_EMBEDDING_MODEL;
    this.dimension = options?.dimension ?? (VOYAGE_EMBEDDING_MODELS.get(this.model) ?? DEFAULT_VOYAGE_EMBEDDING_DIMENSION);
    this.configuredBaseUrl = options?.baseUrl;
  }

  canonicalIdentityMaterial(): string {
    return canonicalVoyageEmbeddingIdentityMaterial(
      this.model,
      this.dimension,
      this.configuredBaseUrl ?? process.env.VOYAGE_BASE_URL ?? process.env.OPENAI_BASE_URL,
    );
  }

  formatQuery(query: string): string {
    return query;
  }

  formatDocument(text: string, title?: string): string {
    return title ? `${title}\n${text}` : text;
  }

  estimateTokens(text: string): number {
    return utf8Encoder.encode(text).byteLength;
  }

  async embed(_text: string, _options: EmbeddingOperationOptions): Promise<EmbeddingVector> {
    throw new EmbeddingProviderError(
      "PROVIDER_FAILURE",
      "Voyage AI embedding provider is not available (missing API key or configuration).",
    );
  }

  async embedBatch(
    _texts: string[],
    _options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector[]> {
    throw new EmbeddingProviderError(
      "PROVIDER_FAILURE",
      "Voyage AI embedding provider is not available (missing API key or configuration).",
    );
  }

  async close(): Promise<void> {}
}

interface VoyageEmbeddingResponse {
  object: "list";
  model: string;
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  usage: {
    prompt_tokens?: number;
    total_tokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function awaitWithSignal<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function parseResponse(
  value: unknown,
  inputCount: number,
  tokenUpperBound: number,
  expectedModel: VoyageEmbeddingModel = DEFAULT_VOYAGE_EMBEDDING_MODEL,
  expectedDimension: number = DEFAULT_VOYAGE_EMBEDDING_DIMENSION,
): VoyageEmbeddingResponse {
  if (
    !isRecord(value)
    || value.object !== "list"
    || typeof value.model !== "string"
    || (value.model !== expectedModel && !value.model.startsWith(expectedModel))
  ) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding response schema is invalid.");
  }
  if (!isRecord(value.usage)) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding usage is invalid.");
  }
  const totalTokens = value.usage.total_tokens;
  if (!Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding usage is invalid.");
  }
  const rawPromptTokens = value.usage.prompt_tokens;
  if (rawPromptTokens !== undefined && (!Number.isSafeInteger(rawPromptTokens) || (rawPromptTokens as number) < 0)) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding usage is invalid.");
  }
  const promptTokens = typeof rawPromptTokens === "number" ? rawPromptTokens : (totalTokens as number);
  if (
    (totalTokens as number) < promptTokens
    || promptTokens > tokenUpperBound
    || (totalTokens as number) > tokenUpperBound
  ) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding usage is invalid.");
  }
  if (!Array.isArray(value.data) || value.data.length !== inputCount) {
    throw new EmbeddingProviderError("BATCH_CARDINALITY_MISMATCH", "Voyage AI embedding response cardinality is invalid.");
  }

  const byIndex = new Array<VoyageEmbeddingResponse["data"][number] | undefined>(inputCount);
  for (const item of value.data) {
    if (!isRecord(item) || item.object !== "embedding") {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding item schema is invalid.");
    }
    const index = item.index;
    const embedding = item.embedding;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= inputCount) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding response index is invalid.");
    }
    if (byIndex[index as number]) {
      throw new EmbeddingProviderError("RESPONSE_SCHEMA_INVALID", "Voyage AI embedding response index is duplicated.");
    }
    if (
      !Array.isArray(embedding)
      || embedding.length !== expectedDimension
      || embedding.some(value => typeof value !== "number"
        || !Number.isFinite(value)
        || !Number.isFinite(Math.fround(value)))
    ) {
      throw new EmbeddingProviderError("DIMENSION_MISMATCH", "Voyage AI embedding vector is invalid.");
    }
    byIndex[index as number] = {
      object: "embedding",
      index: index as number,
      embedding: embedding as number[],
    };
  }

  return {
    object: "list",
    model: expectedModel,
    data: byIndex as VoyageEmbeddingResponse["data"],
    usage: {
      prompt_tokens: promptTokens as number,
      total_tokens: totalTokens as number,
    },
  };
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "voyageai";
  readonly model: VoyageEmbeddingModel;
  readonly dimension: number;
  readonly remote = true;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly authorizeRequest?: RemoteEmbeddingRequestGuard;
  private readonly fingerprint: string;
  private readonly closeController = new AbortController();
  private requestTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: VoyageEmbeddingProviderOptions) {
    const apiKey = options.apiKey?.trim() || undefined;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI maxAttempts must be between 1 and 3.");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI requestTimeoutMs must be positive.");
    }
    this.model = options.model ?? DEFAULT_VOYAGE_EMBEDDING_MODEL;
    this.dimension = options.dimension ?? (VOYAGE_EMBEDDING_MODELS.get(this.model) ?? DEFAULT_VOYAGE_EMBEDDING_DIMENSION);
    this.apiKey = apiKey || process.env.VOYAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined;
    this.baseUrl = normalizeVoyageBaseUrl(options.baseUrl ?? process.env.VOYAGE_BASE_URL ?? process.env.OPENAI_BASE_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxAttempts = maxAttempts;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.requestTimeoutMs = requestTimeoutMs;
    this.authorizeRequest = options.authorizeRequest;
    this.fingerprint = createHash("sha256")
      .update(this.canonicalIdentityMaterial())
      .digest("hex");
  }

  canonicalIdentityMaterial(): string {
    return this.canonicalIdentityMaterialForDimension(this.dimension);
  }

  canonicalIdentityMaterialForDimension(dimension: number): string {
    return canonicalVoyageEmbeddingIdentityMaterial(this.model, dimension, this.baseUrl);
  }

  formatQuery(query: string): string {
    return query;
  }

  formatDocument(text: string, title?: string): string {
    return title ? `${title}\n${text}` : text;
  }

  /** Conservative token upper bound: every token contains at least one UTF-8 byte. */
  estimateTokens(text: string): number {
    return utf8Encoder.encode(text).byteLength;
  }

  private lifecycleError(
    options: EmbeddingOperationOptions,
    deadlineController: AbortController,
  ): EmbeddingProviderError | null {
    if (this.closed || this.closeController.signal.aborted) {
      return new EmbeddingProviderError("PROVIDER_CLOSED", "Embedding provider is closed.");
    }
    if (options.signal?.aborted) {
      return new EmbeddingProviderError("OPERATION_ABORTED", "Embedding operation was aborted.");
    }
    if (deadlineController.signal.aborted) {
      return new EmbeddingProviderError("DEADLINE_EXCEEDED", "Embedding operation deadline was exceeded.");
    }
    return null;
  }

  private throwIfInterrupted(
    options: EmbeddingOperationOptions,
    deadlineController: AbortController,
  ): void {
    const error = this.lifecycleError(options, deadlineController);
    if (error) throw error;
  }

  private computeRetryDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(this.maxRetryDelayMs, Math.max(0, retryAfterMs));
    }
    const exponential = this.baseRetryDelayMs * (2 ** (attempt - 1));
    const capped = Math.min(this.maxRetryDelayMs, exponential);
    const jitterFactor = 0.5 + (this.random() * 0.5);
    return Math.floor(capped * jitterFactor);
  }

  private async acquireRequestSlot(signal: AbortSignal): Promise<() => void> {
    const turn = this.requestTail;
    let releaseSlot!: () => void;
    this.requestTail = new Promise<void>(resolve => {
      releaseSlot = resolve;
    });
    try {
      await waitForTurn(turn, signal);
      return releaseSlot;
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  async embed(text: string, options: EmbeddingOperationOptions): Promise<EmbeddingVector> {
    const vectors = await this.embedBatch([text], options);
    const vector = vectors[0];
    if (!vector) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding returned no vector.");
    }
    return vector;
  }

  async embedBatch(
    texts: string[],
    options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector[]> {
    options = Object.freeze({
      purpose: options.purpose,
      kind: options.kind,
      signal: options.signal,
      deadline: options.deadline,
      buildLease: options.buildLease ? Object.freeze({ ...options.buildLease }) : undefined,
      identityFingerprint: options.identityFingerprint,
    });
    if (typeof options.identityFingerprint !== "string" || options.identityFingerprint.length === 0) {
      throw new EmbeddingProviderError(
        "IDENTITY_FINGERPRINT_REQUIRED",
        "Remote embedding requests require a complete active identity fingerprint.",
      );
    }
    if (this.closed) {
      throw new EmbeddingProviderError("PROVIDER_CLOSED", "Embedding provider is closed.");
    }
    if (options.signal?.aborted) {
      throw new EmbeddingProviderError("OPERATION_ABORTED", "Embedding operation was aborted.");
    }
    if (!Array.isArray(texts) || texts.some(text => typeof text !== "string")) {
      throw new EmbeddingProviderError(
        "INPUT_BUDGET_EXCEEDED",
        "Voyage AI embedding inputs must be strings.",
      );
    }
    const inputs = Object.freeze([...texts]);
    const validPurposeKindPair = (options.purpose === "index-build" && options.kind === "document")
      || (options.purpose === "query-embedding" && options.kind === "query");
    if (!validPurposeKindPair) {
      throw new EmbeddingProviderError(
        "REMOTE_AUTHORIZATION_REQUIRED",
        "Remote embedding request purpose does not match its input kind.",
      );
    }

    if (inputs.length === 0 || inputs.length > MAX_INPUTS_PER_REQUEST) {
      throw new EmbeddingProviderError(
        "INPUT_BUDGET_EXCEEDED",
        `Voyage AI embedding batches must contain between 1 and ${MAX_INPUTS_PER_REQUEST} inputs.`,
      );
    }
    const maxInputTokenLimit = getMaxInputTokenLimit(this.model);
    let batchUpperBound = 0;
    for (const text of inputs) {
      const upperBound = this.estimateTokens(text);
      if (upperBound === 0 || upperBound > maxInputTokenLimit) {
        throw new EmbeddingProviderError(
          "INPUT_BUDGET_EXCEEDED",
          `Voyage AI embedding input exceeds the ${maxInputTokenLimit}-token upper bound.`,
        );
      }
      batchUpperBound += upperBound;
    }
    if (batchUpperBound > MAX_BATCH_TOKEN_UPPER_BOUND) {
      throw new EmbeddingProviderError(
        "INPUT_BUDGET_EXCEEDED",
        `Voyage AI embedding batch exceeds the ${MAX_BATCH_TOKEN_UPPER_BOUND}-token upper bound.`,
      );
    }

    const deadlineController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.deadline !== undefined) {
      const deadline = options.deadline;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new EmbeddingProviderError("DEADLINE_EXCEEDED", "Embedding operation deadline was exceeded.");
      }
      const scheduleDeadline = () => {
        const nextRemaining = deadline - this.now();
        if (nextRemaining <= 0) {
          deadlineController.abort();
          return;
        }
        deadlineTimer = setTimeout(scheduleDeadline, Math.min(nextRemaining, 2_147_483_647));
      };
      scheduleDeadline();
    }
    const signals = [this.closeController.signal, deadlineController.signal];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let releaseRequestSlot: (() => void) | undefined;
    try {
      try {
        releaseRequestSlot = await this.acquireRequestSlot(signal);
      } catch {
        this.throwIfInterrupted(options, deadlineController);
        throw new EmbeddingProviderError("PROVIDER_FAILURE", "Embedding request queue failed.");
      }
      this.throwIfInterrupted(options, deadlineController);

      const requestPayload: Record<string, unknown> = {
        input: inputs,
        model: this.model,
        output_dimension: this.dimension,
      };
      if (options.kind === "query") {
        requestPayload.input_type = "query";
      } else if (options.kind === "document") {
        requestPayload.input_type = "document";
      }

      const requestBody = JSON.stringify(requestPayload);
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        this.throwIfInterrupted(options, deadlineController);
        if (!this.authorizeRequest) {
          throw new EmbeddingProviderError(
            "REMOTE_AUTHORIZATION_REQUIRED",
            "Remote embedding request authorization is not configured.",
          );
        }
        try {
          await awaitWithSignal(this.authorizeRequest({
            fingerprint: options.identityFingerprint,
            purpose: options.purpose,
            kind: options.kind,
            attempt,
            buildLease: options.buildLease,
          }), signal);
        } catch (error) {
          this.throwIfInterrupted(options, deadlineController);
          throw error;
        }
        this.throwIfInterrupted(options, deadlineController);

        const requestController = new AbortController();
        const requestTimer = setTimeout(() => requestController.abort(), this.requestTimeoutMs);
        const requestSignal = AbortSignal.any([signal, requestController.signal]);
        let response: Response | null = null;
        let responseBodyConsumed = false;
        try {
          try {
            response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
              method: "POST",
              headers: {
                ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                "content-type": "application/json",
              },
              body: requestBody,
              signal: requestSignal,
            });
          } catch {
            this.throwIfInterrupted(options, deadlineController);
          }
          this.throwIfInterrupted(options, deadlineController);
          if (requestController.signal.aborted) response = null;

          if (response?.ok) {
            let body: unknown;
            let bodyRead = false;
            try {
              body = await response.json();
              bodyRead = true;
              responseBodyConsumed = true;
            } catch (error) {
              this.throwIfInterrupted(options, deadlineController);
              if (!requestController.signal.aborted && error instanceof SyntaxError) {
                throw new EmbeddingProviderError(
                  "PROVIDER_FAILURE",
                  "Voyage AI embedding response is not valid JSON.",
                );
              }
              response = null;
            }
            this.throwIfInterrupted(options, deadlineController);
            if (requestController.signal.aborted) response = null;
            if (bodyRead && response) {
              const parsed = parseResponse(
                body,
                inputs.length,
                batchUpperBound,
                this.model,
                this.dimension,
              );
              const usage = Object.freeze({
                promptTokens: parsed.usage.prompt_tokens ?? parsed.usage.total_tokens,
                totalTokens: parsed.usage.total_tokens,
              });
              return parsed.data.map(item => ({
                vector: item.embedding,
                model: parsed.model,
                dimension: item.embedding.length,
                usage,
              }));
            }
          }
        } finally {
          clearTimeout(requestTimer);
          if (response && !responseBodyConsumed) {
            try {
              await response.body?.cancel();
            } catch {
              // Best-effort body cancellation
            }
          }
        }

        this.throwIfInterrupted(options, deadlineController);
        if (attempt === this.maxAttempts) {
          throw new EmbeddingProviderError(
            "PROVIDER_FAILURE",
            `Voyage AI embedding request failed after ${this.maxAttempts} attempts.`,
          );
        }

        const retryAfterMs = response ? parseRetryAfter(response.headers.get("retry-after"), this.now()) : null;
        const delayMs = this.computeRetryDelay(attempt, retryAfterMs);
        if (options.deadline !== undefined && this.now() + delayMs >= options.deadline) {
          throw new EmbeddingProviderError("DEADLINE_EXCEEDED", "Embedding operation deadline was exceeded.");
        }
        await this.sleep(delayMs, signal);
      }

      throw new EmbeddingProviderError("PROVIDER_FAILURE", "Voyage AI embedding request failed.");
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (releaseRequestSlot) releaseRequestSlot();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closeController.abort();
    this.closePromise = (async () => {
      try {
        await this.requestTail;
      } finally {
        this.closed = true;
      }
    })();
    return this.closePromise;
  }
}
