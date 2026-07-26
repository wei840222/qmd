import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { createEmbeddingIdentity, type EmbeddingIdentity } from "./embedding/identity.js";
import { canonicalLocalEmbeddingIdentityMaterial } from "./embedding/local-identity.js";
import { canonicalOpenAIEmbeddingIdentityMaterial } from "./embedding/openai.js";
import type { OpenAIEmbeddingModel } from "./embedding/config.js";

import { getCjkAnalyzerFingerprint } from "./search/cjk-index.js";
import { canonicalEmbeddingBuildMaterial } from "./store.js";

export type DiagnosticReadiness =
  | "missing"
  | "ready"
  | "stale"
  | "partial"
  | "inconsistent"
  | "incompatible";

export interface EmbeddingDiagnostics {
  provider: {
    id: string | null;
    remote: boolean;
    model: string;
    dimension: number | null;
    keyConfigured: boolean;
  };
  identity: {
    shortFingerprint: string | null;
    fullFingerprint: string | null;
    storedShortFingerprint: string | null;
    storedFullFingerprint: string | null;
    compatible: boolean;
  };
  build: {
    state: "missing" | "empty" | "building" | "ready" | "partial" | "incompatible";
    generation: number | null;
    leaseExpiresAt: number | null;
  };
  chunks: {
    pendingDocuments: number;
    metadataOnly: number;
    vectorOnly: number;
    incompleteLayouts: number;
  };

  repairCommand: string | null;
}

export interface LexicalDiagnostics {
  jiebaCapability: "unknown" | "available" | "unavailable";
  analyzerFingerprint: string;
  storedAnalyzerFingerprint: string | null;
  state: "missing" | "empty" | "building" | "ready" | "unavailable" | "dirty";
  channels: {
    char: DiagnosticReadiness;
    word: DiagnosticReadiness;
    bigram: DiagnosticReadiness;
  };
  dirtySinceMutationSeq: number | null;
  rebuildReason: string | null;
  repairCommand: string | null;
}

export interface IndexDiagnostics {
  embedding: EmbeddingDiagnostics;
  lexical: LexicalDiagnostics;
}

export interface ConfiguredEmbeddingProviderDiagnostics {
  id: string;
  remote: boolean;
  model: string;
  dimension: number | null;
}

interface StoredEmbeddingRow {
  fingerprint: string;
  provider_id: string;
  model: string;
  dimension: number;
  remote: number;
  status: "building" | "ready";
  generation: number;
  lease_expires_at: number | null;
}

interface CjkStateRow {
  status: "empty" | "building" | "ready" | "unavailable" | "dirty";
  analyzer_fingerprint: string | null;
  word_capability: "unknown" | "available" | "unavailable";
  diagnostic_code: string | null;
  dirty_since_mutation_seq: number | null;
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?
  `).get(name) != null;
}

function tableColumns(db: Database, name: string): Set<string> {
  if (!tableExists(db, name)) return new Set();
  return new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[])
    .map(column => column.name));
}

function countRows(db: Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
    return Number(row.count);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (table === "vectors_vec" && /no such module:\s*vec0/i.test(message)) return null;
    throw error;
  }
}

function activeDocumentCount(db: Database): number {
  if (!tableExists(db, "documents")) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE active = 1`).get() as { count: number };
  return Number(row.count);
}

function shortFingerprint(value: string | null): string | null {
  return value == null ? null : value.slice(0, 12);
}

function resolvedIdentity(
  provider: EmbeddingProvider | undefined,
  configured: ConfiguredEmbeddingProviderDiagnostics | undefined,
  stored: StoredEmbeddingRow | undefined,
): EmbeddingIdentity | undefined {
  const providerId = provider?.providerId ?? configured?.id;
  const model = provider?.model ?? configured?.model;
  const remote = provider?.remote ?? configured?.remote;
  if (providerId == null || model == null || remote == null) return undefined;
  const storedMatches = stored?.provider_id === providerId && stored.model === model;
  const dimension = provider?.dimension ?? configured?.dimension
    ?? (storedMatches ? Number(stored.dimension) : null);
  if (dimension == null) return undefined;
  try {
    const providerMaterial = provider
      ? provider.canonicalIdentityMaterialForDimension?.(dimension)
        ?? provider.canonicalIdentityMaterial()
      : providerId === "local-llama-cpp"
        ? canonicalLocalEmbeddingIdentityMaterial(model, dimension)
        : providerId === "openai"
          ? canonicalOpenAIEmbeddingIdentityMaterial(model as OpenAIEmbeddingModel, dimension)
          : undefined;
    if (providerMaterial == null) return undefined;
    const identities = (["regex", "auto"] as const).map(chunkStrategy =>
      createEmbeddingIdentity({
        providerId,
        model,
        dimension,
        remote,
        canonicalMaterial: canonicalEmbeddingBuildMaterial(providerMaterial, chunkStrategy),
      }));
    return identities.find(identity => identity.fingerprint === stored?.fingerprint)
      ?? identities[0];
  } catch {
    return undefined;
  }
}

function inspectEmbeddingDiagnostics(
  db: Database,
  fallbackModel: string,
  provider: EmbeddingProvider | undefined,
  keyConfigured: boolean,
  configured: ConfiguredEmbeddingProviderDiagnostics | undefined,
): EmbeddingDiagnostics {
  const stateColumns = tableColumns(db, "embedding_index_state");
  const stored = stateColumns.has("fingerprint")
    ? db.prepare(`
        SELECT fingerprint, provider_id, model, dimension, remote, status,
               generation, lease_expires_at
        FROM embedding_index_state WHERE singleton = 1
      `).get() as StoredEmbeddingRow | undefined
    : undefined;
  const expected = resolvedIdentity(provider, configured, stored);
  const model = provider?.model ?? configured?.model ?? stored?.model ?? fallbackModel;
  const fingerprint = expected?.fingerprint
    ?? (stored != null
      && stored.provider_id === provider?.providerId
      && stored.model === model
      ? stored.fingerprint
      : null);
  const activeDocs = activeDocumentCount(db);
  const metadataColumns = tableColumns(db, "content_vectors");
  const hasMetadata = metadataColumns.has("hash") && metadataColumns.has("seq");
  const hasFingerprint = metadataColumns.has("embed_fingerprint");
  const hasLayouts = metadataColumns.has("total_chunks");
  const hasVectors = tableExists(db, "vectors_vec");
  const vectorChunkCount = countRows(db, "vectors_vec");
  const vectorsReadable = vectorChunkCount != null;
  const hasEmbeddingRows = (countRows(db, "content_vectors") ?? 0) > 0
    || (vectorChunkCount ?? 0) > 0;

  let metadataOnly = 0;
  let vectorOnly = 0;
  let incompleteLayouts = 0;
  let pendingDocuments = activeDocs;
  if (hasMetadata) {
    if (vectorsReadable) {
      metadataOnly = Number((db.prepare(`
        SELECT COUNT(*) AS count
        FROM content_vectors cv
        LEFT JOIN vectors_vec vv ON vv.hash_seq = cv.hash || '_' || cv.seq
        WHERE vv.hash_seq IS NULL
      `).get() as { count: number }).count);
      vectorOnly = Number((db.prepare(`
        SELECT COUNT(*) AS count
        FROM vectors_vec vv
        LEFT JOIN content_vectors cv ON vv.hash_seq = cv.hash || '_' || cv.seq
        WHERE cv.hash IS NULL
      `).get() as { count: number }).count);
    }
    if (hasLayouts) {
      incompleteLayouts = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT hash, model
          FROM content_vectors
          GROUP BY hash, model, embed_fingerprint
          HAVING COUNT(*) <> MAX(total_chunks)
        )
      `).get() as { count: number }).count);
    }
    if (fingerprint != null && hasFingerprint && hasLayouts) {
      pendingDocuments = Number((db.prepare(`
        SELECT COUNT(*) AS count
        FROM documents d
        LEFT JOIN (
          SELECT cv.hash
          FROM content_vectors cv
          ${vectorsReadable ? "JOIN vectors_vec vv ON vv.hash_seq = cv.hash || '_' || cv.seq" : ""}
          WHERE cv.model = ? AND cv.embed_fingerprint = ?
          GROUP BY cv.hash
          HAVING COUNT(*) = MAX(cv.total_chunks)
        ) complete ON complete.hash = d.hash
        WHERE d.active = 1 AND complete.hash IS NULL
      `).get(model, fingerprint) as { count: number }).count);
    }
  }

  const compatible = stored != null && fingerprint != null && stored.fingerprint === fingerprint;
  let buildState: EmbeddingDiagnostics["build"]["state"];
  if (!tableExists(db, "embedding_index_state")) {
    buildState = hasEmbeddingRows ? "incompatible" : "missing";
  } else if (!stored) {
    buildState = hasEmbeddingRows ? "incompatible" : "empty";
  } else if (!compatible) {
    buildState = "incompatible";
  } else if (stored.status === "building") {
    buildState = stored.lease_expires_at != null && stored.lease_expires_at > Date.now()
      ? "building"
      : "partial";
  } else if (metadataOnly > 0 || vectorOnly > 0 || incompleteLayouts > 0 || pendingDocuments > 0) {
    buildState = "partial";
  } else {
    buildState = "ready";
  }

  const effectiveRemote = provider?.remote ?? configured?.remote ?? false;

  return {
    provider: {
      id: provider?.providerId ?? configured?.id ?? stored?.provider_id ?? null,
      remote: provider?.remote ?? configured?.remote ?? stored?.remote === 1,
      model,
      dimension: provider?.dimension ?? configured?.dimension ?? (stored ? Number(stored.dimension) : null),
      keyConfigured: (provider?.remote ?? configured?.remote) === true && keyConfigured,
    },
    identity: {
      shortFingerprint: shortFingerprint(fingerprint),
      fullFingerprint: fingerprint,
      storedShortFingerprint: shortFingerprint(stored?.fingerprint ?? null),
      storedFullFingerprint: stored?.fingerprint ?? null,
      compatible,
    },
    build: {
      state: buildState,
      generation: stored ? Number(stored.generation) : null,
      leaseExpiresAt: stored?.lease_expires_at == null ? null : Number(stored.lease_expires_at),
    },
    chunks: { pendingDocuments, metadataOnly, vectorOnly, incompleteLayouts },
    repairCommand: buildState === "ready" || buildState === "empty" ? null : effectiveRemote
      ? "qmd embed --force"
      : "qmd embed --force",
  };
}

function channelReadiness(
  rowCount: number | null,
  activeDocs: number,
  state: CjkStateRow | undefined,
  fingerprintMatches: boolean,
  wordChannel: boolean,
): DiagnosticReadiness {
  if (rowCount == null) return "missing";
  if (wordChannel && state?.word_capability === "unavailable") return "incompatible";
  if (wordChannel && (!fingerprintMatches || state?.status === "dirty")) return "stale";
  if (rowCount !== activeDocs) return "partial";
  return "ready";
}

function inspectLexicalDiagnostics(db: Database): LexicalDiagnostics {
  const activeDocs = activeDocumentCount(db);
  const currentFingerprint = getCjkAnalyzerFingerprint();
  const stateColumns = tableColumns(db, "cjk_index_state");
  const state = stateColumns.has("analyzer_fingerprint")
    ? db.prepare(`
        SELECT status, analyzer_fingerprint, word_capability, diagnostic_code,
               dirty_since_mutation_seq
        FROM cjk_index_state WHERE singleton = 1
      `).get() as CjkStateRow | undefined
    : undefined;
  const fingerprintMatches = activeDocs === 0
    || state?.analyzer_fingerprint === currentFingerprint;
  const channels = {
    char: channelReadiness(countRows(db, "documents_fts"), activeDocs, state, true, false),
    word: channelReadiness(countRows(db, "documents_fts_words"), activeDocs, state, fingerprintMatches, true),
    bigram: channelReadiness(countRows(db, "documents_fts_bigrams"), activeDocs, state, fingerprintMatches, true),
  };
  const rebuildReason = state?.status === "dirty"
    ? state.diagnostic_code ?? "dirty"
    : activeDocs === 0
      ? null
      : !state
        ? "schema-missing"
      : !fingerprintMatches
        ? "analyzer-fingerprint-mismatch"
        : Object.values(channels).some(channel => channel !== "ready")
          ? "channel-readiness-incomplete"
          : null;

  return {
    jiebaCapability: state?.word_capability ?? "unknown",
    analyzerFingerprint: currentFingerprint,
    storedAnalyzerFingerprint: state?.analyzer_fingerprint ?? null,
    state: state?.status ?? "missing",
    channels,
    dirtySinceMutationSeq: state?.dirty_since_mutation_seq == null
      ? null
      : Number(state.dirty_since_mutation_seq),
    rebuildReason,
    repairCommand: rebuildReason == null ? null : "qmd update",
  };
}

export function inspectIndexDiagnostics(
  db: Database,
  options: {
    fallbackModel: string;
    provider?: EmbeddingProvider;
    keyConfigured?: boolean;
    configuredProvider?: ConfiguredEmbeddingProviderDiagnostics;
  },
): IndexDiagnostics {
  return {
    embedding: inspectEmbeddingDiagnostics(
      db,
      options.fallbackModel,
      options.provider,
      options.keyConfigured === true,
      options.configuredProvider,
    ),
    lexical: inspectLexicalDiagnostics(db),
  };
}

export function diagnosticsSnapshotHash(diagnostics: IndexDiagnostics): string {
  return createHash("sha256").update(JSON.stringify(diagnostics)).digest("hex");
}
