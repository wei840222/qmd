import type { EmbeddingBuildLease } from "./identity.js";

export type EmbeddingInputKind = "query" | "document";
export type EmbeddingRequestPurpose = "capability-probe" | "index-build" | "query-embedding";
export const REMOTE_CAPABILITY_PROBE_SENTINEL = "qmd-remote-capability-probe-v1";

export type EmbeddingProviderErrorCode =
  | "PROVIDER_CLOSED"
  | "OPERATION_ABORTED"
  | "DEADLINE_EXCEEDED"
  | "PROVIDER_FAILURE"
  | "MISSING_EMBEDDING"
  | "EMPTY_VECTOR"
  | "NON_FINITE_VECTOR"
  | "MODEL_MISMATCH"
  | "DIMENSION_UNKNOWN"
  | "DIMENSION_MISMATCH"
  | "BATCH_CARDINALITY_MISMATCH"
  | "INPUT_BUDGET_EXCEEDED"
  | "RESPONSE_SCHEMA_INVALID"
  | "HTTP_TERMINAL"
  | "RETRY_EXHAUSTED"
  | "IDENTITY_FINGERPRINT_REQUIRED"
  | "REMOTE_AUTHORIZATION_REQUIRED";

export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingProviderErrorCode;
  readonly operation?: "embed" | "embedBatch";
  readonly index?: number;
  /** Native causes are intentionally discarded so provider errors are safe to serialize. */
  override readonly cause: undefined;

  constructor(
    code: EmbeddingProviderErrorCode,
    message: string,
    options: {
      operation?: "embed" | "embedBatch";
      index?: number;
    } = {},
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.code = code;
    this.operation = options.operation;
    this.index = options.index;
    this.cause = undefined;
  }
}

export interface EmbeddingOperationOptions {
  /** Required purpose used by remote policy guards and request auditing. */
  purpose: EmbeddingRequestPurpose;
  /** Whether the caller formatted the input as a query or document. */
  kind?: EmbeddingInputKind;
  /** Cancels the caller's wait for this operation. */
  signal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds after which the operation must fail. */
  deadline?: number;
  /** Complete active build lease required for remote index-build requests. */
  buildLease?: EmbeddingBuildLease;
  /** Full published/build identity fingerprint, including chunking policy. */
  identityFingerprint: string;
}

export interface RemoteEmbeddingRequestAuthorization {
  readonly fingerprint: string;
  readonly purpose: EmbeddingRequestPurpose;
  readonly kind?: EmbeddingInputKind;
  readonly attempt: number;
  readonly buildLease?: EmbeddingBuildLease;
}

export type RemoteEmbeddingRequestGuard = (
  request: RemoteEmbeddingRequestAuthorization,
) => void | Promise<void>;

export interface EmbeddingVector {
  vector: number[];
  model: string;
  dimension: number;
  /** Provider-reported numeric usage for this operation, when available. */
  readonly usage?: Readonly<{
    promptTokens: number;
    totalTokens: number;
  }>;
}

export interface EmbeddingProvider {
  readonly providerId: string;
  readonly model: string;
  readonly dimension: number | null;
  readonly remote: boolean;

  canonicalIdentityMaterial(): string;
  /** Compute identity material from a persisted dimension without loading the model. */
  canonicalIdentityMaterialForDimension?(dimension: number): string;
  formatQuery(query: string): string;
  formatDocument(text: string, title?: string): string;
  embed(text: string, options: EmbeddingOperationOptions): Promise<EmbeddingVector>;
  embedBatch(texts: string[], options: EmbeddingOperationOptions): Promise<EmbeddingVector[]>;
  estimateTokens?(text: string): number;
  close(): Promise<void>;
}

/** Owns a provider and every resource needed to service it. */
export interface EmbeddingProviderOwner {
  readonly provider: EmbeddingProvider;
  close(): Promise<void>;
}
