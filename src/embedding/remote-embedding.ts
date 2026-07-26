import type { Database } from "../db.js";
import { canonicalEmbeddingBuildMaterial } from "../store.js";
import {
  createEmbeddingIdentity,
  type EmbeddingBuildLease,
  type EmbeddingIdentity,
} from "./identity.js";
import type { EmbeddingProvider } from "./provider.js";

export type RemoteEmbeddingPurpose = "index-build" | "query-embedding" | "capability-probe";
export type RemoteEmbeddingAuthorizationErrorCode =
  | "REMOTE_PROVIDER_REQUIRED"
  | "REQUEST_FINGERPRINT_MISMATCH"
  | "INDEX_NOT_READY"
  | "PURPOSE_NOT_ALLOWED";

export class RemoteEmbeddingAuthorizationError extends Error {
  readonly code: RemoteEmbeddingAuthorizationErrorCode;

  constructor(code: RemoteEmbeddingAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "RemoteEmbeddingAuthorizationError";
    this.code = code;
  }
}


export function remoteEmbeddingIdentity(
  provider: EmbeddingProvider,
  chunkStrategy: "regex" | "auto" = "regex",
): EmbeddingIdentity {
  if (!provider.remote) {
    throw new RemoteEmbeddingAuthorizationError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote embedding requires a remote provider.",
    );
  }
  const dimension = provider.dimension;
  if (dimension === null || dimension < 1) {
    throw new RemoteEmbeddingAuthorizationError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote embedding requires a known provider dimension or a completed dimension probe.",
    );
  }
  return createEmbeddingIdentity({
    providerId: provider.providerId,
    model: provider.model,
    dimension,
    remote: true,
    canonicalMaterial: canonicalEmbeddingBuildMaterial(
      provider.canonicalIdentityMaterial(),
      chunkStrategy,
    ),
  });
}

export function authorizeRemoteEmbeddingRequest(
  db: Database,
  identity: EmbeddingIdentity,
  purpose: RemoteEmbeddingPurpose,
  context: {
    lease?: EmbeddingBuildLease;
    requestFingerprint?: string;
    now?: number;
  } = {},
): void {
  if (!identity.remote) {
    throw new RemoteEmbeddingAuthorizationError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote embedding requests require a remote embedding identity.",
    );
  }
  if (purpose !== "capability-probe"
    && purpose !== "index-build"
    && purpose !== "query-embedding") {
    throw new RemoteEmbeddingAuthorizationError(
      "PURPOSE_NOT_ALLOWED",
      "Remote embedding request purpose is not allowed.",
    );
  }
  if (context.requestFingerprint !== undefined
    && context.requestFingerprint !== identity.fingerprint) {
    throw new RemoteEmbeddingAuthorizationError(
      "REQUEST_FINGERPRINT_MISMATCH",
      "Remote request fingerprint does not match the active embedding identity.",
    );
  }
  if (purpose === "capability-probe") return;

  const state = db.prepare(`
    SELECT status, fingerprint, generation, lease_owner, lease_expires_at
    FROM embedding_index_state
    WHERE singleton = 1
  `).get() as {
    status: string;
    fingerprint: string;
    generation: number;
    lease_owner: string | null;
    lease_expires_at: number | null;
  } | undefined;
  if (purpose === "index-build") {
    const now = context.now ?? Date.now();
    if (!context.lease
      || state?.status !== "building"
      || state.fingerprint !== identity.fingerprint
      || state.generation !== context.lease.generation
      || state.lease_owner !== context.lease.ownerId
      || context.lease.fingerprint !== identity.fingerprint
      || state.lease_expires_at == null
      || state.lease_expires_at !== context.lease.leaseExpiresAt
      || state.lease_expires_at <= now) {
      throw new RemoteEmbeddingAuthorizationError(
        "PURPOSE_NOT_ALLOWED",
        "Remote index embedding requires the active compatible build lease owner.",
      );
    }
    return;
  }

  const vectorTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'
  `).get();
  const hasQueryableRow = vectorTable == null ? false : db.prepare(`
    SELECT 1
    FROM content_vectors cv
    JOIN vectors_vec vv ON vv.hash_seq = cv.hash || '_' || cv.seq
    WHERE cv.model = ? AND cv.embed_fingerprint = ?
    LIMIT 1
  `).get(identity.model, identity.fingerprint) != null;
  if (state?.status !== "ready"
    || state.fingerprint !== identity.fingerprint
    || !hasQueryableRow) {
    throw new RemoteEmbeddingAuthorizationError(
      "INDEX_NOT_READY",
      "Remote query embedding requires a ready compatible identity with queryable vector rows.",
    );
  }
}
