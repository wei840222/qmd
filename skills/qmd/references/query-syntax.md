# QMD Query Syntax Reference

QMD queries are structured documents composed of typed sub-queries. Each line specifies a search type and query text. The hybrid retrieval engine combines results via Reciprocal Rank Fusion (RRF) and reranks them.

## Grammar

```ebnf
query          = policy_query | query_document ;
policy_query   = [ policy_prefix ] text ;
policy_prefix  = "lex:" | "expand:" ;
query_document = [ intent_line ] { typed_line } ;
intent_line    = "intent:" text newline ;
typed_line     = type ":" text newline ;
type           = "lex" | "vec" | "hyde" ;
text           = quoted_phrase | plain_text ;
quoted_phrase  = '"' { character } '"' ;
plain_text     = { character } ;
newline        = "\n" ;
```

## Query Types

| Type | Method | Best For | Description |
|------|--------|----------|-------------|
| `lex` | BM25 (FTS5) | Exact terms, identifiers, code, titles | Keyword search with prefix, phrase, and negation support |
| `vec` | Vector | Natural language concepts | Semantic similarity search using local/remote embeddings |
| `hyde` | Vector | Complex conceptual questions | Hypothetical Document Embedding (generate expected passage) |

## Default Policy & Expansion Behavior

A query is either a single policy query or a multi-line query document:
- **`auto` (Default)**: CJK queries and strong lexical matches automatically bypass model expansion. Other plain queries expand into `lex`, `vec`, and `hyde` variants.
- **`expand:` / `--expand` (`force`)**: Explicitly forces expansion even if bypass heuristics apply.
- **`lex:` (`skip`)**: Explicitly disables expansion and performs direct BM25 search.

```bash
# Automatic policy:
qmd query "how does authentication work"

# Force expansion:
qmd query "expand: how does authentication work"
# or: qmd query --expand "資料庫同步"

# Explicitly skip expansion:
qmd query "lex: authentication"
```

## Lexical Search Syntax (`lex:`)

Lex queries support powerful search operators:

| Syntax | Meaning | Example | Notes |
|--------|---------|---------|-------|
| `word` | Prefix match | `perf` | Matches "performance", "perform", etc. |
| `"phrase"` | Exact phrase match | `"rate limiter"` | Terms must appear consecutively in order |
| `-word` | Exclude term | `-sports` | Documents containing this word are excluded |
| `-"phrase"` | Exclude phrase | `-"test data"` | Documents containing this phrase are excluded |

### Examples

```
lex: CAP theorem consistency
lex: "machine learning" -"deep learning"
lex: auth -oauth -saml
```

## Vector Search Syntax (`vec:`)

Natural language questions or descriptive phrases:

```
vec: how does the rate limiter handle burst traffic
vec: what is the tradeoff between consistency and availability
```

## Hypothetical Document Embeddings (`hyde:`)

A 50–100 word hypothetical answer passage representing what the target document likely says:

```
hyde: The rate limiter uses a sliding window counter algorithm with a 60-second window. When a client exceeds 100 requests per minute, subsequent requests return 429 Too Many Requests.
```

## Multi-Line Structured Queries

Combine multiple sub-query types for optimal retrieval. The first sub-query receives **2x weight** during Reciprocal Rank Fusion:

```
lex: rate limiter algorithm
vec: how does rate limiting work in the API
hyde: The API implements rate limiting using a token bucket algorithm...
```

## Disambiguating with `intent:`

An optional `intent:` line provides background context to disambiguate ambiguous queries. It steers query expansion, reranking, and snippet selection without generating search vectors itself:

- At most one `intent:` line per query document.
- Must be combined with at least one `lex:`, `vec:`, or `hyde:` line.
- Can also be passed via the `--intent` CLI flag or MCP `intent` parameter.

```
intent: web page load times and Core Web Vitals
lex: performance
vec: how to improve performance
```

## Collection Scoping

Scope search to specific collections using `-c` (CLI) or `collections` (MCP/SDK):

```bash
# CLI:
qmd query -c docs "how does auth work"
qmd query -c docs -c notes $'lex: auth\nvec: authentication flow'
```

## MCP Tool Call Payloads

When calling the `qmd` MCP server's `query` tool, provide a structured `searches` array:

### Standard Multi-Modal Query

```json
{
  "searches": [
    { "type": "lex", "query": "CAP theorem" },
    { "type": "vec", "query": "consistency vs availability tradeoffs in distributed storage" }
  ],
  "collections": ["docs"],
  "limit": 10
}
```

### Query with Disambiguating Intent

```json
{
  "searches": [
    { "type": "lex", "query": "performance metrics" },
    { "type": "vec", "query": "page load and network latency optimization" }
  ],
  "intent": "Front-end web performance and Core Web Vitals optimization",
  "collections": ["frontend", "notes"],
  "limit": 5
}
```

### Plain Query with Policy Control & Explain Trace

```json
{
  "query": "CAP theorem consistency",
  "expansion": "auto",
  "explain": true,
  "collections": ["docs"]
}
```
