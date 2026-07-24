#!/usr/bin/env bun

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { BenchmarkFixture } from "../src/bench/types.ts";
import {
  CJK_LEXICAL_SCORING_SCHEMA,
  observeLexicalBaseline,
} from "../src/bench/cjk-baseline.ts";
import { resolveFixtureQueries } from "../src/bench/fixture.ts";
import { percentile } from "../src/bench/score.ts";
import { openDatabase } from "../src/db.ts";
import { createStore } from "../src/index.ts";
import { rebuildCjkLexicalIndex } from "../src/search/cjk-index.ts";
import { searchFTS } from "../src/store.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(projectRoot, "src", "bench", "fixtures", "cjk-zh-tw.json");
const documentsDirectory = join(projectRoot, "test", "eval-cjk-docs");
const scratchRoot = process.env.TMPDIR ?? tmpdir();
const tempDir = await mkdtemp(join(scratchRoot, "qmd-measure-cjk-"));
const dbPath = join(tempDir, "index.sqlite");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as BenchmarkFixture;
let output: Record<string, unknown>;

let store = await createStore({
  dbPath,
  config: {
    collections: {
      "eval-cjk": { path: documentsDirectory, pattern: "**/*.md" },
    },
  },
});

try {
  const updateResult = await store.update();
  if (updateResult.indexed !== fixture.documents?.length) {
    throw new Error(`Expected ${fixture.documents?.length ?? 0} indexed documents, got ${updateResult.indexed}`);
  }
  await store.close();

  const staleDb = openDatabase(dbPath);
  try {
    staleDb.prepare(`
      UPDATE cjk_index_state
      SET analyzer_fingerprint = 'benchmark-stale-fingerprint'
      WHERE singleton = 1
    `).run();
  } finally {
    staleDb.close();
  }

  const rebuildStartedAt = performance.now();
  await rebuildCjkLexicalIndex(dbPath);
  const coldRebuildMs = performance.now() - rebuildStartedAt;

  const db = openDatabase(dbPath);
  try {
    const logicalPayloadBytes = (table: string): number => {
      const row = db.prepare(`
        SELECT
          COALESCE((SELECT SUM(length(block)) FROM ${table}_data), 0)
          + COALESCE((SELECT SUM(length(term)) + SUM(length(segid)) + SUM(length(pgno)) FROM ${table}_idx), 0)
          + COALESCE((SELECT SUM(length(c0)) + SUM(length(c1)) + SUM(length(c2)) FROM ${table}_content), 0)
          + COALESCE((SELECT SUM(length(sz)) FROM ${table}_docsize), 0)
          + COALESCE((SELECT SUM(length(k)) + SUM(length(v)) FROM ${table}_config), 0)
          AS bytes
      `).get() as { bytes: number };
      return row.bytes;
    };
    const indexLogicalPayloadBytes = {
      char: logicalPayloadBytes("documents_fts"),
      word: logicalPayloadBytes("documents_fts_words"),
      bigram: logicalPayloadBytes("documents_fts_bigrams"),
    };

    const observation = await observeLexicalBaseline({
      searchCharLex: async (query, options) => searchFTS(
        db,
        query,
        options.limit,
        options.collection,
      ),
    }, fixture, documentsDirectory, {
      warmupRuns: 5,
      measuredRuns: 50,
      scoringSchema: CJK_LEXICAL_SCORING_SCHEMA,
    });

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const dbFile = await stat(dbPath);
    output = {
      ...observation,
      performance_observation: {
        cold_rebuild_ms: coldRebuildMs,
        index_logical_payload_bytes: indexLogicalPayloadBytes,
        database_file_bytes: dbFile.size,
        observation_only: true,
      },
    };
  } finally {
    db.close();
  }

  const hybridStore = await createStore({ dbPath });
  try {
    await hybridStore.embed();
    const queries = resolveFixtureQueries(fixture);
    const runHybrid = async (query: string): Promise<number> => {
      const startedAt = performance.now();
      await hybridStore.search({
        query,
        expansion: "skip",
        rerank: false,
        limit: 10,
      });
      return performance.now() - startedAt;
    };

    for (const query of queries) await runHybrid(query.query);
    const hybridLatencies: number[] = [];
    for (let run = 0; run < 20; run++) {
      for (const query of queries) hybridLatencies.push(await runHybrid(query.query));
    }
    output.hybrid_observation = {
      runs: { warmup: 1, measured: 20 },
      latency_ms: {
        p50: percentile(hybridLatencies, 0.5),
        p95: percentile(hybridLatencies, 0.95),
      },
      observation_only: true,
    };
  } finally {
    await hybridStore.close();
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  try {
    await store.close();
  } catch {
    // The store is already closed after indexing.
  }
  await rm(tempDir, { recursive: true, force: true });
}
