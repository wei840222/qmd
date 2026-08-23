# QMD - Query Markup Documents

An on-device search engine for everything you need to remember. Index your markdown notes, meeting transcripts, documentation, and knowledge bases. Search with keywords or natural language. Ideal for your agentic flows.

QMD combines BM25 full-text search, vector semantic search, and LLM re-ranking—all running locally via node-llama-cpp with GGUF models.

```mermaid
flowchart LR
  Q[User Query] --> X[Query Expansion]
  Q --> FTS[BM25 Search]
  Q --> VS[Vector Search]
  X --> HYDE[HyDE]
  X --> VEC[Vec dense sentences]
  X --> LEX[Lex BM25 keywords]
  HYDE --> VS
  VEC --> VS
  LEX --> FTS
  VS --> RRF[Reciprocal Rank Fusion]
  FTS --> RRF
  RRF --> RR[LLM Reranker]
  RR --> OUT[Final ranked results]
```

Typed expansions are routed exclusively: `lex` → BM25/FTS, `vec` and `hyde` → vector search. The original query is sent to both backends, then fused with RRF and reranked.

You can read more about QMD's progress in the [CHANGELOG](CHANGELOG.md).

## Quick Start (Local Embedding Default)

```sh
# Install globally
npm install -g @wei840222/qmd
# or
pnpm add -g @wei840222/qmd

# Or run directly
npx @wei840222/qmd ...

# Create collections for your notes, docs, and meeting transcripts
qmd collection add ~/notes --name notes
qmd collection add ~/Documents/meetings --name meetings
qmd collection add ~/work/docs --name docs

# Add context to help with search results, each piece of context will be returned when matching sub documents are returned. This works as a tree. This is the key feature of QMD as it allows LLMs to make much better contextual choices when selecting documents. Don't sleep on it!
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://meetings "Meeting transcripts and notes"
qmd context add qmd://docs "Work documentation"

# Generate embeddings for semantic search
qmd embed

# Search across everything
qmd search "project timeline"           # Fast keyword search
qmd vsearch "how to deploy"             # Semantic search
qmd query "quarterly planning process"  # Hybrid + reranking (best quality)

# Get a specific document
qmd get "meetings/2024-01-15.md"

# Get a document by docid (shown in search results)
qmd get "#abc123"

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Search within a specific collection
qmd search "API" -c notes

# Export all matches for an agent
qmd search "API" --all --files --min-score 0.3
```

### Using with AI Agents

QMD's `--json` and `--files` output formats are designed for agentic workflows:

```sh
# Get structured results for an LLM
qmd search "authentication" --json -n 10

# List all relevant files above a threshold
qmd query "error handling" --all --files --min-score 0.4

# Retrieve full document content
qmd get "docs/api-reference.md" --full
```

### MCP Server

Although the tool works perfectly fine when you just tell your agent to use it on the command line, it also exposes an MCP (Model Context Protocol) server for tighter integration.

**Tools exposed:**
- `query` — Search with typed sub-queries (`lex`/`vec`/`hyde`), combined via RRF + reranking
- `get` — Retrieve a document by path or docid (with fuzzy matching suggestions)
- `multi_get` — Batch retrieve by glob pattern, comma-separated list, or docids
- `status` — Index health and collection info

**Claude Desktop configuration** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

**Claude Code** — Install the plugin (recommended):

```bash
claude plugin marketplace add tobi/qmd
claude plugin install qmd@qmd
```

Or configure MCP manually in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

#### HTTP Transport

By default, QMD's MCP server uses stdio (launched as a subprocess by each client). For a shared, long-lived server that avoids repeated model loading, use the HTTP transport:

```sh
# Foreground (Ctrl-C to stop)
qmd mcp --http                    # localhost:8181
qmd mcp --http --port 8080        # custom port
qmd mcp --http --host 0.0.0.0     # bind all interfaces (e.g. container probes)

# Background daemon
qmd mcp --http --daemon           # start, writes PID to ~/.cache/qmd/mcp.pid
qmd mcp stop                      # stop via PID file
qmd status                        # shows "MCP: running (PID ...)" when active
```

The server binds to `localhost` by default. Pass `--host` (or set the `QMD_HOST`
environment variable) to override — `--host 0.0.0.0` is useful when the server
runs in a container and a liveness probe connects from a non-loopback address.

The HTTP server exposes two endpoints:
- `POST /mcp` — MCP Streamable HTTP (JSON responses, stateless)
- `POST /query` (alias `/search`) — structured search without the MCP protocol
- `GET /health` — liveness check with uptime


##### Origin and Host validation

Every request is screened before routing: a request carrying an `Origin` header
that does not name a loopback address is rejected with `403`, as is a `Host`
header naming something other than the address the server is bound to. This is
what stops a web page you visit from reading your index through DNS rebinding —
loopback binding alone does not, since the browser makes the request from your
own machine.

Requests without an `Origin` header — curl, MCP clients, editors — are
unaffected, which covers every normal local client.

| Variable | Effect |
|----------|--------|
| `QMD_ALLOWED_ORIGINS` | Comma-separated origins to accept in addition to loopback, e.g. `https://notes.internal`. Set to `*` to disable the check entirely. |
| `QMD_ALLOWED_HOSTS` | Comma-separated `Host` values to accept in addition to loopback and the bind address. |

`--host 0.0.0.0` cannot know which `Host` values are legitimate, so it skips the
host check and warns at startup. Set `QMD_ALLOWED_HOSTS` to re-enable it, and
remember the endpoints are unauthenticated — put your own auth in front of a
server that is reachable off-host.

LLM models stay loaded in VRAM across requests. Embedding/reranking contexts are disposed after 5 min idle and transparently recreated on the next request (~1s penalty, models remain loaded).

Point any MCP client at `http://localhost:8181/mcp` to connect.

#### MCP Tool Parameters

| Tool | Parameter | Type | Notes |
|------|-----------|------|-------|
| `query` | `query` | string | Plain query evaluated by the shared expansion policy. Mutually exclusive with `searches`; exactly one is required. |
| `query` | `searches` | array | Typed sub-queries (`lex`/`vec`/`hyde`), 1–10. Mutually exclusive with `query`; exactly one is required. First gets 2x weight. |
| `query` | `expansion` | string | Plain-query policy: `auto` (default), `force`, or `skip`. Ignored when `searches` is used. |
| `query` | `collections` | string[] | Filter by collection names (OR). **Array only** — singular `collection` is silently ignored. |
| `query` | `expansionContext` | string | Additional context used only to generate `lex` / `vec` / `hyde` query expansions. |
| `query` | `rerankContext` | string | Additional context used only for reranking and snippet/chunk selection. |
| `query` | `limit` | number | Max results (default 10) |
| `query` | `minScore` | number | Minimum relevance 0–1 (default 0) |
| `query` | `candidateLimit` | number | Max candidates to rerank (default 40) |
| `query` | `rerank` | boolean | Run LLM reranking (default **true**); set false for RRF-only |
| `query` | `explain` | boolean | Include retrieval traces and the expansion decision or typed-query error (default **false**) |
| `get` | `file` | string | Path, docid (`#abc123`), or `path:from:count` (e.g. `#abc123:120:40`) |
| `get` | `fromLine` | number | Start line (1-indexed); overrides the `:from` suffix |
| `get` | `maxLines` | number | Limit returned lines |
| `get` | `lineNumbers` | boolean | Prefix lines with numbers (default **true**) |
| `multi_get` | `pattern` | string | Glob pattern or comma-separated list |
| `multi_get` | `maxBytes` | number | Skip files larger than N (default 10240) |
| `multi_get` | `maxLines` | number | Limit lines per file |
| `multi_get` | `lineNumbers` | boolean | Prefix lines with numbers (default **true**) |

Unknown parameters are silently ignored (not rejected) — double-check names if
results seem unscoped. The HTTP `/query` and `/search` endpoints return
`qmd://collection/path` URIs in the `file` field, matching the CLI and MCP output.

### SDK / Library Usage

Use QMD as a library in your own Node.js applications.

#### Installation

```sh
npm install @wei840222/qmd
```

#### Quick Start

```typescript
import { createStore } from '@wei840222/qmd'

const store = await createStore({
  dbPath: './my-index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
    },
  },
})

const results = await store.search({ query: "authentication flow" })
console.log(results.map(r => `${r.title} (${Math.round(r.score * 100)}%)`))

await store.close()
```

#### Store Creation

`createStore()` accepts three modes:

```typescript
import { createStore } from '@wei840222/qmd'

// 1. Inline config — no files needed besides the DB
const store = await createStore({
  dbPath: './index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
      notes: { path: '/path/to/notes' },
    },
  },
})

// 2. YAML config file — collections defined in a file
const store2 = await createStore({
  dbPath: './index.sqlite',
  configPath: './qmd.yml',
})

// 3. DB-only — reopen a previously configured store
const store3 = await createStore({ dbPath: './index.sqlite' })
```

#### Search

The unified `search()` method handles both simple queries and pre-expanded structured queries:

```typescript
// Simple query — evaluated by the shared auto policy, then retrieved and reranked
const results = await store.search({ query: "authentication flow" })

// With options
const results2 = await store.search({
  query: "rate limiting",
  expansionContext: "API throttling and abuse prevention",
  rerankContext: "API throttling and abuse prevention",
  collection: "docs",
  limit: 5,
  minScore: 0.3,
  explain: true,
  expansion: "auto", // "auto" | "force" | "skip"
})

// Pre-expanded queries — bypass the policy and control each sub-query
const results3 = await store.search({
  queries: [
    { type: 'lex', query: '"connection pool" timeout -redis' },
    { type: 'vec', query: 'why do database connections time out under load' },
  ],
  collections: ["docs", "notes"],
})

// Skip reranking for faster results
const fast = await store.search({ query: "auth", rerank: false })
```

For simple queries, explicit `force` or `skip` overrides `auto`. Under `auto`, CJK
queries and strong lexical matches skip model expansion; other queries expand.
Supplying `queries` bypasses expansion policy evaluation entirely.

For direct backend access:

```typescript
// BM25 keyword search (fast, no LLM)
const lexResults = await store.searchLex("auth middleware", { limit: 10 })

// Vector similarity search (embedding model, no reranking)
const vecResults = await store.searchVector("how users log in", { limit: 10 })

// Manual query expansion for full control
const expanded = await store.expandQuery("auth flow", { expansionContext: "user login" })
const results4 = await store.search({ queries: expanded })
```

#### Retrieval

```typescript
// Get a document by path or docid
const doc = await store.get("docs/readme.md")
const byId = await store.get("#abc123")

if (!("error" in doc)) {
  console.log(doc.title, doc.displayPath, doc.context)
}

// Get document body with line range
const body = await store.getDocumentBody("docs/readme.md", {
  fromLine: 50,
  maxLines: 100,
})

// Batch retrieve by glob or comma-separated list
const { docs, errors } = await store.multiGet("docs/**/*.md", {
  maxBytes: 20480,
})
```

#### Collections

```typescript
// Add a collection
await store.addCollection("myapp", {
  path: "/src/myapp",
  pattern: "**/*.ts",
  ignore: ["node_modules/**", "*.test.ts"],
})

// List collections with document stats
const collections = await store.listCollections()
// => [{ name, pwd, glob_pattern, doc_count, active_count, last_modified, includeByDefault }]

// Get names of collections included in queries by default
const defaults = await store.getDefaultCollectionNames()

// Remove / rename
await store.removeCollection("myapp")
await store.renameCollection("old-name", "new-name")
```

#### Context

Context adds descriptive metadata that improves search relevance and is returned alongside results:

```typescript
// Add context for a path within a collection
await store.addContext("docs", "/api", "REST API reference documentation")

// Set global context (applies to all collections)
await store.setGlobalContext("Internal engineering documentation")

// List all contexts
const contexts = await store.listContexts()
// => [{ collection, path, context }]

// Remove context
await store.removeContext("docs", "/api")
await store.setGlobalContext(undefined)  // clear global
```

#### Indexing

```typescript
// Re-index collections by scanning the filesystem
const result = await store.update({
  collections: ["docs"],  // optional — defaults to all
  onProgress: ({ collection, file, current, total }) => {
    console.log(`[${collection}] ${current}/${total} ${file}`)
  },
})
// => { collections, indexed, updated, unchanged, removed, needsEmbedding }

// Generate vector embeddings
const embedResult = await store.embed({
  force: false,           // true to re-embed everything
  chunkStrategy: "auto",  // "regex" (default) or "auto" (AST for code files)
  onProgress: ({ current, total, collection }) => {
    console.log(`Embedding ${current}/${total}`)
  },
})
```

#### Types

Key types exported for SDK consumers:

```typescript
import type {
  QMDStore,            // The store interface
  SearchOptions,       // Options for search()
  LexSearchOptions,    // Options for searchLex()
  VectorSearchOptions, // Options for searchVector()
  HybridQueryResult,   // Search result with score, snippet, context
  SearchResult,        // Result from searchLex/searchVector
  ExpandedQuery,       // Typed sub-query { type: 'lex'|'vec'|'hyde', query }
  DocumentResult,      // Document metadata + body
  DocumentNotFound,    // Error with similarFiles suggestions
  MultiGetResult,      // Batch retrieval result
  UpdateProgress,      // Progress callback info for update()
  UpdateResult,        // Aggregated update result
  EmbedProgress,       // Progress callback info for embed()
  EmbedResult,         // Embedding result
  StoreOptions,        // createStore() options
  CollectionConfig,    // Inline config shape
  IndexStatus,         // From getStatus()
  IndexHealthInfo,     // From getIndexHealth()
} from '@wei840222/qmd'
```

Utility exports:

```typescript
import {
  extractSnippet,              // Extract a relevant snippet from text
  addLineNumbers,              // Add line numbers to text
  DEFAULT_MULTI_GET_MAX_BYTES, // Default max file size for multiGet (64KB)
  Maintenance,                 // Database maintenance operations
} from '@wei840222/qmd'
```

#### Lifecycle

```typescript
// Close the store — disposes LLM models and DB connection
await store.close()
```

The SDK requires explicit `dbPath` — no defaults are assumed. This makes it safe to embed in any application without side effects.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         QMD Hybrid Search Pipeline                          │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────────┐
                              │   User Query    │
                              └────────┬────────┘
                                       │
                              ┌────────▼────────┐
                              │ Expansion Policy│
                              │ auto|force|skip │
                              └────────┬────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         ▼                           ▼
                ┌─────────────────┐        ┌─────────────────┐
                │ Original Query  │        │ Typed Expansions│
                │      (×2)       │        │ lex / vec / HyDE│
                └────────┬────────┘        └────────┬────────┘
                         │                           │
                 ┌───────┴───────┐           ┌───────┴───────┐
                 ▼               ▼           ▼               ▼
             ┌───────┐       ┌────────┐   ┌───────┐       ┌────────┐
             │ BM25  │       │ Vector │   │  lex  │       │vec/HyDE│
             │(FTS5) │       │ Search │   └───┬───┘       └───┬────┘
             └───┬───┘       └───┬────┘       ▼               ▼
                 │               │         ┌───────┐       ┌────────┐
                 │               │         │ BM25  │       │ Vector │
                 │               │         │(FTS5) │       │ Search │
                 └───────┬───────┘         └───┬───┘       └───┬────┘
                         └─────────────┬───────┴───────────────┘
                                       │
                                       ▼
                          ┌───────────────────────┐
                          │   RRF Fusion + Bonus  │
                          │ Original paths ×2     │
                          │  Top-rank bonus: +0.05│
                          │     Top 30 Kept       │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │    LLM Re-ranking     │
                          │  (qwen3-reranker)     │
                          │  Yes/No + logprobs    │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Position-Aware Blend │
                          │  Top 1-3:  75% RRF    │
                          │  Top 4-10: 60% RRF    │
                          │  Top 11+:  40% RRF    │
                          └───────────────────────┘
```

## Score Normalization & Fusion

### Search Backends

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| **FTS (BM25)** | SQLite FTS5 BM25 | `Math.abs(score)` | 0 to ~25+ |
| **Vector** | Cosine distance | `1 / (1 + distance)` | 0.0 to 1.0 |
| **Reranker** | LLM 0-10 rating | `score / 10` | 0.0 to 1.0 |

### Fusion Strategy

The `query` command uses **Reciprocal Rank Fusion (RRF)** with position-aware blending:

1. **Query Expansion Policy**: `auto` expands eligible queries with a local generator but skips remote generation; `force` runs the configured generator; `skip` uses only the original query. Original FTS and vector retrieval paths have ×2 RRF weight in every mode. When expansion runs, QMD adds zero or more typed LLM variants at ×1: `lex` variants use FTS, while `vec` and `hyde` variants use vector search.
2. **Parallel Retrieval**: The original query searches both indexes; `lex` variants search FTS, while `vec` and `hyde` variants search the vector index
3. **RRF Fusion**: Combine all result lists using `score = Σ(1/(k+rank+1))` where k=60
4. **Top-Rank Bonus**: Documents ranking #1 in any list get +0.05, #2-3 get +0.02
5. **Top-K Selection**: Take top 30 candidates for reranking
6. **Re-ranking**: LLM scores each document (yes/no with logprobs confidence)
7. **Position-Aware Blending**:
   - RRF rank 1-3: 75% retrieval, 25% reranker (preserves exact matches)
   - RRF rank 4-10: 60% retrieval, 40% reranker
   - RRF rank 11+: 40% retrieval, 60% reranker (trust reranker more)

**Why this approach**: Pure RRF can dilute exact matches when expanded queries don't match. The top-rank bonus preserves documents that score #1 for the original query. Position-aware blending prevents the reranker from destroying high-confidence retrieval results.

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Requirements

### System Requirements

- **Node.js** >= 22
- **macOS**: Homebrew SQLite (for extension support)
  ```sh
  brew install sqlite
  ```

### GGUF Models (via node-llama-cpp)

QMD uses three local GGUF models (auto-downloaded on first use):

| Model | Purpose | Size |
|-------|---------|------|
| `embeddinggemma-300M-Q8_0` | Vector embeddings (default) | ~300MB |
| `qwen3-reranker-0.6b-q8_0` | Re-ranking | ~640MB |
| `qmd-query-expansion-1.7B-q4_k_m` | Query expansion (fine-tuned) | ~1.1GB |

Models are downloaded from HuggingFace and cached in `~/.cache/qmd/models/`.

### Custom Embedding Model

Override the default local embedding model via the `QMD_EMBED_MODEL` environment variable.

```sh
# Use another local GGUF embedding model
export QMD_EMBED_MODEL="hf:org/model/repo-file.gguf"

# After changing the model, re-embed all collections:
qmd embed -f
```

Supported model families:
- **embeddinggemma** (default) — Smaller local model
- **Qwen3-Embedding** — Multilingual, including CJK

> **Note:** When switching embedding models, you must re-index with `qmd embed -f`
> since vectors are not cross-compatible between models. The prompt format is
> automatically adjusted for each model family.

### Remote Embedding & Models Configuration (Explicit Opt-in)

QMD stays local by default. To use remote embeddings or remote LLM models, configure them in `index.yml` under the unified `models:` section.

```yaml
models:
  embed: hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
  embed_api_url: https://api.openai.com/v1          # Both embed_api_url and embed_api_model enable remote embeddings
  embed_api_model: text-embedding-3-small           # or text-embedding-3-large
  embed_dimension: 1536                             # Optional: expected vector dimension; validates local output

  # Optional: Remote LLM Query Expansion (aliases: generate_url, generate_base_url, generate_api_url)
  generate_api_url: https://generativelanguage.googleapis.com/v1beta/openai/v1    # Base URL (appends /chat/completions) or full endpoint
  generate_api_model: gemini-3.5-flash-lite         # or gpt-4o-mini

  # Optional: Remote Reranking (aliases: rerank_url, rerank_base_url, rerank_api_url)
  rerank_api_url: https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions # Supports both /v1/rerank and /v1/chat/completions LLM endpoints
  rerank_api_model: gemini-3.5-flash-lite           # or gpt-4o-mini

# Optional: Custom User Dictionary for CJK segmentation
dictionary: ~/.config/qmd/dictionary.txt
```

> **Smart URL Resolution & Aliases:** All remote endpoint URLs support `_url`, `_base_url`, and `_api_url` aliases (e.g. `generate_url`, `generate_base_url`, `generate_api_url`). When given a Base URL (e.g. `https://api.example.com/v1`), QMD automatically appends `/chat/completions` for LLM generate and `/rerank` for reranking. If a full endpoint URL is provided, it is used directly. For reranking, QMD supports both dedicated Cross-Encoder endpoints (`/v1/rerank`) and general LLM endpoints (`/v1/chat/completions`).

> **CLI, SDK & MCP Integration:** Remote LLM query expansion and LLM Chat Reranking are automatically wired into CLI (`qmd query`), SDK (`createStore`), and MCP. Query expansion automatically enforces query language & script consistency (e.g., Traditional Chinese queries generate Traditional Chinese `lex`, `vec`, and `hyde` variations). LLM Chat Reranking features prompt-tail Recency Enforcement and strict JSON sanitization to ensure safe execution with any remote LLM backend.

`qmd init` writes local defaults only; it does not prompt for or generate a remote embedding configuration. To use a remote endpoint, edit `index.yml` manually and set credentials when required.

> **API Key Note:** Remote embeddings require both an embedding endpoint (`embed_url`, `embed_base_url`, or `embed_api_url`) and `embed_api_model`. When using official OpenAI (`api.openai.com`), set `OPENAI_API_KEY="..."`. For self-hosted proxies or keyless local servers, `OPENAI_API_KEY` is optional. QMD never writes keys to SQLite, diagnostics, logs, or error messages.

```sh
export OPENAI_API_KEY="..." # Required for api.openai.com; optional for self-hosted proxies

# Send pending document chunks and build the vector index.
qmd embed
```

Configure `embed_url`, `embed_base_url`, or `embed_api_url` together with `embed_api_model` to select the OpenAI-compatible embedding provider; QMD sends `POST /embeddings` requests. Changing the endpoint or model changes the remote embedding identity and requires a vector rebuild.

`vectors_vec` can store only one dimension. A dimension or identity change requires a forced rebuild:

```sh
qmd embed --force
```

Remote document chunks use deterministic UTF-8 byte windows. Query embedding is allowed only when the same identity is `ready` and compatible vectors exist; a vector or hybrid query then sends the formatted query text to the configured remote provider. After a vector reset deletes the old vectors, there is no vector rollback; lexical search remains available while rebuilding.

#### Embedding identity, recovery, and data boundary

`vectors_vec` holds one vector dimension at a time. An embedding identity includes
the provider, model, dimension, local/remote mode, and prompt/chunking profiles;
changing it requires `qmd embed --force`. A build lease with an owner ID and
generation sequence prevents concurrent writers. If an embedding request fails or
the lease expires, the index enters `Partial`; rerunning `qmd embed` with the same
identity resumes committed work and requests only missing, vector-only,
metadata-only, or layout-incomplete chunks. Vector search reads only `ready`
vectors with a compatible fingerprint.

Remote document chunks and formatted query text are sent to the configured remote
embedding provider. Remote embedding failures **never fall back to a local
embedding provider**, because vectors from a different identity are incompatible.
API keys are read only from process environment variables and are never stored in
SQLite, diagnostics, logs, or errors. Errors redact response bodies, request
payloads, credentials, and sensitive URLs; identity and lease state are
revalidated inside SQLite write locks before vectors are cleared or published.

Remote LLM routing is independent per operation: expansion and reranking may each
use a remote endpoint while embeddings remain local. A remote LLM failure can fall
back to the corresponding local LlamaCpp operation without interrupting a search;
dedicated `/v1/rerank` endpoints that return HTTP 404 fall back to structured Chat
Completions reranking. This fallback does not apply to remote embeddings.

`qmd status` and `qmd doctor` report provider/model/dimension, short fingerprint,
key presence as a boolean, pending/inconsistent chunks, CJK channel readiness, and
actionable repair commands. Diagnostics are read-only: they do not create schemas,
modify SQLite databases, load local models, or issue remote HTTP requests.

### CJK Lexical Search, Expansion, and Dictionary Maintenance

CJK lexical search combines independent character, word, and bigram channels by
rank. If Jieba or the published word/bigram index is unavailable, stale, or
incompatible, QMD omits both analyzed channels and falls back to character-only
search instead of failing the query or issuing an empty FTS match. `qmd status`
reports the reason and remediation.

Each lexical channel ranks candidates independently before channel-aware weighted
RRF combines them; raw channel scores are never summed. The original query runs
through every available lexical and vector path at ×2 weight. Typed expansion
variants are ×1: `lex` variants use the character, word, and bigram channels,
while `vec` and `hyde` variants use vector search. Use `--explain` to inspect
channel contributions and tie-breakers.

Query expansion uses one shared `auto | force | skip` policy across CLI, SDK, and
MCP. Precedence is: explicit skip or `lex:` skips expansion; explicit force,
`expand:`, or `--expand` forces it; under `auto`, CJK queries skip local model expansion (0ms bypass) but automatically expand when a remote LLM (`generate_api_url`) is configured; strong lexical
signals skip expansion, and remaining queries expand. Expanded queries automatically maintain language consistency with the user query.

#### CJK index publication and recovery

Published character, word, and bigram indexes are updated atomically with a
synchronous document mutation. Rebuilds populate shadow tables from a stable read
snapshot; mutations after that snapshot are recorded in a journal and replayed
before an atomic publication. The analyzer fingerprint includes normalization
rules, Jieba capability, built-in and optional user dictionary hashes, and token
stream parameters. A changed fingerprint triggers a rebuild rather than allowing
semantically incompatible analyzed indexes to remain active.

If a builder lease expires, cleanup restores `Ready`, `Empty`, or `Dirty` based on
the published index and dirty markers. `qmd status` and `qmd doctor` identify the
current cause and remediation. If Jieba is unavailable during a build, analyzed
channels are marked unavailable and search continues through the character channel.

QMD ships `zh-dict`, a single Jieba dictionary containing both Traditional and
Simplified Chinese entries. It deterministically combines the upstream
`@node-rs/jieba` dictionary, APCLab's `jieba-tw` dictionary, and selected
technical terminology from zhtw-mcp. A configured user dictionary is loaded
after `zh-dict`, so user entries retain the highest priority.

The runtime, build, and package installation never download dictionary sources.
Maintainers can regenerate the checked-in asset from the fixed source pins and
content hashes in `src/search/zh-dict.sources.json`:

```sh
# Verify every pinned source and regenerate src/search/zh-dict.txt
pnpm dict:sync

# Intentionally advance the configured upstream branch pins, then regenerate
pnpm dict:sync -- --update-pins
```

`dict:sync` records the generated asset's SHA-256 in the source configuration.
Review the resulting pin and dictionary diff before committing an update.

## Installation

```sh
npm install -g @wei840222/qmd
# or
pnpm add -g @wei840222/qmd
```

### Development

```sh
git clone https://github.com/wei840222/qmd
cd qmd
pnpm install
npm link
```

## Usage

### Collection Management

```sh
# Create a collection from current directory
qmd collection add . --name myproject

# Create a collection with explicit path and custom glob mask
qmd collection add ~/Documents/notes --name notes --mask "**/*.md"

# Comma-separated masks are a union (brace form `{a,b}` also works)
qmd collection add ~/notes --name notes --mask "sources/**/*.md,CO - *.md"

# List all collections
qmd collection list

# Remove a collection
qmd collection remove myproject

# Rename a collection
qmd collection rename myproject my-project

# List files in a collection
qmd ls notes
qmd ls notes/subfolder

# Show collection details (path, glob mask, include status, context count)
qmd collection show notes

# Include or exclude a collection from default (unscoped) queries
qmd collection include notes
qmd collection exclude notes

# Run a command before every `qmd update` (e.g. git pull); empty arg clears it
qmd collection update-cmd notes 'git pull --rebase'
qmd collection update-cmd notes
```

### Generate Vector Embeddings

```sh
# Embed all indexed documents (900 tokens/chunk, 15% overlap)
qmd embed

# Force re-embed everything
qmd embed -f

# Enable AST-aware chunking for code files (TS, JS, Python, Go, Rust)
qmd embed --chunk-strategy auto

# Also works with query for consistent chunk selection
qmd query "auth flow" --chunk-strategy auto

# Memory control for large corpora / constrained systems
qmd embed --max-docs-per-batch 50   # cap docs per embedding batch
qmd embed --max-batch-mb 64         # cap batch size in MB
```

**AST-aware chunking** (`--chunk-strategy auto`) uses tree-sitter to chunk code
files at function, class, and import boundaries instead of arbitrary text
positions. This produces higher-quality chunks and better search results for
codebases. Markdown and other file types always use regex-based chunking
regardless of strategy.

The default is `regex` (existing behavior). Use `--chunk-strategy auto` to
opt in. Run `qmd status` to verify which grammars are available.

> **Note:** Tree-sitter grammars are optional dependencies. If they are not
> installed, `--chunk-strategy auto` falls back to regex-only chunking
> automatically.

### Context Management

Context adds descriptive metadata to collections and paths, helping search understand your content.

```sh
# Add context to a collection (using qmd:// virtual paths)
qmd context add qmd://notes "Personal notes and ideas"
qmd context add qmd://docs/api "API documentation"

# Add context from within a collection directory
cd ~/notes && qmd context add "Personal notes and ideas"
cd ~/notes/work && qmd context add "Work-related notes"

# Add global context (applies to all collections)
qmd context add / "Knowledge base for my projects"

# List all contexts
qmd context list

# Remove context
qmd context rm qmd://notes/old
```

### Configuring `index.yml`

The `collection` and `context` commands above all read and write a single YAML
config file — you can also edit it directly. Everything QMD knows about your
collections (paths, masks, exclusions, per-collection update hooks, contexts, and
optional model overrides) lives here. A fully-commented starter template ships as
[`example-index.yml`](example-index.yml) in this repo.

**Location:** `~/.config/qmd/index.yml` by default. The directory honors
`XDG_CONFIG_HOME` (→ `$XDG_CONFIG_HOME/qmd/index.yml`) and `QMD_CONFIG_DIR`. A
named index uses `{name}.yml` — `qmd --index work …` reads/writes `work.yml`.
A **project-local** index created with `qmd init` lives at `.qmd/index.yml`
(`.qmd/index.yaml` is also accepted) alongside a project-local `index.sqlite`,
so config and index stay inside the project instead of `~/.config` / `~/.cache`.

```yaml
# ~/.config/qmd/index.yml

# Context applied to every collection (system-message style). Optional.
global_context: "Knowledge base for my projects"

# Terminal hyperlink template for search results. Optional.
# Overridden by the QMD_EDITOR_URI env var. See "Editor Links" below.
editor_uri: "vscode://file{path}:{line}:{col}"

# Override the default GGUF models per role. Optional — omit to use the
# built-in defaults. `qmd init` writes this block pre-filled with the
# resolved defaults. See "Model Configuration" for the default URIs.
models:
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf"

# One entry per collection. The key is the collection name.
collections:
  notes:
    path: /Users/me/notes        # absolute path to index (required)
    pattern: "**/*.md"           # glob mask (default: **/*.md)
    ignore:                      # glob patterns to exclude from indexing
      - "Archive/**"
      - "**/drafts/**"
    update: "git pull --rebase"  # bash command run before each `qmd update`
    includeByDefault: true       # include in unscoped queries (default: true)
    context:                     # path prefix → description; longest match wins
      "/": "Personal notes and ideas"
      "/work": "Work-related notes"
```

| Key | Scope | Purpose |
|-----|-------|---------|
| `global_context` | top-level | Context prepended for every collection. Set via `qmd context add /`. |
| `editor_uri` (alias `editor_uri_template`) | top-level | Hyperlink template for clickable result paths; `QMD_EDITOR_URI` overrides. |
| `models.embed` / `.rerank` / `.generate` | top-level | HuggingFace GGUF URIs (`hf:<user>/<repo>/<file>`) overriding the built-in defaults per role. |
| `collections.<name>.path` | per-collection | Absolute directory to index. |
| `collections.<name>.pattern` | per-collection | Glob mask. Set via `qmd collection add --mask`. Default `**/*.md`. Comma-separated lists and brace groups (`{a,b}`) are a union of patterns. |
| `collections.<name>.ignore` | per-collection | Glob patterns excluded from indexing — useful to stop nested collections double-indexing. **YAML-only — no CLI command sets this.** Additive with QMD's built-in exclusions (`node_modules`, `.git`, `.cache`, `vendor`, `dist`, `build`), which you cannot un-ignore. |
| `collections.<name>.update` | per-collection | Bash command run before `qmd update` re-indexes this collection. Set via `qmd collection update-cmd`. |
| `collections.<name>.includeByDefault` | per-collection | Whether unscoped queries search it. Toggle with `qmd collection include`/`exclude`. Default `true`. |
| `collections.<name>.context` | per-collection | Path-prefix → description map; the most specific (longest) matching prefix wins. Set via `qmd context add`. |

> **Note:** Editing `index.yml` changes which directories and models QMD *uses*,
> but does not re-index on its own. Run `qmd update` after changing `path`,
> `pattern`, or `ignore`, and `qmd embed` after changing `models.embed`.

#### Automatic update commands

A collection's `update` field is QMD's built-in refresh hook: when you run
`qmd update`, each collection's `update` command runs **first**, then the
collection is re-indexed. This keeps a collection in sync with an upstream source
(a git remote, a sync script) without wrapping `qmd` yourself.

```yaml
collections:
  wiki:
    path: ~/reference/wiki
    update: "git pull --ff-only"
```

    $ qmd update
    [1/3] wiki (**/*.md)
        Running update command: git pull --ff-only
        Already up to date.
    Collection: ~/reference/wiki (**/*.md)
    Indexed: 0 new, 2 updated, 340 unchanged, 0 removed

The command runs via `bash -c` in the collection's own directory (its `path`), not
your current working directory. If it exits non-zero, `qmd update` prints the
failure and **aborts the entire run** — collections after the failing one are not
re-indexed. Set or clear it from the CLI instead of editing YAML by hand:

```sh
qmd collection update-cmd wiki 'git pull --ff-only'   # set
qmd collection update-cmd wiki                         # clear
```

##### Checked-in `.qmd` config is not trusted by default

A project-local `.qmd/index.yml` travels with a `git clone`, and QMD adopts it
automatically for any command run inside the tree. Three fields in that file can
reach outside the project, and QMD will not use them unattended:

- `update` commands — somebody else's shell script, run by `qmd update`
- `collections.*.path` pointing **outside** the project directory
- `models.embed` / `models.rerank` / `models.generate` other than the built-in
  defaults (any `hf:` repo or local GGUF path)

In-project collection paths (for example `./docs`) still index. On a terminal
`qmd update` (and `qmd embed` / `qmd pull` / `qmd query`) lists the gated
fields and asks. Approving records the approval in `~/.config/qmd/trusted.json`.
With no terminal to ask — agents, CI, MCP — those fields are **skipped** and
in-project indexing continues.

Approvals cover the exact gated set you saw. Editing a command, pointing a
collection outside the project, or changing a custom model URI asks again.

```sh
qmd trust           # review and approve this project's gated fields
qmd trust list      # show every approved project config
qmd trust revoke    # drop the approval for this project
```

Set `QMD_TRUST_LOCAL_CONFIG=1` (or `QMD_TRUST_UPDATE_HOOKS=1`) for CI that
should allow them unattended. Your own `~/.config/qmd/*.yml` — including
anything `qmd collection update-cmd` or `qmd collection add` writes — is
never gated.

### Search Commands

```
┌──────────────────────────────────────────────────────────────────┐
│                        Search Modes                              │
├──────────┬───────────────────────────────────────────────────────┤
│ search   │ BM25 full-text search only                           │
│ vsearch  │ Vector semantic search only                          │
│ query    │ Hybrid: FTS + Vector + Query Expansion + Re-ranking  │
└──────────┴───────────────────────────────────────────────────────┘
```

```sh
# Full-text search (fast, keyword-based)
qmd search "authentication flow"

# Vector search (semantic similarity)
qmd vsearch "how to login"

# Hybrid search with re-ranking (best quality)
qmd query "user authentication"
```

Two aliases exist for the semantic/hybrid modes: `vector-search` (→ `vsearch`)
and `deep-search` (→ `query`).

### Options

```sh
# Search options
-n <num>           # Number of results (default: 5, or 20 for --files/--json)
-c, --collection   # Restrict search to a specific collection
--all              # Return all matches (use with --min-score to filter)
--min-score <num>  # Minimum score threshold (default: 0)
--full             # Show full document content
--line-numbers     # Add line numbers to output
--explain          # Include retrieval score traces (query, JSON/CLI output)
--index <name>     # Use named index
--intent "<text>"  # Legacy CLI alias for rerank context (e.g. "web page load times")
--no-rerank        # Skip LLM reranking (RRF scores only; faster on CPU)
-C, --candidate-limit <n>  # Max candidates to rerank (default: 40)
--full-path        # Emit on-disk filesystem paths instead of qmd:// URIs
                   # (a result whose file has moved or been deleted since
                   #  indexing keeps its qmd:// URI + docid, and a notice is
                   #  printed to stderr — run `qmd update` to refresh)

# Output formats (for search and multi-get)
--format <kind>    # cli (default) | json | csv | md | xml | files
                   # (--json, --csv, --md, --xml, --files are legacy aliases)

# Get options
qmd get <file>[:from[:count]]  # Get document; optional start line and count
-l <num>                       # Maximum lines to return
--from <num>                   # Start line (overrides the :from suffix)
--no-line-numbers              # Disable line numbering (on by default)

# Multi-get options
-l <num>           # Maximum lines per file
--max-bytes <num>  # Skip files larger than N bytes (default: 64KB)
```

### Collection Filtering

The `-c`/`--collection` flag filters results by collection **name** (as shown by
`qmd collection list`). Collections are a global registry — you can search any
collection from any directory:

```sh
qmd search "auth" -c notes           # single collection
qmd search "auth" -c notes -c docs   # multiple collections (OR)
```

With no `-c` flag, all default-included collections are searched. Collections
marked excluded (`qmd collection exclude <name>`) are skipped unless named
explicitly with `-c`.

> **Note:** Multiple `-c` flags are combined with OR and applied before each
> lexical and vector candidate cutoff. Matching candidates from the selected
> collections are then ranked together.

### Output Format

Default output is colorized CLI format (respects `NO_COLOR` env).

When stdout is a TTY, result paths are emitted as clickable terminal hyperlinks (OSC 8). Clicking a path opens the file in your editor using an editor URI template.

When stdout is not a TTY (for example piped to another command or redirected to a file), QMD emits plain text paths with no escape sequences.

TTY example:

```
docs/guide.md:42 #a1b2c3
Title: Software Craftsmanship
Context: Work documentation
Score: 93%

This section covers the **craftsmanship** of building
quality software with attention to detail.
See also: engineering principles


notes/meeting.md:15 #d4e5f6
Title: Q4 Planning
Context: Personal notes and ideas
Score: 67%

Discussion about code quality and craftsmanship
in the development process.
```

Configure the editor link target with `QMD_EDITOR_URI` (or `editor_uri` in config):

```sh
# VS Code (default)
export QMD_EDITOR_URI="vscode://file/{path}:{line}:{col}"

# Cursor
export QMD_EDITOR_URI="cursor://file/{path}:{line}:{col}"

# Zed
export QMD_EDITOR_URI="zed://file/{path}:{line}:{col}"

# Sublime Text
export QMD_EDITOR_URI="subl://open?url=file://{path}&line={line}"
```

Template placeholders:
- `{path}` absolute filesystem path (URI-encoded)
- `{line}` 1-based line number
- `{col}` or `{column}` 1-based column number

- **Path**: Collection-relative path (e.g., `docs/guide.md`)
- **Docid**: Short hash identifier (e.g., `#a1b2c3`) - use with `qmd get #a1b2c3`
- **Title**: Extracted from document (first heading or filename)
- **Context**: Path context if configured via `qmd context add`
- **Score**: Color-coded (green >70%, yellow >40%, dim otherwise)
- **Snippet**: Context around match with query terms highlighted

### Examples

```sh
# Get 10 results with minimum score 0.3
qmd query -n 10 --min-score 0.3 "API design patterns"

# Output as markdown for LLM context
qmd search --md --full "error handling"

# JSON output for scripting
qmd query --json "quarterly reports"

# Inspect how each result was scored (RRF + rerank blend)
qmd query --json --explain "quarterly reports"

# Use separate index for different knowledge base
qmd --index work search "quarterly reports"
```

The `--explain` flag attaches a score breakdown to each result: the FTS/vector
backend scores plus the RRF fusion math (rank, weight, top-rank bonus) and every
sub-query's contribution. Abbreviated:

```json
{
  "docid": "#6c90f0",
  "score": 0.89,
  "file": "qmd://qmd/README.md",
  "explain": {
    "ftsScores": [0.892, 0.907],
    "vectorScores": [0.540, 0.484],
    "rrf": {
      "rank": 1,
      "weight": 0.75,
      "baseScore": 0.123,
      "topRankBonus": 0.05,
      "totalScore": 0.173,
      "contributions": [
        { "source": "fts", "queryType": "original", "query": "reranking",
          "rank": 1, "weight": 2, "backendScore": 0.892, "rrfContribution": 0.0328 }
      ]
    }
  }
}
```

### Index Maintenance

```sh
# Show index status and collections with contexts
qmd status

# Re-index all collections. If a collection has a configured update command
# (e.g. `git pull`), it runs first — set one with `qmd collection update-cmd`.
qmd update

# Diagnose the install (runtime, sqlite-vec, embedding fingerprints, GPU probe)
qmd doctor

# Initialize a project-local index in the current directory
qmd init

# Get document by filepath (with fuzzy matching suggestions)
qmd get notes/meeting.md

# Get document by docid (from search results)
qmd get "#abc123"

# Get document starting at line 50, max 100 lines
qmd get notes/meeting.md:50 -l 100

# Read 40 lines starting at line 120 via the :from:count suffix (works with docids)
qmd get notes/meeting.md:120:40
qmd get "#abc123:120:40"

# get / multi-get are line-numbered by default; disable with --no-line-numbers
qmd get notes/meeting.md --no-line-numbers

# Get multiple documents by glob pattern
qmd multi-get "journals/2025-05*.md"

# Get multiple documents by comma-separated list (supports docids)
qmd multi-get "doc1.md, doc2.md, #abc123"

# Limit multi-get to files under 20KB
qmd multi-get "docs/*.md" --max-bytes 20480

# Output multi-get as JSON for agent processing
qmd multi-get "docs/*.md" --json

# Clean up cache and orphaned data
qmd cleanup
```

### Benchmarking

Measure search quality across all four backends with `qmd bench` and a fixture file
of queries with known-relevant documents.

**From a git checkout**, an example fixture and its test corpus ship in the repo:

```sh
# One-time setup (indexes the repo's test corpus into its own collection)
qmd collection add test/eval-docs --name eval-docs
qmd embed -c eval-docs

# Run the benchmark (table output)
qmd bench src/bench/fixtures/example.json

# JSON output for programmatic analysis
qmd bench src/bench/fixtures/example.json --json
```

> The example fixture (`src/bench/fixtures/example.json`) and its test corpus
> (`test/eval-docs/`) exist only in a git checkout — they are **not** part of the
> published npm package. If you installed via `npm`/`npx`, write your own fixture
> (see below) against a collection you have already indexed:
>
> ```sh
> qmd bench my-fixture.json -c my-collection
> ```

Each query runs against four backends, reporting precision@k, recall, MRR, and F1:

| Backend | What it tests | LLM required |
|---------|---------------|--------------|
| `bm25` | Keyword search only (FTS5) | No |
| `vector` | Semantic similarity only | Embedding model |
| `hybrid` | BM25 + vector fusion (no reranking) | Embedding model |
| `full` | Full pipeline with LLM reranking | All three models |

**Score interpretation:** `1.00` = perfect (all expected docs in top results),
`0.00` = complete miss. The example fixture typically shows bm25 ~0.50, vector
~0.70, and hybrid/full ~1.00 — a concrete demonstration of why hybrid search beats
either backend alone.

**Custom fixtures** are JSON:

```json
{
  "description": "My benchmark",
  "version": 1,
  "collection": "my-collection",
  "queries": [
    {
      "id": "find-auth",
      "query": "authentication flow",
      "type": "semantic",
      "expected_files": ["docs/auth-design.md"],
      "expected_in_top_k": 3
    }
  ]
}
```

`expected_files` are collection-relative paths as shown by `qmd ls`. The `type`
field (`exact`, `semantic`, `topical`, `cross-domain`, `alias`) labels queries for
grouping — it does not change search behavior.

> **Heads-up:** if the fixture's collection isn't indexed, bench currently runs to
> completion and reports all zeros with no warning. Verify setup with
> `qmd ls <collection>` first.

## Data Storage

Index stored in: `~/.cache/qmd/index.sqlite`

### Schema

```sql
collections     -- Indexed directories with name and glob patterns
path_contexts   -- Context descriptions by virtual path (qmd://...)
documents       -- Markdown content with metadata and docid (6-char hash)
documents_fts   -- FTS5 full-text index
content_vectors -- Embedding chunks (hash, seq, pos, 900 tokens each)
vectors_vec     -- sqlite-vec vector index (hash_seq key)
llm_cache       -- Cached LLM responses (query expansion, rerank scores)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory location |
| `XDG_CONFIG_HOME` | `~/.config` | Config directory location (where `index.yml` lives) |
| `QMD_CONFIG_DIR` | unset | Override the config directory outright (takes precedence over `XDG_CONFIG_HOME`) |
| `QMD_LLAMA_GPU` | `auto` | Force llama.cpp GPU backend (`metal`, `vulkan`, `cuda`) or disable GPU with `false` |
| `QMD_FORCE_CPU` | unset | Set to `1`/`true` to force CPU mode before any CUDA/Vulkan/Metal probing. Equivalent CLI flag: `--no-gpu`. |
| `QMD_EMBED_PARALLELISM` | automatic | Override embedding/reranking context parallelism (1-8). Windows CUDA defaults to `1` because parallel CUDA contexts can crash with `ggml-cuda.cu:98`; use Vulkan or raise this only if your driver is stable. |

## How It Works

### Indexing Flow

```
Collection ──► Glob Pattern ──► Markdown Files ──► Parse Title ──► Hash Content
    │                                                   │              │
    │                                                   │              ▼
    │                                                   │         Generate docid
    │                                                   │         (6-char hash)
    │                                                   │              │
    └──────────────────────────────────────────────────►└──► Store in SQLite
                                                                       │
                                                                       ▼
                                                                  FTS5 Index
```

### Embedding Flow

Documents are chunked into ~900-token pieces with 15% overlap using smart boundary detection:

```
Document ──► Smart Chunk (~900 tokens) ──► Format each chunk ──► node-llama-cpp ──► Store Vectors
                │                           "title | text"        embedBatch()
                │
                └─► Chunks stored with:
                    - hash: document hash
                    - seq: chunk sequence (0, 1, 2...)
                    - pos: character position in original
```

### Smart Chunking

Instead of cutting at hard token boundaries, QMD uses a scoring algorithm to find natural markdown break points. This keeps semantic units (sections, paragraphs, code blocks) together.

**Break Point Scores:**

| Pattern | Score | Description |
|---------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| `#### Heading` | 70 | H4 |
| `##### Heading` | 60 | H5 |
| `###### Heading` | 50 | H6 |
| ` ``` ` | 80 | Code block boundary |
| `---` / `***` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |
| `- item` / `1. item` | 5 | List item |
| Line break | 1 | Minimal break |

**Algorithm:**

1. Scan document for all break points with scores
2. When approaching the 900-token target, search a 200-token window before the cutoff
3. Score each break point: `finalScore = baseScore × (1 - (distance/window)² × 0.7)`
4. Cut at the highest-scoring break point

The squared distance decay means a heading 200 tokens back (score ~30) still beats a simple line break at the target (score 1), but a closer heading wins over a distant one.

**Code Fence Protection:** Break points inside code blocks are ignored—code stays together. If a code block exceeds the chunk size, it's kept whole when possible.

**AST-Aware Chunking (Code Files):**

For supported code files, QMD also parses the source with [tree-sitter](https://tree-sitter.github.io/) and adds AST-derived break points that are merged with the regex scores above:

| AST Node | Score | Languages |
|----------|-------|-----------|
| Class / interface / struct / impl / trait | 100 | All |
| Function / method | 90 | All |
| Type alias / enum | 80 | All |
| Import / use declaration | 60 | All |

Supported for `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, and `.rs` files. Enable with `--chunk-strategy auto`. Markdown and other file types always use regex chunking.

### Query Flow (Hybrid)

```
Query ──► Expansion policy (`auto` | `force` | `skip`)
                │
                ▼
  ┌──────────────────────┴──────────────────────┐
  ▼                                             ▼
Original query (×2)                 Zero or more typed variants (×1)
  │                                             │
  ├──► FTS (BM25) ──► Ranked List               ├──► lex ──────► FTS ────► Ranked List
  └──► Vector Search ─► Ranked List             └──► vec/hyde ─► Vector ─► Ranked List
                        │                                             │
                        └──────────────────┬──────────────────────────┘
                                           │
                                           ▼
                                  RRF Fusion (k=60)
                                  Original retrieval paths ×2
                                  Top-rank bonus: +0.05/#1, +0.02/#2-3
                                           │
                                           ▼
                                  Top 30 candidates
                                           │
                                           ▼
                                  LLM Re-ranking
                                  (yes/no + logprob confidence)
                                           │
                                           ▼
                                  Position-Aware Blend
                                  Rank 1-3:  75% RRF / 25% reranker
                                  Rank 4-10: 60% RRF / 40% reranker
                                  Rank 11+:  40% RRF / 60% reranker
                                           │
                                           ▼
                                  Final Results
```

## Model Configuration

The default models are defined in `src/llm.ts` as HuggingFace URIs:

```typescript
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
```

Override them per-role without touching source via the `models:` block in
`index.yml` (see [Configuring `index.yml`](#configuring-indexyml)) or the
`QMD_EMBED_MODEL` env var. Re-run `qmd embed` after changing the embedding model.

### EmbeddingGemma Prompt Format

```
// For queries
"task: search result | query: {query}"

// For documents
"title: {title} | text: {content}"
```

### Qwen3-Reranker

Uses node-llama-cpp's `createRankingContext()` and `rankAndSort()` API for cross-encoder reranking. Returns documents sorted by relevance score (0.0 - 1.0).

### Qwen3 (Query Expansion)

Used for generating query variations via `LlamaChatSession`.

## License

MIT
