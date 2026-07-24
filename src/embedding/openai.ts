import { createHash } from "node:crypto";
import {
  OPENAI_EMBEDDING_DIMENSION,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_EMBEDDING_MODELS,
  DEFAULT_OPENAI_BASE_URL,
  type OpenAIEmbeddingModel,
} from "./config.js";
import {
  EmbeddingProviderError,
  REMOTE_CAPABILITY_PROBE_SENTINEL,
  type EmbeddingOperationOptions,
  type EmbeddingProvider,
  type RemoteEmbeddingRequestGuard,
  type EmbeddingVector,
} from "./provider.js";
import { canonicalRemoteChunkProfile } from "./remote-chunking.js";

const MAX_INPUTS_PER_REQUEST = 128;
const MAX_INPUT_TOKEN_UPPER_BOUND = 8_192;
const MAX_BATCH_TOKEN_UPPER_BOUND = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const utf8Encoder = new TextEncoder();

function normalizeOpenAIBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
}

function endpointFingerprint(baseUrl: string): string | undefined {
  if (baseUrl === DEFAULT_OPENAI_BASE_URL) return undefined;
  return createHash("sha256").update(baseUrl).digest("hex");
}

export interface OpenAIEmbeddingUsage {
  readonly promptTokens: number;
  readonly totalTokens: number;
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  model?: OpenAIEmbeddingModel;
  dimension?: number;
  /** Override the base URL. Falls back to OPENAI_BASE_URL env or the official OpenAI endpoint. */
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

export function canonicalOpenAIEmbeddingIdentityMaterial(
  model: OpenAIEmbeddingModel = OPENAI_EMBEDDING_MODEL,
  dimension?: number,
  baseUrl: string | undefined = undefined,
): string {
  const expectedDimension = OPENAI_EMBEDDING_MODELS.get(model);
  const effectiveDimension = dimension ?? expectedDimension ?? OPENAI_EMBEDDING_DIMENSION;
  if (expectedDimension !== undefined && effectiveDimension !== expectedDimension) {
    throw new EmbeddingProviderError(
      "DIMENSION_MISMATCH",
      `OpenAI embedding dimension must be ${expectedDimension} for model ${model}.`,
    );
  }
  const endpoint = endpointFingerprint(normalizeOpenAIBaseUrl(baseUrl));
  return JSON.stringify({
    provider: "openai",
    model,
    dimension: effectiveDimension,
    remote: true,
    format: "qmd-openai-embedding-v1",
    chunking: canonicalRemoteChunkProfile(),
    ...(endpoint === undefined ? {} : { endpointFingerprint: endpoint }),
  });
}

export class UnavailableOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "openai";
  readonly model: OpenAIEmbeddingModel;
  readonly dimension: number;
  readonly remote = true;
  private readonly configuredBaseUrl: string | undefined;

  constructor(options?: { model?: OpenAIEmbeddingModel; dimension?: number; baseUrl?: string }) {
    this.model = options?.model ?? OPENAI_EMBEDDING_MODEL;
    this.dimension = options?.dimension ?? (OPENAI_EMBEDDING_MODELS.get(this.model) ?? OPENAI_EMBEDDING_DIMENSION);
    this.configuredBaseUrl = options?.baseUrl;
  }

  canonicalIdentityMaterial(): string {
    return canonicalOpenAIEmbeddingIdentityMaterial(this.model, this.dimension, this.configuredBaseUrl ?? process.env.OPENAI_BASE_URL);
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
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding provider is not available (missing API key or configuration).");
  }

  async embedBatch(
    _texts: string[],
    _options: EmbeddingOperationOptions,
  ): Promise<EmbeddingVector[]> {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding provider is not available (missing API key or configuration).");
  }

  async close(): Promise<void> {}
}

interface OpenAIEmbeddingResponse {
  object: "list";
  model: string;
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  usage: {
    prompt_tokens: number;
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
): OpenAIEmbeddingResponse {
  if (!isRecord(value) || value.object !== "list" || value.model !== OPENAI_EMBEDDING_MODEL) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding response schema is invalid.");
  }
  if (!isRecord(value.usage)) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding usage is invalid.");
  }
  const promptTokens = value.usage.prompt_tokens;
  const totalTokens = value.usage.total_tokens;
  if (
    !Number.isSafeInteger(promptTokens) || (promptTokens as number) < 0
    || !Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0
    || (totalTokens as number) < (promptTokens as number)
    || (promptTokens as number) > tokenUpperBound
    || (totalTokens as number) > tokenUpperBound
  ) {
    throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding usage is invalid.");
  }
  if (!Array.isArray(value.data) || value.data.length !== inputCount) {
    throw new EmbeddingProviderError("BATCH_CARDINALITY_MISMATCH", "OpenAI embedding response cardinality is invalid.");
  }

  const byIndex = new Array<OpenAIEmbeddingResponse["data"][number] | undefined>(inputCount);
  for (const item of value.data) {
    if (!isRecord(item) || item.object !== "embedding") {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding item schema is invalid.");
    }
    const index = item.index;
    const embedding = item.embedding;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= inputCount) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding response index is invalid.");
    }
    if (byIndex[index as number]) {
      throw new EmbeddingProviderError("RESPONSE_SCHEMA_INVALID", "OpenAI embedding response index is duplicated.");
    }
    if (
      !Array.isArray(embedding)
      || embedding.length !== OPENAI_EMBEDDING_DIMENSION
      || embedding.some(value => typeof value !== "number"
        || !Number.isFinite(value)
        || !Number.isFinite(Math.fround(value)))
    ) {
      throw new EmbeddingProviderError("DIMENSION_MISMATCH", "OpenAI embedding vector is invalid.");
    }
    byIndex[index as number] = {
      object: "embedding",
      index: index as number,
      embedding: embedding as number[],
    };
  }

  return {
    object: "list",
    model: OPENAI_EMBEDDING_MODEL,
    data: byIndex as OpenAIEmbeddingResponse["data"],
    usage: {
      prompt_tokens: promptTokens as number,
      total_tokens: totalTokens as number,
    },
  };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "openai";
  readonly model: OpenAIEmbeddingModel;
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

  constructor(options: OpenAIEmbeddingProviderOptions) {
    const apiKey = options.apiKey?.trim() || undefined;
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI maxAttempts must be between 1 and 3.");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI requestTimeoutMs must be positive.");
    }
    this.model = options.model ?? OPENAI_EMBEDDING_MODEL;
    this.dimension = options.dimension ?? (OPENAI_EMBEDDING_MODELS.get(this.model) ?? OPENAI_EMBEDDING_DIMENSION);
    this.apiKey = apiKey;
    this.baseUrl = normalizeOpenAIBaseUrl(options.baseUrl ?? process.env.OPENAI_BASE_URL);
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
    return canonicalOpenAIEmbeddingIdentityMaterial(this.model, dimension, this.baseUrl);
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

  private async acquireRequestSlot(signal: AbortSignal): Promise<() => void> {
    const previous = this.requestTail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.requestTail = previous.then(() => gate);
    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  async embed(text: string, options: EmbeddingOperationOptions): Promise<EmbeddingVector> {
    const results = await this.embedBatch([text], options);
    return results[0]!;
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
        "OpenAI embedding inputs must be strings.",
      );
    }
    const inputs = Object.freeze([...texts]);
    const validPurposeKindPair = (options.purpose === "capability-probe" && options.kind === "document")
      || (options.purpose === "index-build" && options.kind === "document")
      || (options.purpose === "query-embedding" && options.kind === "query");
    if (!validPurposeKindPair) {
      throw new EmbeddingProviderError(
        "REMOTE_AUTHORIZATION_REQUIRED",
        "Remote embedding request purpose does not match its input kind.",
      );
    }
    if (options.purpose === "capability-probe" && (
      inputs.length !== 1
      || inputs[0] !== REMOTE_CAPABILITY_PROBE_SENTINEL
    )) {
      throw new EmbeddingProviderError(
        "REMOTE_AUTHORIZATION_REQUIRED",
        "Remote capability probes must use the fixed versioned sentinel.",
      );
    }

    if (inputs.length === 0 || inputs.length > MAX_INPUTS_PER_REQUEST) {
      throw new EmbeddingProviderError(
        "INPUT_BUDGET_EXCEEDED",
        `OpenAI embedding batches must contain between 1 and ${MAX_INPUTS_PER_REQUEST} inputs.`,
      );
    }
    let batchUpperBound = 0;
    for (const text of inputs) {
      const upperBound = this.estimateTokens(text);
      if (upperBound === 0 || upperBound > MAX_INPUT_TOKEN_UPPER_BOUND) {
        throw new EmbeddingProviderError(
          "INPUT_BUDGET_EXCEEDED",
          `OpenAI embedding input exceeds the ${MAX_INPUT_TOKEN_UPPER_BOUND}-token upper bound.`,
        );
      }
      batchUpperBound += upperBound;
    }
    if (batchUpperBound > MAX_BATCH_TOKEN_UPPER_BOUND) {
      throw new EmbeddingProviderError(
        "INPUT_BUDGET_EXCEEDED",
        `OpenAI embedding batch exceeds the ${MAX_BATCH_TOKEN_UPPER_BOUND}-token upper bound.`,
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
      const requestBody = JSON.stringify({
        input: inputs,
        model: this.model,
        dimensions: this.dimension,
        encoding_format: "float",
      });
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
                  "OpenAI embedding response is not valid JSON.",
                );
              }
              response = null;
            }
            this.throwIfInterrupted(options, deadlineController);
            if (requestController.signal.aborted) response = null;
            if (bodyRead && response) {
              const parsed = parseResponse(body, inputs.length, batchUpperBound);
              const usage = Object.freeze({
                promptTokens: parsed.usage.prompt_tokens,
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
          if (response?.body && !responseBodyConsumed) {
            void response.body.cancel().catch(() => {});
          }
        }

        const status = response?.status;
        const transient = status === undefined || status === 408 || status === 429 || status >= 500;
        if (!transient) {
          throw new EmbeddingProviderError(
            "HTTP_TERMINAL",
            `OpenAI embedding request failed with HTTP ${status}.`,
          );
        }
        if (attempt === this.maxAttempts) {
          throw new EmbeddingProviderError(
            "RETRY_EXHAUSTED",
            "OpenAI embedding request exhausted its retry budget.",
          );
        }

        const retryAfter = response
          ? parseRetryAfter(response.headers.get("retry-after"), this.now())
          : null;
        const exponential = this.baseRetryDelayMs * (2 ** (attempt - 1));
        const jittered = exponential * (0.5 + (this.random() * 0.5));
        const delayMs = Math.min(retryAfter ?? jittered, this.maxRetryDelayMs);
        if (options.deadline !== undefined && this.now() + delayMs >= options.deadline) {
          throw new EmbeddingProviderError("DEADLINE_EXCEEDED", "Embedding operation deadline was exceeded.");
        }
        this.throwIfInterrupted(options, deadlineController);
        try {
          await this.sleep(delayMs, signal);
        } catch {
          this.throwIfInterrupted(options, deadlineController);
          throw new EmbeddingProviderError("PROVIDER_FAILURE", "OpenAI embedding retry delay failed.");
        }
        this.throwIfInterrupted(options, deadlineController);
      }
      throw new EmbeddingProviderError(
        "RETRY_EXHAUSTED",
        "OpenAI embedding request exhausted its retry budget.",
      );
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      releaseRequestSlot?.();
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closeController.abort();
      this.closePromise = this.requestTail;
    }
    await this.closePromise;
  }
}
