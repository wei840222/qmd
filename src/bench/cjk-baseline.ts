import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFixtureQueries } from "./fixture.js";
import { percentile, scoreResults } from "./score.js";
import type { BenchmarkFixture } from "./types.js";

export const CJK_BASELINE_SCORING_SCHEMA = "qmd-char-bm25-v1";
export const CJK_LEXICAL_SCORING_SCHEMA = "qmd-cjk-lexical-rrf-v1";

const CJK_BASELINE_IMPLEMENTATION_FILES = [
  "src/bench/cjk-baseline.ts",
  "src/bench/fixture.ts",
  "src/bench/score.ts",
  "src/db.ts",
  "src/store.ts",
] as const;

export interface LexicalBaselineStore {
  searchCharLex(
    query: string,
    options: { limit: number; collection?: string },
  ): Promise<Array<{ filepath: string }>>;
}

export interface LexicalBaselineOptions {
  warmupRuns?: number;
  measuredRuns?: number;
  scoringSchema?: string;
}

export interface LexicalBaselineObservation {
  corpus_sha256: string;
  scoring_schema: string;
  runs: {
    warmup: number;
    measured: number;
  };
  metrics: {
    recall_at_10: number;
    mrr_at_10: number;
    shared_character_false_positive_count: number;
  };
  latency_ms: {
    p50: number;
    p95: number;
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

export function hashBenchmarkCorpus(fixture: BenchmarkFixture, documentsDirectory: string): string {
  if (!fixture.documents?.length) {
    throw new Error("Benchmark fixture must define documents before its corpus can be hashed");
  }

  const hash = createHash("sha256");
  hash.update(JSON.stringify(fixture));
  for (const document of [...fixture.documents].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update("\0");
    hash.update(document.id);
    hash.update("\0");
    hash.update(readFileSync(join(documentsDirectory, document.file)));
  }
  return hash.digest("hex");
}

export function hashBaselineImplementation(projectRoot: string): string {
  const hash = createHash("sha256");
  for (const file of CJK_BASELINE_IMPLEMENTATION_FILES) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(projectRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function observeLexicalBaseline(
  store: LexicalBaselineStore,
  fixture: BenchmarkFixture,
  documentsDirectory: string,
  options: LexicalBaselineOptions = {},
): Promise<LexicalBaselineObservation> {
  const warmupRuns = positiveInteger(options.warmupRuns ?? 5, "warmupRuns");
  const measuredRuns = positiveInteger(options.measuredRuns ?? 50, "measuredRuns");
  const queries = resolveFixtureQueries(fixture);
  if (queries.length === 0) throw new Error("Benchmark fixture must contain at least one query");

  const runQuery = async (query: (typeof queries)[number]) => {
    const startedAt = performance.now();
    const results = await store.searchCharLex(query.query, {
      limit: Math.max(query.expected_in_top_k, 10),
      ...(fixture.collection ? { collection: fixture.collection } : {}),
    });
    const latency = performance.now() - startedAt;
    const scores = scoreResults(
      results.map(result => result.filepath),
      query.expected_files,
      10,
      query.must_not_match_files,
    );
    return {
      latency,
      ranking: results.slice(0, 10).map(result => result.filepath),
      scores,
    };
  };

  for (let run = 0; run < warmupRuns; run++) {
    for (const query of queries) await runQuery(query);
  }

  const latencies: number[] = [];
  let totalRecallAt10 = 0;
  let totalMrrAt10 = 0;
  let totalSharedCharacterFalsePositives = 0;
  const firstRankings = new Map<string, string[]>();

  for (let run = 0; run < measuredRuns; run++) {
    for (const query of queries) {
      const { latency, ranking, scores } = await runQuery(query);
      const firstRanking = firstRankings.get(query.id);
      if (firstRanking === undefined) {
        firstRankings.set(query.id, ranking);
      } else if (
        firstRanking.length !== ranking.length
        || firstRanking.some((file, index) => file !== ranking[index])
      ) {
        throw new Error(`Lexical ranking changed between measured runs for query '${query.id}'`);
      }
      latencies.push(latency);
      totalRecallAt10 += scores.recall_at_10;
      totalMrrAt10 += scores.mrr_at_10;
      if (query.scenario_tags?.includes("shared-character")) {
        totalSharedCharacterFalsePositives += scores.false_positive_count;
      }
    }
  }

  const measuredQueries = measuredRuns * queries.length;
  return {
    corpus_sha256: hashBenchmarkCorpus(fixture, documentsDirectory),
    scoring_schema: options.scoringSchema ?? CJK_BASELINE_SCORING_SCHEMA,
    runs: { warmup: warmupRuns, measured: measuredRuns },
    metrics: {
      recall_at_10: roundMetric(totalRecallAt10 / measuredQueries),
      mrr_at_10: roundMetric(totalMrrAt10 / measuredQueries),
      shared_character_false_positive_count: roundMetric(
        totalSharedCharacterFalsePositives / measuredRuns,
      ),
    },
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
  };
}
