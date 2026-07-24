# Embedding call-site inventory

This inventory records every production `embed()` and `embedBatch()` call site present when the Phase 0 `EmbeddingProvider` seam was introduced. T10 must use it to remove direct Store, SDK, and CLI embedding bypasses.

## T10 migration targets

| Call site | Current role | T10 action |
| --- | --- | --- |
| `src/store.ts:1749` | Single-chunk retry during document embedding | Route through the store's borrowed `EmbeddingProvider`; format the document with that same provider before calling `embed()`. |
| `src/store.ts:1840` | First-chunk dimension probe | Replace with provider capability/first result and validate it against the canonical provider identity. |
| `src/store.ts:1874` | Batched document embedding | Route through `EmbeddingProvider.embedBatch()` and preserve chunk order/cardinality. |
| `src/store.ts:2308` | Legacy fingerprint adoption sample | Route through the same provider identity used by persistence; do not authorize adoption from a different provider/model. |
| `src/store.ts:3736-3737` | Query embedding helper used by `searchVec()`; chooses a session or global `LlamaCpp` directly | Remove both direct branches and require the injected provider. Preserve the precomputed-vector bypass in `src/store.ts:3646`. |
| `src/store.ts:4823` | `hybridQuery()` batched query embedding | Route through the store's provider; remove direct `LlamaCpp.embedBatch()` access. |
| `src/store.ts:5209` | Structured-search batched query embedding | Route through the store's provider; remove direct `LlamaCpp.embedBatch()` access. |
| `src/cli/qmd.ts:3661` | `qmd doctor` stored-vector reproduction sample | Route through the CLI-owned provider and compare using the persisted canonical identity. |

## Identity and composition paths to update with the migration

These are not direct embedding operations, but they currently select or expose the embedding owner and can preserve a bypass if left unchanged.

| Location | Current role | T10 action |
| --- | --- | --- |
| `src/store.ts:84-86` | Selects per-store or global `LlamaCpp`. | Embedding paths must no longer use this helper; expansion/reranking may continue to use the existing LLM lifecycle. |
| `src/store.ts:5063` | Reads `getLlm(store).embedModelName` for vector search. | Read model/identity from the injected provider instead. |
| `src/store.ts:1270-1320` | Low-level `Store` contract and `searchVec()` session parameter. | Add the borrowed provider seam and remove the embedding-session escape hatch while preserving precomputed vectors. |
| `src/index.ts:345-417` | SDK composition root creates the per-store LLM owner. | Create/own the provider, inject it into the low-level Store, and close it before disposing the LLM/DB. |
| `src/cli/qmd.ts:121-170` | CLI global Store/LLM lifecycle. | Create/own one provider and await its close on every exit path. |

## Internal bridges that may remain

These calls are implementation details behind the provider boundary, not Store/CLI bypasses.

| Call site | Reason it may remain |
| --- | --- |
| `src/embedding/local.ts:89` | `LocalEmbeddingProvider.embed()` delegates to its borrowed `ILLMSession`. |
| `src/embedding/local.ts:108` | `LocalEmbeddingProvider.embedBatch()` delegates to its borrowed `ILLMSession`. |
| `src/llm.ts:1891,1895` | `LLMSession` forwards operations to its owned `LlamaCpp`; the local provider depends on this bridge. |
| `src/llm.ts:1299-1379` | Native local embedding implementation. It remains behind `LocalEmbeddingProvider`. |

Expansion and reranking methods are intentionally outside `EmbeddingProvider` and retain their existing `LlamaCpp`/`ILLMSession` lifecycle.

`EmbeddingProvider.embed()` and `embedBatch()` accept text already prepared with
that provider's `formatQuery()` or `formatDocument()` method. Formatting remains
explicit at the call site so document titles and per-input query/document kinds do
not widen the batch API, but callers must never mix one provider's formatter with
another provider's embedding operation.

## T10 completion checks

1. Search production source for direct calls:
   - `\.(embed|embedBatch)\(`
   - `getEmbedding\(`
   - `embedModelName`
2. Every remaining embedding call must be one of the internal bridges listed above or a provider call.
3. Store, SDK, CLI, hybrid, structured-search, doctor, and legacy-adoption tests must fail if a direct `LlamaCpp.embed*()` bypass is reintroduced.
4. The `precomputedEmbedding` path in `searchVec()` must continue to avoid any provider request.
5. Provider ownership must follow the T10 lifecycle matrix: low-level Store borrows; SDK and CLI own and close.
