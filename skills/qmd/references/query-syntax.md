# QMD Query Syntax Reference

Use this reference to construct CLI queries and MCP requests. The
[README query guide](../../../README.md#query-syntax) explains the user-facing
search choices. Remote expansion, embedding, and reranking use configured APIs;
there is no local inference fallback or model download.

## Choose the input form

| Input | CLI `qmd query` | MCP `query` tool |
|-------|-----------------|------------------|
| Plain text | Shared expansion policy, then hybrid retrieval | Use the `query` string |
| Standalone `lex: text` | Plain-query policy: skip expansion | Same policy inside the `query` string |
| Standalone `expand: text` | Plain-query policy: force expansion | Same policy inside the `query` string |
| Typed `lex` / `vec` / `hyde` searches | A query document; a single `vec:` or `hyde:` line also qualifies | Use the `searches` array, not a multiline `query` string |

A single CLI `lex:` line is deliberately routed through the plain-query policy.
To supply a typed lexical document, use multiple search lines or an `intent:`
line plus a `lex:` line. For straightforward model-free CLI search, prefer
`qmd search`.

## Expansion and remote calls

Plain queries use `auto` by default:

- A strong lexical match can bypass expansion, except when relative-time wording
  or non-empty expansion/rerank context disables that shortcut.
- CJK skips expansion when no expansion-capable service is configured. With one
  configured, CJK can expand.
- `expand:` or CLI `--expand` selects `force`; standalone `lex:` selects `skip`.
  For MCP plain queries, set `expansion` to `auto`, `force`, or `skip`. Explicit
  policies override `auto`; a `lex:` directive conflicts with `force`.
- Forced expansion fails if no usable variants are produced; it does not
  silently continue unexpanded.

Skipping expansion retains original-query keyword retrieval and, when a
searchable vector index exists, remote embedding and vector retrieval. It does
not disable reranking. Thus even CLI `qmd query --no-rerank 'lex: auth'` is not an
offline guarantee.

Typed searches bypass expansion policy evaluation. Each `lex` search uses local
BM25; `vec` and `hyde` use remote embeddings and need a compatible vector index
for vector retrieval. Reranking defaults to enabled in both input forms. Disable
it with CLI `--no-rerank` or MCP/SDK `rerank: false`.

CLI `--no-hyde` / SDK `includeHyde: false` controls generated expansion variants;
it does not remove a typed HyDE passage supplied by the caller.

## CLI query documents and validation

In Bash/Zsh, `$'...'` converts `\n` into real newlines. Other callers must supply
actual newline characters; a literal backslash followed by `n` is not a line
separator.

```bash
qmd query $'lex: rate limiter\nvec: how does the API limit burst traffic'
qmd query 'hyde: The API uses a token bucket and rejects excess requests with HTTP 429.'
qmd query --no-rerank $'lex: authentication\nlex: auth token'
```

- Each non-empty line must be `lex: text`, `vec: text`, `hyde: text`, or
  `intent: text`, with non-empty text. Prefixes are case-insensitive; use the
  canonical lowercase spelling.
- Blank lines are ignored; leading/trailing whitespace is trimmed. The last line
  does not require a newline.
- At least one search line is required. At most one `intent:` line is allowed,
  in any position; it cannot stand alone. Search types may repeat.
- Do not mix untyped lines or `expand:` lines into a document. `--expand` is a
  plain-query policy, not a request to expand caller-supplied typed searches.
- Each search text must stay on one line. Lexical quotes must be balanced.
  Semantic `vec`/`hyde` text rejects token-boundary exclusions such as `-term`
  and `-"phrase"`; ordinary hyphenated words remain valid.

The first supplied search receives 2x weight in structured Reciprocal Rank Fusion;
other searches receive 1x. This refers to search order, not collection order or
which search happens to return results first. Put the strongest signal first.

## Search text by type

### Lexical (`lex` or `qmd search`)

| Form | Meaning |
|------|---------|
| `perf` | Word-prefix match, such as `performance` |
| `auth token` | Positive terms combined with AND |
| `"rate limiter"` | Consecutive tokens in order |
| `auth -oauth` | Positive match excluding a term |
| `auth -"test data"` | Positive match excluding a phrase |

A query made only of negative terms returns no matches. Separator-containing
terms such as `multi-agent`, `2026.4.10`, and `src/lib/i18n.ts` become adjacent-token
phrases without ordinary word-prefix expansion. CJK terms use character phrases.

### Semantic (`vec`)

Use natural-language questions or descriptions, not lexical operators:

```text
vec: what tradeoff does the design make between consistency and availability
```

### Hypothetical passage (`hyde`)

Supply a plausible answer passage in the target document's style. Around 50–100
words can be useful; this is writing guidance, not a validated length requirement.
The supplied passage is embedded directly, not generated by the HyDE search.

```text
hyde: The rate limiter uses a sliding window counter. When a client exceeds its quota, subsequent requests return HTTP 429 until the window advances.
```

## Intent and context precedence

Intent disambiguates searches; it is not an extra search term or vector.

- CLI `--intent` overrides an inline `intent:` line. For `qmd query`, it supplies
  `rerankContext`, not `expansionContext`; do not promise it steers expansion.
- MCP `intent` is a fallback for both `expansionContext` and `rerankContext`.
  An explicitly supplied context wins independently for its stage.
- Typed searches do not expand, regardless of intent.

```bash
qmd query $'intent: web page load times and Core Web Vitals\nlex: performance\nvec: how to reduce page load time'
qmd query --intent 'web page load times' 'performance'
```

## Collection scoping

Use repeatable CLI `-c <name>` or the plural MCP `collections` array. Names are
OR-combined and work from any directory. CLI and MCP searches without explicit
scoping use collections included in default queries; naming an excluded
collection includes it for that request. A singular MCP `collection` field is
not the supported scope parameter.

SDK `store.search()` also accepts `collections`, but does not apply the CLI/MCP
default-inclusion policy. Pass collection names explicitly when the SDK caller
needs that scope; omission leaves collection scope unrestricted.

```bash
qmd query -c docs -c notes $'lex: auth\nvec: authentication flow'
```

## MCP tool requests

The `query` tool accepts one plain `query` string or a non-empty `searches` array,
not both. Typed arrays contain at most 10 searches. Each entry has `type` and
`query`, and each query text must be non-empty and single-line. Typed `lex`
entries bypass expansion and vector retrieval; explicitly disable reranking for
model-free operation.

### Model-free lexical request

```json
{
  "searches": [{ "type": "lex", "query": "CAP theorem" }],
  "collections": ["docs"],
  "limit": 10,
  "rerank": false
}
```

### Typed retrieval with intent

This example requires remote embeddings and enabled reranking configuration:

```json
{
  "searches": [
    { "type": "lex", "query": "performance metrics" },
    { "type": "vec", "query": "page load and network latency optimization" }
  ],
  "intent": "Front-end web performance and Core Web Vitals",
  "collections": ["frontend", "notes"],
  "limit": 5
}
```

### Plain query with policy and explain output

```json
{
  "query": "CAP theorem consistency",
  "expansion": "auto",
  "explain": true,
  "collections": ["docs"]
}
```

These payloads describe the MCP tool over stdio or HTTP `/mcp`. The REST aliases
`POST /query` and `POST /search` instead require a typed `searches` array; they do
not support the plain-query alternative or the MCP `intent` alias. Use
`rerankContext` for reranking context on those typed-only routes.
