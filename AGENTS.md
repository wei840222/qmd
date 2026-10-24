# QMD - Query Markup Documents

Use Node.js (>=24.21.0) and pnpm (`pnpm` not `npm` or `bun`, `pnpm install` not `npm install`).

## Commands

```sh
qmd collection add . --name <n>   # Create/index collection
qmd collection list               # List all collections with details
qmd collection remove <name>      # Remove a collection by name
qmd collection rename <old> <new> # Rename a collection
qmd init                          # Create a project-local .qmd index
qmd ls [collection[/path]]        # List collections or files in a collection
qmd context add [path] "text"     # Add context for path (defaults to current dir)
qmd context list                  # List all contexts
qmd context check                 # Check for collections/paths missing context
qmd context rm <path>             # Remove context
qmd get <file>[:from[:count]]     # Get by path or docid (#abc123); optional line range
qmd multi-get <pattern>           # Get multiple docs by glob or comma-separated list
qmd status                        # Show index status and collections
qmd doctor                        # Diagnose config, index, model, and device issues
qmd update                        # Re-index collections; configured update hooks run first
qmd trust [list|revoke]           # Approve a checked-in .qmd config's hooks/paths/models
qmd embed                         # Generate vectors through the configured remote embedding API
qmd cleanup [--dry-run]           # Drop inactive docs/orphans, compact FTS, vacuum
qmd skills list|get|path          # List and retrieve bundled runtime skills
qmd skill show|install            # Show or install the QMD skill (writes ./.agents/skills/qmd)
qmd query <query>                 # Search with query expansion + reranking (recommended)
qmd search <query>                # Full-text keyword search (BM25, no LLM)
qmd vsearch <query>               # Vector similarity search (no reranking)
qmd bench <fixture.json>          # Run search-quality benchmarks
qmd mcp                           # Start MCP server (stdio transport)
qmd mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
qmd mcp --http --daemon           # Start as background daemon
qmd mcp stop                      # Stop background MCP daemon
```

## Collection Management

```sh
# List all collections
qmd collection list

# Create a collection with explicit name
qmd collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
qmd collection remove mynotes

# Rename a collection
qmd collection rename mynotes my-notes

# Show collection details
qmd collection show mynotes

# Set or clear the pre-update hook (runs before re-indexing on `qmd update`)
qmd collection update-cmd mynotes 'git pull --ff-only'
qmd collection update-cmd mynotes            # clear

# Include or exclude from default (unscoped) queries
qmd collection exclude mynotes
qmd collection include mynotes

# List all files in a collection
qmd ls mynotes

# List files with a path prefix
qmd ls journals/2025
qmd ls qmd://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
qmd context add "Description of these files"

# Add context to a specific path
qmd context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
qmd context add / "Always include this context"

# Add context using virtual paths
qmd context add qmd://journals/ "Context for entire journals collection"
qmd context add qmd://journals/2024 "Journal entries from 2024"

# List all contexts
qmd context list

# Check for collections or paths without context
qmd context check

# Remove context
qmd context rm qmd://journals/2024
qmd context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
qmd search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
qmd get "#abc123"
qmd get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
qmd multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to collection(s) (repeatable)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--intent <text>          # Describe what you're after to sharpen ranking (query)
--no-rerank              # Skip LLM reranking (faster, lower quality)
--full-path              # Show on-disk paths instead of qmd:// URIs

# Get / multi-get
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 64KB)
--no-line-numbers        # Disable line numbers (on by default for get/multi-get)

# Output format (search, query, multi-get)
--format <kind>          # cli (default) | json | csv | md | xml | files
                         # legacy --json/--csv/--md/--xml/--files still work as aliases
```

## Development

```sh
pnpm qmd <command>       # Run from source (or: npx tsx src/cli/qmd.ts <command>)
npm link                 # Install globally as 'qmd'
```

## Tests & Benchmarks

All tests live in `test/`. Run everything:

```sh
pnpm test
npx vitest run --reporter=verbose test/
```

Run CJK evaluation & benchmarks:

```sh
pnpm run test:quality   # Run CJK search retrieval quality tests (test/eval-cjk.test.ts)
pnpm run measure:cjk    # Measure CJK rebuild latency, DB payload size, and recall/MRR
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- Remote embedding APIs (OpenAI-compatible and Voyage), expansion/reranking endpoints, and TypeSafe Jev; no local inference or model downloads
- Reranking order (`src/hybrid.ts`): a configured `models.rerank_api_*` endpoint is used first. TypeSafe Jev reranks only when none is configured, or as a fallback when that API fails (never after cancellation). Jev still classifies intent for query expansion either way.
- Rerank API: a `rerank_api_url` ending in `/rerank` posts `{model, query, documents}` and reads Cohere-style `results[].{index, relevance_score}`; one ending in `/chat/completions` scores with an LLM. Voyage's own `/v1/rerank` answers with `data`, not `results`, so reach it through a Cohere-shaped gateway or proxy.
- A failed rerank API is skipped for a cooldown (60 seconds by default, `rerankCooldownMs` on `RemoteLLM`) and then retried, so one outage does not disable it for the process.
- Rerank scores are cached under the model that produced them (the result's `model`), and results map back to chunks by `index`, not filename. When a fallback answers while other chunks came from the preferred model's cache, every chunk is rescored in one call so a ranking never mixes two models' scores.
- Reciprocal Rank Fusion (RRF) for combining results
- Smart chunking: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries
- AST-aware chunking: use `--chunk-strategy auto` to chunk code files (.ts/.js/.py/.go/.rs) at function/class/import boundaries via tree-sitter. Default is `regex` (existing behavior). Markdown and unknown file types always use regex chunking.

## Important: Do NOT run automatically

- Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/qmd/index.sqlite`

## Building

- `pnpm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json`

## Releasing

Use `/release <version>` to cut a release. Full changelog standards,
release workflow, and git hook setup are documented in the
[release skill](.agents/skills/release/SKILL.md).

Key points:
- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time
- Credit external PRs with `#NNN (thanks @username)`
- GitHub releases roll up the full minor series (e.g. 1.2.0 through 1.2.3)

## Remote-only runtime

This review build is `2026.10.18-remote.0`. Keep BM25, CJK, AST, reads, collections,
contexts, and maintenance usable without models. Configure remote operations
through existing `models.embed_*`, `generate_*`, `rerank_*`, and `jev_*` fields.
Never add automatic remote requests, local inference fallback, model downloads,
or automatic migration/deletion of old vectors. Old local databases remain
lexically readable; vector conversion requires an explicit manual remote rebuild.
`qmd pull` is retired and must exit nonzero without downloads. Tests and package
smoke use mocks or loopback HTTP, with no paid API or local-model setup.

Model-training datasets, fine-tuning/conversion tools, Python ML dependency locks,
and the retired GPU/Bun container smoke workflow are no longer maintained here.
Use `pnpm run test:remote` and `pnpm run test:package` for runtime and installation
checks. Keep legacy local index recognition, rejection regressions, BM25/CJK/AST,
and retrieval-quality benchmarks; local identity labels do not enable inference.
