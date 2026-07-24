import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CJK_LEXICAL_SCORING_SCHEMA,
  observeLexicalBaseline,
} from "../src/bench/cjk-baseline.js";
import { resolveFixtureQueries } from "../src/bench/fixture.js";
import type { BenchmarkFixture } from "../src/bench/types.js";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/index.js";
import { rebuildCjkLexicalIndex } from "../src/search/cjk-index.js";
import { searchFTS } from "../src/store.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cjkFixturePath = join(testDir, "../src/bench/fixtures/cjk-zh-tw.json");

const cjkBaselinePath = join(testDir, "../src/bench/fixtures/cjk-zh-tw-baseline-v1.json");
const cjkLexicalBaselinePath = join(testDir, "../src/bench/fixtures/cjk-zh-tw-lexical-v1.json");
const cjkDocsDir = join(testDir, "eval-cjk-docs");

describe("resolveFixtureQueries", () => {
  test("resolves stable document IDs to fixture paths", () => {
    const fixture: BenchmarkFixture = {
      description: "CJK fixture",
      version: 2,
      documents: [
        { id: "cache-invalidation", file: "cache-invalidation.md" },
        { id: "auth-failure", file: "auth-failure.md" },
      ],
      queries: [
        {
          id: "shared-cache-01",
          query: "快取失效",
          type: "exact",
          description: "Shared-character false-positive guard",
          relevant_doc_ids: ["cache-invalidation"],
          must_not_match_doc_ids: ["auth-failure"],
          scenario_tags: ["shared-character", "zh-tw"],
          expected_in_top_k: 10,
        },
      ],
    };

    expect(resolveFixtureQueries(fixture)).toEqual([
      expect.objectContaining({
        id: "shared-cache-01",
        expected_files: ["cache-invalidation.md"],
        must_not_match_files: ["auth-failure.md"],
      }),
    ]);
  });

  test("preserves legacy expected_files fixtures", () => {
    const fixture: BenchmarkFixture = {
      description: "Legacy fixture",
      version: 1,
      queries: [
        {
          id: "legacy-01",
          query: "API versioning",
          type: "exact",
          description: "Legacy path-based qrel",
          expected_files: ["api-design.md"],
          expected_in_top_k: 5,
        },
      ],
    };

    expect(resolveFixtureQueries(fixture)[0]).toEqual(
      expect.objectContaining({
        expected_files: ["api-design.md"],
        must_not_match_files: [],
      }),
    );
  });

  test("rejects duplicate stable document IDs", () => {
    const fixture = {
      description: "Duplicate docs",
      version: 2,
      documents: [
        { id: "same", file: "a.md" },
        { id: "same", file: "b.md" },
      ],
      queries: [],
    } satisfies BenchmarkFixture;

    expect(() => resolveFixtureQueries(fixture)).toThrow("duplicate document id 'same'");
  });

  test("rejects unknown and contradictory qrels", () => {
    const unknownFixture = {
      description: "Unknown qrel",
      version: 2,
      documents: [{ id: "known", file: "known.md" }],
      queries: [
        {
          id: "unknown-01",
          query: "unknown",
          type: "exact",
          description: "Unknown qrel",
          relevant_doc_ids: ["missing"],
          scenario_tags: ["zh-tw"],
          expected_in_top_k: 10,
        },
      ],
    } satisfies BenchmarkFixture;
    expect(() => resolveFixtureQueries(unknownFixture)).toThrow("unknown document id 'missing'");

    const overlapFixture = {
      description: "Overlapping qrel",
      version: 2,
      documents: [{ id: "same", file: "same.md" }],
      queries: [
        {
          id: "overlap-01",
          query: "same",
          type: "exact",
          description: "Contradictory qrel",
          relevant_doc_ids: ["same"],
          must_not_match_doc_ids: ["same"],
          scenario_tags: ["zh-tw"],
          expected_in_top_k: 10,
        },
      ],
    } satisfies BenchmarkFixture;
    expect(() => resolveFixtureQueries(overlapFixture)).toThrow(
      "document id 'same' cannot be both relevant and must-not-match",
    );
  });

  test("rejects duplicate qrels that would inflate retrieval metrics", () => {
    const fixture = {
      description: "Duplicate qrels",
      version: 2,
      documents: [{ id: "same", file: "same.md" }],
      queries: [{
        id: "duplicate-qrel",
        query: "same",
        type: "exact",
        description: "duplicate relevance",
        relevant_doc_ids: ["same", "same"],
        must_not_match_doc_ids: [],
        scenario_tags: ["test"],
        expected_in_top_k: 10,
      }],
    } satisfies BenchmarkFixture;

    expect(() => resolveFixtureQueries(fixture)).toThrow(
      "duplicate relevant document id 'same'",
    );
  });
});

describe("Traditional Chinese benchmark fixture", () => {
  test("contains complete stable qrels for every required scenario", () => {
    const fixture = JSON.parse(readFileSync(cjkFixturePath, "utf8")) as BenchmarkFixture;
    const resolvedQueries = resolveFixtureQueries(fixture);

    expect(fixture.version).toBe(2);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(30);
    expect(resolvedQueries).toHaveLength(fixture.queries.length);

    const queryIds = new Set<string>();
    const scenarioTags = new Set<string>();
    for (const query of fixture.queries) {
      expect(query.id).toMatch(/^zh-tw-[a-z0-9-]+-\d{2}$/);
      expect(queryIds.has(query.id)).toBe(false);
      queryIds.add(query.id);

      expect(query.relevant_doc_ids?.length).toBeGreaterThan(0);
      expect(Array.isArray(query.must_not_match_doc_ids)).toBe(true);
      expect(query.scenario_tags?.length).toBeGreaterThan(0);
      for (const tag of query.scenario_tags ?? []) scenarioTags.add(tag);
    }

    expect(scenarioTags).toEqual(new Set([
      "mixed-script",
      "non-cjk-regression",
      "shared-character",
      "taiwan-terminology",
      "unknown-name",
    ]));

    for (const document of fixture.documents ?? []) {
      expect(document.id).toMatch(/^[a-z0-9-]+$/);
      expect(existsSync(join(testDir, "eval-cjk-docs", document.file))).toBe(true);
    }
  });

  test("reproduces the checked-in character-search baseline in a throwaway database", async () => {
    const fixture = JSON.parse(readFileSync(cjkFixturePath, "utf8")) as BenchmarkFixture;
    const baseline = JSON.parse(readFileSync(cjkBaselinePath, "utf8"));
    expect(baseline.baseline_id).toBe("cjk-zh-tw-char-v1");
    expect(baseline.qmd_revision.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof baseline.qmd_revision.worktree_dirty).toBe("boolean");
    expect(baseline.implementation_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(baseline.runtime).toEqual(expect.objectContaining({
      engine: expect.any(String),
      platform: expect.any(String),
      arch: expect.any(String),
    }));
    expect(baseline.latency_ms.observation_only).toBe(true);
    expect(baseline.metrics.shared_character_false_positive_count).toBeGreaterThan(0);
    expect(baseline.approval).toEqual(expect.objectContaining({
      status: "approved",
      approved_by: "project-maintainer",
      approved_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      approved_corpus_sha256: baseline.corpus_sha256,
      approved_implementation_sha256: baseline.implementation_sha256,
      approved_metrics: baseline.metrics,
    }));
    const tempDir = await mkdtemp(join(tmpdir(), "qmd-eval-cjk-"));
    const store = await createStore({
      dbPath: join(tempDir, "index.sqlite"),
      config: {
        collections: {
          "eval-cjk": { path: cjkDocsDir, pattern: "**/*.md" },
        },
      },
    });

    try {
      const updateResult = await store.update();
      expect(updateResult.indexed).toBe(fixture.documents?.length);

      const observed = await observeLexicalBaseline({
        searchCharLex: async (query, options) => store.internal.searchCharFTS(
          query,
          options.limit,
          options.collection,
        ),
      }, fixture, cjkDocsDir, {
        warmupRuns: 5,
        measuredRuns: 50,
      });

      expect(observed.corpus_sha256).toBe(baseline.corpus_sha256);
      expect(observed.scoring_schema).toBe(baseline.scoring_schema);
      expect(observed.runs).toEqual(baseline.runs);
      expect(observed.metrics).toEqual(baseline.metrics);
      expect(observed.latency_ms.p50).toBeGreaterThanOrEqual(0);
      expect(observed.latency_ms.p95).toBeGreaterThanOrEqual(observed.latency_ms.p50);
    } finally {
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("reproduces the checked-in lexical RRF candidate and improves the approved character baseline", async () => {
    const fixture = JSON.parse(readFileSync(cjkFixturePath, "utf8")) as BenchmarkFixture;
    const charBaseline = JSON.parse(readFileSync(cjkBaselinePath, "utf8"));
    const lexicalBaseline = JSON.parse(readFileSync(cjkLexicalBaselinePath, "utf8"));
    expect(lexicalBaseline).toEqual(expect.objectContaining({
      baseline_id: "cjk-zh-tw-lexical-v1",
      corpus_sha256: charBaseline.corpus_sha256,
      implementation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      scoring_schema: CJK_LEXICAL_SCORING_SCHEMA,
      approval: { status: "candidate" },
      performance_observation: {
        measured_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        cold_rebuild_ms: expect.any(Number),
        index_logical_payload_bytes: {
          char: expect.any(Number),
          word: expect.any(Number),
          bigram: expect.any(Number),
        },
        database_file_bytes: expect.any(Number),
        observation_only: true,
      },
      hybrid_observation: {
        runs: { warmup: 1, measured: 20 },
        latency_ms: {
          p50: expect.any(Number),
          p95: expect.any(Number),
        },
        observation_only: true,
      },
    }));
    expect(lexicalBaseline.performance_observation.cold_rebuild_ms).toBeGreaterThan(0);
    expect(lexicalBaseline.performance_observation.index_logical_payload_bytes.char).toBeGreaterThan(0);
    expect(lexicalBaseline.performance_observation.index_logical_payload_bytes.word).toBeGreaterThan(0);
    expect(lexicalBaseline.performance_observation.index_logical_payload_bytes.bigram).toBeGreaterThan(0);
    expect(lexicalBaseline.performance_observation.database_file_bytes).toBeGreaterThan(0);
    expect(lexicalBaseline.hybrid_observation.latency_ms.p50).toBeGreaterThan(0);
    expect(lexicalBaseline.hybrid_observation.latency_ms.p95).toBeGreaterThanOrEqual(
      lexicalBaseline.hybrid_observation.latency_ms.p50,
    );

    const tempDir = await mkdtemp(join(tmpdir(), "qmd-eval-cjk-lexical-"));
    const dbPath = join(tempDir, "index.sqlite");
    const store = await createStore({
      dbPath,
      config: {
        collections: {
          "eval-cjk": { path: cjkDocsDir, pattern: "**/*.md" },
        },
      },
    });
    let storeClosed = false;

    try {
      const updateResult = await store.update();
      expect(updateResult.indexed).toBe(fixture.documents?.length);
      await store.close();
      storeClosed = true;
      await rebuildCjkLexicalIndex(dbPath);

      const db = openDatabase(dbPath);
      try {
        const observed = await observeLexicalBaseline({
          searchCharLex: async (query, options) => searchFTS(
            db,
            query,
            options.limit,
            options.collection,
          ),
        }, fixture, cjkDocsDir, {
          warmupRuns: lexicalBaseline.runs.warmup,
          measuredRuns: lexicalBaseline.runs.measured,
          scoringSchema: CJK_LEXICAL_SCORING_SCHEMA,
        });

        expect(observed.corpus_sha256).toBe(lexicalBaseline.corpus_sha256);
        expect(observed.scoring_schema).toBe(lexicalBaseline.scoring_schema);
        expect(observed.runs).toEqual(lexicalBaseline.runs);
        expect(observed.metrics).toEqual(lexicalBaseline.metrics);
        expect(observed.metrics.recall_at_10).toBeGreaterThanOrEqual(charBaseline.metrics.recall_at_10);
        expect(observed.metrics.mrr_at_10).toBeGreaterThanOrEqual(charBaseline.metrics.mrr_at_10);
        expect(observed.metrics.shared_character_false_positive_count).toBeLessThanOrEqual(
          charBaseline.metrics.shared_character_false_positive_count,
        );
        expect(
          observed.metrics.recall_at_10 > charBaseline.metrics.recall_at_10
          || observed.metrics.mrr_at_10 > charBaseline.metrics.mrr_at_10
          || observed.metrics.shared_character_false_positive_count
            < charBaseline.metrics.shared_character_false_positive_count,
        ).toBe(true);
        expect(lexicalBaseline.latency_ms.observation_only).toBe(true);
        expect(observed.latency_ms.p95).toBeGreaterThanOrEqual(observed.latency_ms.p50);
      } finally {
        db.close();
      }
    } finally {
      if (!storeClosed) await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
