# QMD Coding Agent Guide

Use this file when changing QMD. The README explains the architecture and usage
for human readers; keep implementation instructions and safeguards here.

## Working conventions

- Use Node.js >=26.0.0 and pnpm. Do not substitute npm or Bun commands.
- Inspect the current tree and nearby tests before editing. Match existing code
  and fixture conventions; keep changes within the requested scope.
- Add user-facing changes under `## [Unreleased]` in `CHANGELOG.md` as you work.
- Keep README explanations organized around architecture, setup, and use. Keep
  this guide organized around where to change code, how to verify it, and the
  constraints that must survive a change. `example-index.yml` is a copyable
  configuration example: leave remote models opt-in and never add real keys.
- Use the README for CLI flags and collection/context tutorials rather than
  duplicating that command reference here.

## Source map

| Area | Files |
|------|-------|
| CLI commands and diagnostics | `src/cli/qmd.ts` |
| Public SDK and config reconciliation | `src/index.ts` |
| Store, indexing, retrieval, rerank caching, embedding builds, cleanup | `src/store.ts` |
| Node SQLite connections and transactions | `src/db.ts` |
| Vector tables, collection ids, row mappings | `src/vec-layout.ts` |
| Versioned schema/layout conversion | `src/store-migrations.ts` |
| Hybrid routing and fallback | `src/hybrid.ts` |
| Expansion/chat/dedicated rerank requests | `src/remote-llm.ts` |
| Embedding identity, leases, providers | `src/embedding/` |
| CJK indexing and synchronized mutations | `src/search/cjk-index.ts` |
| YAML collection/model config | `src/collections.ts` |
| Metadata filters and discovery | `src/metadata-filter.ts`, `src/metadata-store.ts` |
| Maintenance API and MCP transports | `src/maintenance.ts`, `src/mcp/server.ts` |
| Tests and retrieval fixtures | `test/` |

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm qmd --help
# Example focused test; choose the file affected by your change
pnpm exec vitest run --reporter=verbose test/collections-config.test.ts
pnpm run lint
pnpm exec tsc -p tsconfig.json --noEmit
pnpm test
```

Choose focused tests for the change, then run the checks appropriate to shipping
it. `pnpm test` runs the build-config typecheck, Vitest, and package smoke; it
**does not** replace the separate full-project `tsconfig.json` check above.

| Change | Additional verification |
|--------|-------------------------|
| Retrieval, CJK, ranking | `pnpm run test:quality`; retain retrieval-quality regressions |
| CJK size/latency | `pnpm run measure:cjk` |
| Remote runtime | `pnpm run test:remote` with mocks or loopback HTTP |
| Packaging/native grammars | `pnpm run test:package` |
| Docs/example config | Parse YAML and changed shell/JSON examples; check claims against source |

Builds stamp the source commit in `dist/cli/build-info.json`; check
`qmd --version` for the commit as well as the package version. A linked global
CLI runs from its resolved checkout. Do not update a live install as a side
effect of tests or documentation work.

## Runtime contract

- Keep BM25, CJK, AST, document reads, collections/contexts, and maintenance usable
  without models. Embedding, expansion, and reranking use explicitly configured
  remote APIs. Never add local inference, model downloads, automatic remote
  requests, or silent embedding-provider fallback.
- `qmd pull` is retired: it must exit nonzero without downloads. Do not restore
  retired local-model classes, training/conversion tools, Python ML locks, or
  GPU/Bun container workflows. Preserve legacy-index recognition/rejection tests.
- Keep chunking identities compatible. Default strategy is `regex`; `auto` uses
  tree-sitter for supported code files, while Markdown/unknown types use regex.
- Preserve metadata-filter semantics, bound SQL parameters, CJK publication and
  synchronized document/collection mutations when changing retrieval or storage.

## Index safety

- Tests use temporary databases. Never open `~/.cache/qmd/index.sqlite` to test a
  change, migration, or documentation example. Never edit SQLite data directly.
- Do not run `qmd collection add`, `qmd embed`, or `qmd update` automatically;
  provide manual examples unless the user explicitly authorizes the operation.
- The first **writable** store open can migrate an older vector layout. MCP,
  read-only SDK stores, and `qmd status` do not run that migration. `qmd doctor`
  can open writable when it parses a config. `qmd cleanup --dry-run` also opens
  writable before previewing: it skips cleanup actions, not initialization.
- A real-index upgrade requires explicit user authorization. Stop all holders,
  copy the main database and existing WAL/SHM while quiescent, and verify the
  backup before official initialization (for example `qmd ls`). Do not use
  embed/update as an upgrade step. Verify retained vector bytes, documents, and
  embedding identity before restarting clients.
- Rollback must move aside every converted component and restore the exact
  backup set. Never mix an old main file with new WAL/SHM. Without a pre-upgrade
  backup, an older layout requires a full paid embedding rebuild.

## Vector and embedding invariants

- Keep table names in `src/vec-layout.ts`. `vectors_by_collection` is partitioned
  by integer collection id; `vector_rows` maps rowids to `(hash, seq, collection_id)`;
  `vector_collection_ids` maps names to ids.
- Preserve identity/fingerprint, generation, owner, and expiry checks for embedding
  writes, repair/prune, reset, and publication. Use existing lease/ready fixtures
  when writing vector tests; prefer real SQLite connections and statement spies
  for transaction failures.
- Copying stored vectors into a gained collection only adds rows, needs no build
  lease, and deletes nothing. A live chunk with no vector keeps its metadata and
  stays pending; the next embed recreates only that chunk, not the whole document.
- Repack moves existing bytes under the same rowid and partition in one IMMEDIATE
  transaction per chunk. Re-read under the write lock and preserve metadata,
  identity, lease state, rollback, and rowid-reuse behavior. Repack needs no build
  lease and must not turn into a model request, rebuild, or metadata deletion.
  Cleanup triggers it below 90% useful-chunk occupancy when an older sparse chunk
  can move. `previewCleanup` only projects counts/layouts.
- Preserve upstream layout conversion semantics; do not call it lossless. For a
  readable `hash_seq`-keyed legacy table with parsed dimensions, it copies bytes
  only where chunk metadata belongs to an active document. It makes no model
  request, never re-embeds, and does not change `embedding_index_state` itself.
  Vectors without metadata/active documents are not copied; vectorless metadata
  is deleted during conversion, unlike normal cleanup of a live chunk. An
  unsupported readable legacy format is dropped without copying. The final
  straggler copy, metadata cleanup, schema stamp, and table drop share a transaction;
  do not allow an old build to write concurrently. Without sqlite-vec, conversion
  is deferred and lexical reads remain available.

## Remote configuration and routing

- Use existing `models.embed_*`, `generate_*`, `rerank_*`, and `jev_*` fields.
  URL precedence is `*_url` > `*_base_url` > `*_api_url`; choose one alias.
  Embedding takes a base URL and appends `/embeddings`. Expansion/rerank accept
  bases or full `/chat/completions` / `/rerank` endpoints. A rerank HTTP 404 retries
  a chat payload at the same URL; it does not discover a sibling endpoint.
- Embeddings use `models.embed_api_key` before the provider environment key:
  OpenAI uses `OPENAI_API_KEY`; Voyage uses `VOYAGE_API_KEY`, then `OPENAI_API_KEY`
  only for custom proxies. Expansion/rerank use only `generate_api_key` /
  `rerank_api_key`, without `OPENAI_API_KEY` fallback. Jev supports `jev_*` and
  `TYPESAFE_*`. YAML does not interpolate environment placeholders. Do not expose
  credentials in checked-in files, SQLite, diagnostics, logs, or errors.
- A rerank URL **and** model enable API reranking. It takes priority over Jev;
  Jev reranks only when absent or failed, never after cancellation. Jev supplies
  expansion intent hints and does not replace the configured generator.
- Dedicated rerank responses must contain `results[].{index,relevance_score}`;
  Voyage-shaped `data` needs translation by a gateway. Chat URLs score with an LLM.
- `RemoteLLM` request failure must not disable later requests. `Hybrid` applies a
  60-second rerank API cooldown only when Jev can serve as fallback; without Jev,
  each explicit request retries the API.
- Cache scores under the producing model and map them back by `index`, not file.
  If fallback answers alongside preferred-model cached chunks, rescore all chunks
  with one model so a ranking never mixes model scores.

## MCP and deployment

- Keep HTTP bodies bounded to 1 MiB while reading, before parsing, including
  chunked requests and the REST aliases. Keep the SDK's 10,000-element tool input
  limit enabled before schema validation. Oversized uploads must receive 413
  without destroying the socket before the response can be sent.
- Existing indexes are opened read-only by stdio/HTTP MCP. Reconcile manual
  collection/context YAML edits through a writable CLI open before restarting;
  MCP does not sync those settings. Restart after code/model/config changes.
- Model-free MCP checks use `query` arguments
  `{"searches":[{"type":"lex","query":"..."}],"rerank":false}`.
  Typed `lex` skips expansion/vector retrieval but does not itself turn off the
  default reranker. `/health` checks liveness, not model or retrieval health.
- systemd owns a foreground MCP process: do not add `--daemon`. Restart the actual
  user unit; `qmd mcp stop` only handles QMD-managed daemons. Keep deployment and
  real-index actions within the user's authorization.

## Releases

Before each release, perform the read-only three-source upstream check in the
[release skill's dictionary preflight](.agents/skills/release/SKILL.md#dictionary-upstream-preflight):
compare `@node-rs/jieba`, `APCLab/jieba-tw`, and `sysprog21/zhtw-mcp` with
`src/search/zh-dict.sources.json`. Report available updates before cutting a tag;
resolve whether to refresh or retain reviewed pins. Failed lookups remain
unverified. `pnpm run dict:sync` writes files, and `--update-pins` advances only the
two Git sources; neither is a read-only version check. Follow the skill's refresh
steps when updates are in scope, keeping package/lock/source pins, generated
dictionary, third-party notices, and version-specific tests consistent. Never
fetch these sources automatically at runtime, build, or install time.

Use `/release <version>` only when requested. Follow the
[release skill](.agents/skills/release/SKILL.md) for checks, hooks, and cutting a
release. It renames `[Unreleased]` at release time; keep external PR credits in
changelog entries. GitHub releases roll up the full minor series.
