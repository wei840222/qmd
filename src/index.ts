/**
 * QMD SDK - Library mode for programmatic access to QMD search and indexing.
 *
 * Usage:
 *   import { createStore } from '@wei840222/qmd'
 *
 *   const store = await createStore({
 *     dbPath: './my-index.sqlite',
 *     config: {
 *       collections: {
 *         docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *       }
 *     }
 *   })
 *
 *   const results = await store.search({ query: "how does auth work?" })
 *   await store.close()
 */

import { existsSync } from "node:fs";

import {
  createStore as createStoreInternal,
  hybridQuery,
  structuredSearch,
  extractSnippet,
  addLineNumbers,
  DEFAULT_MULTI_GET_MAX_BYTES,
  reindexCollection,
  generateEmbeddings,
  listCollections as storeListCollections,
  syncConfigToDb,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  removeCollection as removeCollectionWithDocuments,
  renameCollection as renameCollectionWithDocuments,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  vacuumDatabase,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteLLMCache,
  deleteInactiveDocuments,
  clearAllEmbeddings,
  getPendingEmbeddingDocsReadOnly,
  getIndexHealthReadOnly,
  getStatusReadOnly,
  type Store as InternalStore,
  type DocumentResult,
  type DocumentNotFound,
  type DocumentExcludedByIgnore,
  type DocumentLookupError,
  type SearchResult,
  type HybridQueryResult,
  type HybridQueryOptions,
  type HybridQueryExplain,
  type ExpandedQuery,
  type StructuredSearchOptions,
  type MultiGetResult,
  type IndexStatus,
  type IndexHealthInfo,
  type SearchHooks,
  type ReindexProgress,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
  type ChunkStrategy,
} from "./store.js";
import {
  DEFAULT_EMBED_MODEL_URI,
  LlamaCpp,
  waitForLLMSessionsToDrain,
} from "./llm.js";
import { LocalEmbeddingProviderOwner } from "./embedding/local.js";
import {
  OpenAIEmbeddingProvider,
  UnavailableOpenAIEmbeddingProvider,
} from "./embedding/openai.js";
import {
  authorizeRemoteEmbeddingRequest,
  remoteEmbeddingIdentity,
} from "./embedding/remote-embedding.js";
import { readStoredEmbeddingIdentity } from "./embedding/identity.js";
import { inspectIndexDiagnostics } from "./diagnostics.js";
import {
  EmbeddingConfigError,
  readCanonicalEmbeddingConfig,
  resolveEmbeddingConfig,
  writeCanonicalEmbeddingConfig,
} from "./embedding/config.js";
import { rebuildCjkLexicalIndex } from "./search/cjk-index.js";
import { RemoteLLM } from "./remote-llm.js";
import { HybridLLM } from "./hybrid-llm.js";
import type { ExpansionMode } from "./search/query-expansion.js";
import {
  createCollectionConfigSource,
  loadConfig,
  addCollection as collectionsAddCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  setGlobalContext as collectionsSetGlobalContext,
  type Collection,
  type CollectionConfig,
  type CollectionConfigSource,
  type NamedCollection,
  type ContextMap,
} from "./collections.js";

// Re-export types for SDK consumers
export type {
  DocumentResult,
  DocumentNotFound,
  DocumentExcludedByIgnore,
  DocumentLookupError,
  SearchResult,
  HybridQueryResult,
  HybridQueryOptions,
  HybridQueryExplain,
  ExpandedQuery,
  StructuredSearchOptions,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
  SearchHooks,
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  Collection,
  CollectionConfig,
  NamedCollection,
  ContextMap,
};

// Re-export the internal Store type for advanced consumers
export type { InternalStore };
export type { ExpansionMode } from "./search/query-expansion.js";

// Re-export utility functions and types used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
export type { ChunkStrategy } from "./store.js";

// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";

// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";

/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
  collection: string;
  file: string;
  current: number;
  total: number;
};

/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  needsEmbedding: number;
};

/**
 * Options for the unified search() method.
 */
export interface SearchOptions {
  /** Simple query string — evaluated by the shared expansion policy */
  query?: string;
  /** Pre-expanded queries (from expandQuery) — bypasses expansion policy evaluation */
  queries?: ExpandedQuery[];
  /** Additional context used only while generating query expansions. */
  expansionContext?: string;
  /** Additional context used for reranking and snippet/chunk selection. */
  rerankContext?: string;
  /** Rerank results using LLM (default: true) */
  rerank?: boolean;
  /** Filter to a specific collection */
  collection?: string;
  /** Filter to specific collections */
  collections?: string[];
  /** Max results (default: 10) */
  limit?: number;
  /** Max candidates to rerank (default: 40) */
  candidateLimit?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Include explain traces */
  explain?: boolean;
  /** Query expansion policy (default: auto) */
  expansion?: ExpansionMode;
  /** Whether to include HyDE (hypothetical document) in query expansion (default: true) */
  includeHyde?: boolean;
  /** Optional progress/decision hooks for search orchestration */
  hooks?: SearchHooks;
  /** Chunk strategy: "auto" (default, uses AST for code files) or "regex" (legacy) */
  chunkStrategy?: ChunkStrategy;
}

/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
  limit?: number;
  collection?: string | string[];
}

/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
  limit?: number;
  collection?: string | string[];
}

/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
  /** Additional context used only while generating query expansions. */
  expansionContext?: string;
  /** Whether to include lexical (BM25) sub-queries (default: true) */
  includeLexical?: boolean;
  /** Whether to include HyDE (hypothetical document) sub-queries (default: true) */
  includeHyde?: boolean;
}

/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 */
export interface StoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to a YAML config file (mutually exclusive with `config`) */
  configPath?: string;
  /** Inline collection config (mutually exclusive with `configPath`) */
  config?: CollectionConfig;
  /** Open an existing index without persistent schema, config, or data writes. */
  readOnly?: boolean;
  /** Timeout applied to remote expansion, reranking, and embedding requests. */
  remoteRequestTimeoutMs?: number;
}

/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
  /** The underlying internal store (for advanced use) */
  readonly internal: InternalStore;
  /** Path to the SQLite database */
  readonly dbPath: string;

  // ── Search ──────────────────────────────────────────────────────────

  /** Full search: shared expansion policy + multi-signal retrieval + LLM reranking */
  search(options: SearchOptions): Promise<HybridQueryResult[]>;

  /** BM25 keyword search (fast, no LLM) */
  searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;

  /** Vector similarity search (embedding model, no reranking) */
  searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;

  /** Expand a query into typed sub-searches (lex/vec/hyde) for manual control */
  expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;

  // ── Document Retrieval ──────────────────────────────────────────────

  /** Get a single document by path or docid */
  get(pathOrDocid: string, options?: { includeBody?: boolean }): Promise<DocumentResult | DocumentLookupError>;

  /** Get the body content of a document, optionally sliced by line range */
  getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;

  /** Get multiple documents by glob pattern or comma-separated list */
  multiGet(pattern: string, options?: { includeBody?: boolean; maxBytes?: number }): Promise<{ docs: MultiGetResult[]; errors: string[] }>;

  // ── Collection Management ───────────────────────────────────────────

  /** Add or update a collection */
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;

  /** Remove a collection */
  removeCollection(name: string): Promise<boolean>;

  /** Rename a collection */
  renameCollection(oldName: string, newName: string): Promise<boolean>;

  /** List all collections with document stats */
  listCollections(): Promise<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[]>;

  /** Get names of collections included by default in queries */
  getDefaultCollectionNames(): Promise<string[]>;

  // ── Context Management ──────────────────────────────────────────────

  /** Add context for a path within a collection */
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;

  /** Remove context from a collection path */
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;

  /** Set global context (applies to all collections) */
  setGlobalContext(context: string | undefined): Promise<void>;

  /** Get global context */
  getGlobalContext(): Promise<string | undefined>;

  /** List all contexts across all collections */
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;

  // ── Indexing ────────────────────────────────────────────────────────

  /** Re-index collections by scanning the filesystem */
  update(options?: {
    collections?: string[];
    onProgress?: (info: UpdateProgress) => void;
  }): Promise<UpdateResult>;

  /** Generate vector embeddings for documents that need them */
  embed(options?: {
    force?: boolean;
    model?: string;
    /** Restrict embedding to documents in one collection. */
    collection?: string;
    maxDocsPerBatch?: number;
    maxBatchBytes?: number;
    chunkStrategy?: ChunkStrategy;
    onProgress?: (info: EmbedProgress) => void;
  }): Promise<EmbedResult>;


  // ── Index Health ────────────────────────────────────────────────────

  /** Get index status (document counts, collections, embedding state) */
  getStatus(): Promise<IndexStatus>;

  /** Get index health info (stale embeddings, etc.) */
  getIndexHealth(): Promise<IndexHealthInfo>;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Close the store and release all resources (LLM models, DB connection) */
  close(): Promise<void>;
}

/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options: StoreOptions): Promise<QMDStore> {
  if (!options.dbPath) {
    throw new Error("dbPath is required");
  }
  if (options.configPath && options.config) {
    throw new Error("Provide either configPath or config, not both");
  }

  // A missing read-only index uses an initialized in-memory store without
  // creating the requested on-disk file.
  const useTemporaryStore = options.readOnly === true && !existsSync(options.dbPath);
  const internal = createStoreInternal(
    useTemporaryStore ? ":memory:" : options.dbPath,
    { readOnly: options.readOnly === true && !useTemporaryStore },
  );
  const db = internal.db;

  const externalConfigSource: CollectionConfigSource | undefined = options.configPath
    ? createCollectionConfigSource({ configPath: options.configPath })
    : options.config
      ? createCollectionConfigSource({ config: options.config })
      : undefined;

  // Sync config into SQLite store_collections
  let config: CollectionConfig | undefined;
  if (externalConfigSource) {
    config = loadConfig(externalConfigSource);
    if (!options.readOnly || useTemporaryStore) syncConfigToDb(db, config);
  }
  // else: DB-only mode — no external config, use existing store_collections

  const embedding = resolveEmbeddingConfig({
    config,
    dbConfig: readCanonicalEmbeddingConfig(db),
    defaultLocalModel: DEFAULT_EMBED_MODEL_URI,
  });
  if (!options.readOnly || useTemporaryStore) {
    writeCanonicalEmbeddingConfig(db, embedding.canonical);
  }
  // Create a per-store LlamaCpp instance — lazy-loads models on first use,
  // auto-unloads after 5 min inactivity to free VRAM.
  const localLlm = new LlamaCpp({
    embedModel: embedding.canonical.provider === "local"
      ? embedding.canonical.model
      : DEFAULT_EMBED_MODEL_URI,
    generateModel: config?.models?.generate,
    rerankModel: config?.models?.rerank,
    inactivityTimeoutMs: 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
  });

  const rawGenerateUrl = config?.models?.generate_url ?? config?.models?.generate_base_url ?? config?.models?.generate_api_url;
  const rawRerankUrl = config?.models?.rerank_url ?? config?.models?.rerank_base_url ?? config?.models?.rerank_api_url;
  const hasRemoteLLM = Boolean(rawGenerateUrl || rawRerankUrl);

  const remoteLlm = hasRemoteLLM
    ? new RemoteLLM({
        generateUrl: config?.models?.generate_url,
        generateBaseUrl: config?.models?.generate_base_url,
        generateApiUrl: config?.models?.generate_api_url,
        generateApiModel: config?.models?.generate_api_model,
        generateApiKey: config?.models?.generate_api_key,
        rerankUrl: config?.models?.rerank_url,
        rerankBaseUrl: config?.models?.rerank_base_url,
        rerankApiUrl: config?.models?.rerank_api_url,
        rerankApiModel: config?.models?.rerank_api_model,
        rerankApiKey: config?.models?.rerank_api_key,
        timeoutMs: options.remoteRequestTimeoutMs,
      })
    : undefined;

  const llm = remoteLlm ? new HybridLLM(localLlm, remoteLlm) : localLlm;
  internal.llm = llm;
  let closeEmbeddingResources: () => Promise<void>;
  let remoteKeyConfigured = false;
  if (embedding.canonical.provider === "local") {
    const embeddingOwner = new LocalEmbeddingProviderOwner(localLlm, {
      model: embedding.canonical.model,
      dimension: embedding.canonical.dimension ?? undefined,
    });
    internal.embeddingProvider = embeddingOwner.provider;
    closeEmbeddingResources = () => embeddingOwner.close();
  } else {
    const apiKey =
      config?.models?.embed_api_key?.trim() ||
      process.env.OPENAI_API_KEY?.trim();
    remoteKeyConfigured = apiKey != null && apiKey !== "";
    const configuredModel = embedding.canonical.model;
    const configuredDimension = embedding.canonical.dimension;
    const configuredBaseUrl = embedding.canonical.baseUrl;
    // For non-default endpoints (self-hosted / proxy), API key is optional
    const canConstruct = remoteKeyConfigured || embedding.credentialAvailable;
    const provider = canConstruct
      ? new OpenAIEmbeddingProvider({
          apiKey: apiKey || undefined,
          model: configuredModel,
          dimension: configuredDimension,
          baseUrl: configuredBaseUrl,
          requestTimeoutMs: options.remoteRequestTimeoutMs,
          authorizeRequest: request => {
            const activeProvider = internal.embeddingProvider;
            if (!activeProvider?.remote) {
              throw new EmbeddingConfigError("Remote embedding provider is not active.");
            }
            const storedIdentity = readStoredEmbeddingIdentity(db);
            const requestIdentity = [
              storedIdentity,
              remoteEmbeddingIdentity(activeProvider, "regex"),
              remoteEmbeddingIdentity(activeProvider, "auto"),
            ].find(identity => identity?.fingerprint === request.fingerprint);
            if (!requestIdentity) {
              throw new EmbeddingConfigError("Remote request fingerprint does not match an active embedding identity.");
            }
            authorizeRemoteEmbeddingRequest(
              db,
              requestIdentity,
              request.purpose,
              {
                lease: request.buildLease,
                requestFingerprint: request.fingerprint,
              },
            );
          },
        })
      : new UnavailableOpenAIEmbeddingProvider({ model: configuredModel, dimension: configuredDimension, baseUrl: configuredBaseUrl });
    internal.embeddingProvider = provider;
    closeEmbeddingResources = async () => {
      try {
        await provider.close();
      } finally {
        try {
          await waitForLLMSessionsToDrain(localLlm);
        } finally {
          await llm.dispose();
        }
      }
    };
  }
  internal.authorizeRemoteRequest = (purpose, context) => {
    const activeProvider = internal.embeddingProvider;
    if (!activeProvider?.remote) {
      throw new EmbeddingConfigError("Remote embedding provider is not active.");
    }
    authorizeRemoteEmbeddingRequest(
      db,
      context.identity ?? remoteEmbeddingIdentity(activeProvider),
      purpose,
      { lease: context.lease },
    );
  };
  let closePromise: Promise<void> | undefined;

  const store: QMDStore = {
    internal,
    dbPath: internal.dbPath,

    // Search
    search: async (opts) => {
      if (!opts.query && !opts.queries) {
        throw new Error("search() requires either 'query' or 'queries'");
      }
      // Normalize collection/collections
      const collections = [
        ...(typeof opts.collection === "string" ? [opts.collection] : (opts.collection ?? [])),
        ...(opts.collections ?? []),
      ];
      const skipRerank = opts.rerank === false;

      if (opts.queries) {
        // Pre-expanded queries — use structuredSearch
        return structuredSearch(internal, opts.queries, {
          collections: collections.length > 0 ? collections : undefined,
          limit: opts.limit,
          minScore: opts.minScore,
          explain: opts.explain,
          rerankContext: opts.rerankContext,
          candidateLimit: opts.candidateLimit,
          skipRerank,
          chunkStrategy: opts.chunkStrategy,
        });
      }

      // Simple query string — use hybridQuery (expand + search + rerank)
      return hybridQuery(internal, opts.query!, {
        collections: collections.length > 0 ? collections : undefined,
        collection: collections.length === 1 ? collections[0] : (collections.length > 0 ? collections : undefined),
        limit: opts.limit,
        minScore: opts.minScore,
        explain: opts.explain,
        expansionContext: opts.expansionContext,
        rerankContext: opts.rerankContext,
        expansion: opts.expansion,
        includeHyde: opts.includeHyde,
        hooks: opts.hooks,
        candidateLimit: opts.candidateLimit,
        skipRerank,
        chunkStrategy: opts.chunkStrategy,
      });
    },
    searchLex: async (q, opts) => internal.searchFTS(q, opts?.limit, opts?.collection),
    searchVector: async (q, opts) => {
      const provider = internal.embeddingProvider;
      return internal.searchVec(
        q,
        provider?.model ?? (internal.llm as any)?.embedModelName ?? DEFAULT_EMBED_MODEL_URI,
        opts?.limit,
        opts?.collection,
      );
    },
    expandQuery: async (q, opts) => internal.expandQuery(q, undefined, opts?.expansionContext, {
      includeLexical: opts?.includeLexical,
      includeHyde: opts?.includeHyde,
    }),
    get: async (pathOrDocid, opts) => internal.findDocument(pathOrDocid, opts),
    getDocumentBody: async (pathOrDocid, opts) => {
      const result = internal.findDocument(pathOrDocid, { includeBody: false });
      if ("error" in result) return null;
      return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
    },
    multiGet: async (pattern, opts) => internal.findDocuments(pattern, opts),

    // Collection Management — external config wins when configured; reconciliation mutates SQLite.
    addCollection: async (name, opts) => {
      if (externalConfigSource) {
        collectionsAddCollection(name, opts.path, opts.pattern, opts.ignore, externalConfigSource);
        syncConfigToDb(db, loadConfig(externalConfigSource));
      } else {
        upsertStoreCollection(db, name, { path: opts.path, pattern: opts.pattern, ignore: opts.ignore });
      }
    },
    removeCollection: async (name) => {
      if (externalConfigSource) {
        if (!collectionsRemoveCollection(name, externalConfigSource)) return false;
        syncConfigToDb(db, loadConfig(externalConfigSource));
      } else {
        if (!getStoreCollection(db, name)) return false;
        removeCollectionWithDocuments(db, name);
      }
      return true;
    },
    renameCollection: async (oldName, newName) => {
      if (externalConfigSource) {
        if (!collectionsRenameCollection(oldName, newName, externalConfigSource)) return false;
        syncConfigToDb(db, loadConfig(externalConfigSource));
      } else {
        if (!getStoreCollection(db, oldName)) return false;
        renameCollectionWithDocuments(db, oldName, newName);
      }
      return true;
    },
    listCollections: async () => storeListCollections(db),
    getDefaultCollectionNames: async () => {
      const collections = storeListCollections(db);
      return collections.filter(c => c.includeByDefault).map(c => c.name);
    },

    // Context Management follows the same external-config-first reconciliation contract.
    addContext: async (collectionName, pathPrefix, contextText) => {
      if (externalConfigSource) {
        if (!collectionsAddContext(collectionName, pathPrefix, contextText, externalConfigSource)) return false;
        syncConfigToDb(db, loadConfig(externalConfigSource));
        return true;
      }
      return updateStoreContext(db, collectionName, pathPrefix, contextText);
    },
    removeContext: async (collectionName, pathPrefix) => {
      if (externalConfigSource) {
        if (!collectionsRemoveContext(collectionName, pathPrefix, externalConfigSource)) return false;
        syncConfigToDb(db, loadConfig(externalConfigSource));
        return true;
      }
      return removeStoreContext(db, collectionName, pathPrefix);
    },
    setGlobalContext: async (context) => {
      if (externalConfigSource) {
        collectionsSetGlobalContext(context, externalConfigSource);
        syncConfigToDb(db, loadConfig(externalConfigSource));
      } else {
        setStoreGlobalContext(db, context);
      }
    },
    getGlobalContext: async () => getStoreGlobalContext(db),
    listContexts: async () => getStoreContexts(db),

    // Indexing — reads collections from SQLite
    update: async (updateOpts) => {
      const collections = getStoreCollections(db);
      const filtered = updateOpts?.collections
        ? collections.filter(c => updateOpts.collections!.includes(c.name))
        : collections;

      internal.clearCache();

      let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0, totalSkipped = 0;

      for (const col of filtered) {
        const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
          ignorePatterns: col.ignore,
          onProgress: updateOpts?.onProgress
            ? (info) => updateOpts.onProgress!({ collection: col.name, ...info })
            : undefined,
        });
        totalIndexed += result.indexed;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalRemoved += result.removed;
        totalSkipped += result.skipped;
      }

      await rebuildCjkLexicalIndex(options.dbPath);

      return {
        collections: filtered.length,
        indexed: totalIndexed,
        updated: totalUpdated,
        unchanged: totalUnchanged,
        removed: totalRemoved,
        skipped: totalSkipped,
        needsEmbedding: internal.getHashesNeedingEmbedding(),
      };
    },

    embed: async (embedOpts) => {
      const provider = internal.embeddingProvider;
      if (provider?.remote) {

        if (embedOpts?.force && embedOpts.collection) {
          throw new EmbeddingConfigError(
            "Remote destructive embedding rebuilds cannot be collection-scoped.",
          );
        }
        const identity = remoteEmbeddingIdentity(provider, embedOpts?.chunkStrategy);
        const pending = getPendingEmbeddingDocsReadOnly(
          db,
          embedOpts?.collection,
          identity.model,
          identity.fingerprint,
        );
        if (pending.length === 0 && !embedOpts?.force) {
          return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, failures: [], durationMs: 0 };
        }
        if (!remoteKeyConfigured && !embedding.credentialAvailable) {
          throw new EmbeddingConfigError(
            "OpenAI document embedding is authorized, but OPENAI_API_KEY is not configured.",
          );
        }
      }
      return generateEmbeddings(internal, {
        force: embedOpts?.force,
        model: embedOpts?.model,
        collection: embedOpts?.collection,
        maxDocsPerBatch: embedOpts?.maxDocsPerBatch,
        maxBatchBytes: embedOpts?.maxBatchBytes,
        chunkStrategy: embedOpts?.chunkStrategy,

        onProgress: embedOpts?.onProgress,
      });
    },


    // Index Health
    getStatus: async () => {
      const diagnostics = inspectIndexDiagnostics(db, {
        fallbackModel: embedding.canonical.model,
        provider: internal.embeddingProvider,
        keyConfigured: remoteKeyConfigured,
      });
      return {
        ...getStatusReadOnly(db, diagnostics.embedding.chunks.pendingDocuments),
        diagnostics,
      };
    },
    getIndexHealth: async () => {
      const diagnostics = inspectIndexDiagnostics(db, {
        fallbackModel: embedding.canonical.model,
        provider: internal.embeddingProvider,
        keyConfigured: remoteKeyConfigured,
      });
      return getIndexHealthReadOnly(db, diagnostics.embedding.chunks.pendingDocuments);
    },

    // Lifecycle
    close: () => {
      if (!closePromise) {
        closePromise = (async () => {
          try {
            await closeEmbeddingResources();
          } finally {
            internal.close();
          }
        })();
      }
      return closePromise;
    },
  };

  return store;
}
