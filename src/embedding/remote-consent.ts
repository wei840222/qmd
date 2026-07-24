import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import {
  createEmbeddingIdentity,
  type EmbeddingIdentity,
} from "./identity.js";
import {
  REMOTE_CAPABILITY_PROBE_SENTINEL,
  type EmbeddingProvider,
} from "./provider.js";
import { chunkRemoteDocumentByUtf8Bytes } from "./remote-chunking.js";
import {
  canonicalEmbeddingBuildMaterial,
  extractTitle,
  getPendingEmbeddingDocsReadOnly,
} from "../store.js";

export const REMOTE_EMBEDDING_POLICY_VERSION = "qmd-remote-embedding-v2";
export { REMOTE_CAPABILITY_PROBE_SENTINEL };
export const OPENAI_EMBEDDING_PRICING = Object.freeze({
  version: "openai-text-embedding-3-small-2026-07-23",
  model: "text-embedding-3-small",
  usdPerMillionInputTokens: 0.02,
  checkedAt: "2026-07-23",
  source: "https://platform.openai.com/api/pricing",
});
export type RemoteConsentSurface = "cli" | "sdk" | "mcp";
export type RemoteEmbeddingPurpose = "index-build" | "query-embedding" | "capability-probe";
export type RemoteConsentErrorCode =
  | "REMOTE_PROVIDER_REQUIRED"
  | "PREFLIGHT_MISMATCH"
  | "DOCUMENT_GENERATION_CHANGED"
  | "CONSENT_REQUIRED"
  | "INDEX_NOT_READY"
  | "PURPOSE_NOT_ALLOWED";

export class RemoteEmbeddingConsentError extends Error {
  readonly code: RemoteConsentErrorCode;

  constructor(code: RemoteConsentErrorCode, message: string) {
    super(message);
    this.name = "RemoteEmbeddingConsentError";
    this.code = code;
  }
}

export interface RemoteEmbeddingPreflight {
  readonly preflightId: string;
  readonly policyVersion: string;
  readonly fingerprint: string;
  readonly providerId: string;
  readonly model: string;
  readonly dimension: number;
  readonly scope: "all_collections";
  readonly documentGeneration: number;
  readonly pendingDocuments: number;
  readonly inputTokenUpperBound: number;
  readonly costUpperBoundUsd: number;
  readonly estimateKind: "conservative_utf8_bytes";
  readonly costScope: "pending_document_build_only";
  readonly dataDisclosure: readonly [
    "capability_probe_sentinel_sent_to_remote_provider",
    "document_chunks_sent_to_remote_provider",
    "document_titles_sent_to_remote_provider",
    "search_queries_sent_to_remote_provider",
  ];
  readonly pricing: typeof OPENAI_EMBEDDING_PRICING;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RemoteEmbeddingProbeResult {
  dimension: number;
  fingerprint: string;
  requested: boolean;
}

function mutationHead(db: Database): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) AS seq
    FROM cjk_index_mutations
  `).get() as { seq: number };
  return Number(row.seq);
}

export function ensureRemoteEmbeddingConsentSchema(db: Database): void {
  const existing = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'remote_embedding_consents'
  `).get();
  if (existing != null) {
    const columns = db.prepare(`PRAGMA table_info(remote_embedding_consents)`).all() as { name: string }[];
    const expected = ["fingerprint", "policy_version", "accepted_at", "surface"];
    if (columns.length === expected.length
      && expected.every(name => columns.some(column => column.name === name))) {
      return;
    }
    // Consent schema is fail-closed: discard obsolete acknowledgements rather
    // than retaining metadata outside the current allowlist.
    db.exec("DROP TABLE remote_embedding_consents");
  }
  db.exec(`
    CREATE TABLE remote_embedding_consents (
      fingerprint TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      surface TEXT NOT NULL CHECK (surface IN ('cli', 'sdk', 'mcp')),
      PRIMARY KEY (fingerprint, policy_version)
    );
  `);
}

function consentFingerprint(identityFingerprint: string, documentGeneration: number): string {
  return `${identityFingerprint}:${documentGeneration}`;
}

export function remoteEmbeddingIdentity(
  provider: EmbeddingProvider,
  chunkStrategy: "regex" | "auto" = "regex",
): EmbeddingIdentity {
  if (!provider.remote) {
    throw new RemoteEmbeddingConsentError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote embedding consent applies only to remote providers.",
    );
  }
  const dimension = provider.dimension;
  if (dimension === null || dimension < 1) {
    throw new RemoteEmbeddingConsentError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote preflight requires a known provider dimension or a completed dimension probe.",
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

export async function probeRemoteEmbeddingDimension(
  db: Database,
  provider: EmbeddingProvider,
  options?: { chunkStrategy?: "regex" | "auto" },
): Promise<RemoteEmbeddingProbeResult> {
  if (!provider.remote) {
    throw new RemoteEmbeddingConsentError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote dimension probe requires a remote provider.",
    );
  }
  const identity = remoteEmbeddingIdentity(provider, options?.chunkStrategy);
  authorizeRemoteEmbeddingPurpose(db, identity, "capability-probe");
  const vector = await provider.embed(REMOTE_CAPABILITY_PROBE_SENTINEL, {
    purpose: "capability-probe",
    kind: "document",
    identityFingerprint: identity.fingerprint,
  });
  const dimension = vector.vector.length;
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new RemoteEmbeddingConsentError(
      "REMOTE_PROVIDER_REQUIRED",
      "Remote dimension probe returned an empty vector.",
    );
  }
  if (dimension !== identity.dimension || vector.dimension !== identity.dimension) {
    throw new RemoteEmbeddingConsentError(
      "REMOTE_PROVIDER_REQUIRED",
      `Remote capability probe returned dimension ${dimension}; expected ${identity.dimension}.`,
    );
  }
  return { dimension, fingerprint: identity.fingerprint, requested: true };
}

export function createRemoteEmbeddingPreflight(
  db: Database,
  provider: EmbeddingProvider,
  options: {
    now?: number;
    chunkStrategy?: "regex" | "auto";
  } = {},
): RemoteEmbeddingPreflight {
  const identity = remoteEmbeddingIdentity(provider, options.chunkStrategy);
  const pending = getPendingEmbeddingDocsReadOnly(
    db,
    undefined,
    identity.model,
    identity.fingerprint,
  );
  const selectContent = db.prepare(`SELECT doc FROM content WHERE hash = ?`);
  let inputTokenUpperBound = 0;
  for (const document of pending) {
    const row = selectContent.get(document.hash) as { doc: string } | undefined;
    if (!row || !row.doc.trim()) continue;
    const title = extractTitle(row.doc, document.path);
    for (const chunk of chunkRemoteDocumentByUtf8Bytes(row.doc, title)) {
      inputTokenUpperBound += chunk.tokenUpperBound;
    }
  }

  const now = options.now ?? Date.now();
  const preflightPayload = {
    policyVersion: REMOTE_EMBEDDING_POLICY_VERSION,
    fingerprint: identity.fingerprint,
    providerId: identity.providerId,
    model: identity.model,
    dimension: identity.dimension,
    scope: "all_collections",
    documentGeneration: mutationHead(db),
    pendingDocuments: pending.length,
    inputTokenUpperBound,
    costUpperBoundUsd:
      inputTokenUpperBound * OPENAI_EMBEDDING_PRICING.usdPerMillionInputTokens / 1_000_000,
    estimateKind: "conservative_utf8_bytes",
    costScope: "pending_document_build_only",
    dataDisclosure: [
      "capability_probe_sentinel_sent_to_remote_provider",
      "document_chunks_sent_to_remote_provider",
      "document_titles_sent_to_remote_provider",
      "search_queries_sent_to_remote_provider",
    ] as const,
    pricing: OPENAI_EMBEDDING_PRICING,
  } as const;
  const preflightId = createHash("sha256")
    .update(JSON.stringify(preflightPayload))
    .digest("hex");
  return Object.freeze({
    preflightId,
    ...preflightPayload,
    createdAt: now,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
}

export function acceptRemoteEmbeddingPreflight(
  db: Database,
  provider: EmbeddingProvider,
  input: {
    preflightId: string;
    fingerprint: string;
    policyVersion: string;
    surface: RemoteConsentSurface;
    now?: number;
  },
): void {
  ensureRemoteEmbeddingConsentSchema(db);
  const now = input.now ?? Date.now();
  db.transaction(() => {
    const current = (["regex", "auto"] as const)
      .map(chunkStrategy => createRemoteEmbeddingPreflight(db, provider, { now, chunkStrategy }))
      .find(preflight => preflight.fingerprint === input.fingerprint);
    if (!current
      || current.preflightId !== input.preflightId
      || current.fingerprint !== input.fingerprint
      || current.policyVersion !== input.policyVersion) {
      throw new RemoteEmbeddingConsentError(
        "PREFLIGHT_MISMATCH",
        "Remote embedding acknowledgement does not match the exact preflight fingerprint and policy.",
      );
    }
    db.prepare(`
      INSERT INTO remote_embedding_consents
        (fingerprint, policy_version, accepted_at, surface)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(fingerprint, policy_version) DO UPDATE SET
        accepted_at = excluded.accepted_at,
        surface = excluded.surface
    `).run(
      consentFingerprint(current.fingerprint, current.documentGeneration),
      current.policyVersion,
      now,
      input.surface,
    );
  })();
}

export function hasRemoteEmbeddingConsent(
  db: Database,
  fingerprint: string,
  policyVersion = REMOTE_EMBEDDING_POLICY_VERSION,
): boolean {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'remote_embedding_consents'
  `).get();
  if (table == null) return false;
  const row = db.prepare(`
    SELECT 1
    FROM remote_embedding_consents
    WHERE fingerprint = ? AND policy_version = ?
  `).get(
    consentFingerprint(fingerprint, mutationHead(db)),
    policyVersion,
  );
  return row != null;
}

export function authorizeRemoteEmbeddingPurpose(
  db: Database,
  identity: EmbeddingIdentity,
  purpose: RemoteEmbeddingPurpose,
  context: {
    lease?: import("./identity.js").EmbeddingBuildLease;
    requestFingerprint?: string;
    now?: number;
  } = {},
): void {
  if (!identity.remote) {
    throw new RemoteEmbeddingConsentError(
      "PURPOSE_NOT_ALLOWED",
      "Remote embedding requests require a remote embedding identity.",
    );
  }
  if (purpose !== "capability-probe"
    && purpose !== "index-build"
    && purpose !== "query-embedding") {
    throw new RemoteEmbeddingConsentError(
      "PURPOSE_NOT_ALLOWED",
      "Remote embedding request purpose is not allowed.",
    );
  }
  if (context.requestFingerprint !== undefined
    && context.requestFingerprint !== identity.fingerprint) {
    throw new RemoteEmbeddingConsentError(
      "CONSENT_REQUIRED",
      "Remote request fingerprint does not match the active embedding identity.",
    );
  }
  if (!hasRemoteEmbeddingConsent(db, identity.fingerprint)) {
    const consentTable = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'remote_embedding_consents'
    `).get();
    const accepted = consentTable == null
      ? undefined
      : db.prepare(`
          SELECT 1
          FROM remote_embedding_consents
          WHERE fingerprint LIKE ? AND policy_version = ?
          LIMIT 1
        `).get(`${identity.fingerprint}:%`, REMOTE_EMBEDDING_POLICY_VERSION);
    if (accepted) {
      throw new RemoteEmbeddingConsentError(
        "DOCUMENT_GENERATION_CHANGED",
        "Documents changed after remote embedding acknowledgement; run preflight and acknowledge again.",
      );
    }
    throw new RemoteEmbeddingConsentError(
      "CONSENT_REQUIRED",
      "Remote embedding requires acknowledgement of the exact current preflight.",
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
      throw new RemoteEmbeddingConsentError(
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
    throw new RemoteEmbeddingConsentError(
      "INDEX_NOT_READY",
      "Remote query embedding requires a ready compatible identity with queryable vector rows.",
    );
  }
}
