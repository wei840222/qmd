# QMD Query Syntax

QMD queries are structured documents with typed sub-queries. Each line specifies a search type and query text.

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

| Type | Method | Description |
|------|--------|-------------|
| `lex` | BM25 | Keyword search with exact matching |
| `vec` | Vector | Semantic similarity search |
| `hyde` | Vector | Hypothetical document embedding |

## Default Behavior

A QMD query is either a single policy query or a multi-line query document. A
single unprefixed query uses the shared `auto` policy: CJK queries and strong
lexical matches skip model expansion; other queries expand into lex, vec, and
hyde variants. Original lexical and vector retrieval is retained in every mode.

```
# Automatic policy:
how does authentication work

# Force expansion:
expand: how does authentication work

# Explicitly skip expansion:
lex: authentication
```

`expand:` and CLI `--expand` select `force`; standalone `lex:` selects `skip`.
Combining `lex:` with `--expand` is an error. In a multi-line query document,
`lex:` remains a typed lexical sub-query rather than a policy prefix.

## Lex Query Syntax

Lex queries support special syntax for precise keyword matching:

```ebnf
lex_query   = { lex_term } ;
lex_term    = negation | phrase | word ;
negation    = "-" ( phrase | word ) ;
phrase      = '"' { character } '"' ;
word        = { letter | digit | "'" } ;
```

| Syntax | Meaning | Example |
|--------|---------|---------|
| `word` | Prefix match | `perf` matches "performance" |
| `"phrase"` | Exact phrase | `"rate limiter"` |
| `-word` | Exclude term | `-sports` |
| `-"phrase"` | Exclude phrase | `-"test data"` |

### Examples

```
lex: CAP theorem consistency
lex: "machine learning" -"deep learning"
lex: auth -oauth -saml
```

## Vec Query Syntax

Vec queries are natural language questions. No special syntax — just write what you're looking for.

```
vec: how does the rate limiter handle burst traffic
vec: what is the tradeoff between consistency and availability
```

## Hyde Query Syntax

Hyde queries are hypothetical answer passages (50-100 words). Write what you expect the answer to look like.

```
hyde: The rate limiter uses a sliding window algorithm with a 60-second window. When a client exceeds 100 requests per minute, subsequent requests return 429 Too Many Requests.
```

## Multi-Line Queries

Combine multiple query types for best results. First query gets 2x weight in fusion.

```
lex: rate limiter algorithm
vec: how does rate limiting work in the API
hyde: The API implements rate limiting using a token bucket algorithm...
```

## Expand Queries

An expand query stands alone; it is not mixed with typed lines. Use `expand:` or
CLI `--expand` to force expansion. An untyped query uses `auto`, so it may bypass
expansion for CJK text or a strong lexical match.

```
expand: error handling best practices
# auto policy (not necessarily equivalent when bypass conditions apply)
error handling best practices
```

Forced expansion fails explicitly if the expansion model cannot produce usable
variants; it does not silently continue as an unexpanded query.

## Intent

An optional `intent:` line provides background context to disambiguate ambiguous queries. It steers query expansion, reranking, and snippet extraction but does not search on its own.

- At most one `intent:` line per query document
- `intent:` cannot appear alone — at least one `lex:`, `vec:`, or `hyde:` line is required
- Intent is also available via the `--intent` CLI flag or MCP `intent` parameter

```
intent: web page load times and Core Web Vitals
lex: performance
vec: how to improve performance
```

Without intent, "performance" is ambiguous (web-perf? team health? fitness?). With intent, the search pipeline preferentially selects and ranks web-performance content.

## Constraints

- Top-level query must be either a standalone policy query or a multi-line document
- Query documents allow only `lex`, `vec`, `hyde`, and `intent` typed lines (no `expand:` inside)
- `lex` syntax (`-term`, `"phrase"`) only works in lex queries
- At most one `intent:` line per query document; cannot appear alone
- Empty lines are ignored
- Leading/trailing whitespace is trimmed

## Scoping

Restrict queries to specific collections with `-c` (CLI) or `collections` (MCP/SDK):

```bash
# CLI — by collection name (see `qmd collection list`)
qmd query -c docs "how does auth work"
qmd query -c docs -c notes $'lex: auth\nvec: authentication flow'
```

For MCP / HTTP, pass a plural `collections` array (OR match):

```json
{ "searches": [ { "type": "lex", "query": "auth" } ], "collections": ["docs", "notes"] }
```

`-c`/`collections` matches by collection name and works from any directory.
Multiple values are OR-combined. Without scoping, all default-included collections
are searched; collections marked excluded (`qmd collection exclude <name>`) are
skipped unless explicitly named. In MCP the parameter is the plural `collections`
array — a singular `collection` is silently ignored.

## MCP/HTTP API

The `query` tool accepts exactly one of a plain `query` string or a typed
`searches` array. Plain queries support the shared `auto | force | skip`
`expansion` policy and optional `explain`; typed searches bypass expansion:

```json
{
  "searches": [
    { "type": "lex", "query": "CAP theorem" },
    { "type": "vec", "query": "consistency vs availability" }
  ],
  "collections": ["docs"],
  "limit": 10
}
```

Plain query with a policy prefix and explain output:

```json
{
  "query": "lex: CAP theorem",
  "expansion": "auto",
  "explain": true,
  "collections": ["docs"]
}
```

With intent:

```json
{
  "searches": [
    { "type": "lex", "query": "performance" }
  ],
  "intent": "web page load times and Core Web Vitals"
}
```

## CLI

```bash
# Single line (automatic policy)
qmd query "how does auth work"

# Force expansion even for CJK or a strong lexical match
qmd query --expand "資料庫同步"

# Explicitly skip expansion (cannot be combined with --expand)
qmd query "lex: authentication"

# Multi-line with types
qmd query $'lex: auth token\nvec: how does authentication work'

# Structured
qmd query $'lex: keywords\nvec: question\nhyde: hypothetical answer...'

# With intent (inline)
qmd query $'intent: web performance and latency\nlex: performance\nvec: how to improve performance'

# With intent (flag)
qmd query --intent "web performance and latency" "performance"
```
