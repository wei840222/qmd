/**
 * Tests for the benchmark scoring functions.
 */

import { describe, test, expect } from "vitest";
import { normalizePath, pathsMatch, percentile, scoreResults } from "../src/bench/score.js";

describe("normalizePath", () => {
  test("lowercases path", () => {
    expect(normalizePath("Resources/Concepts/Context Engineering.md"))
      .toBe("resources/concepts/context engineering.md");
  });

  test("strips qmd:// prefix", () => {
    expect(normalizePath("qmd://collection/docs/readme.md"))
      .toBe("docs/readme.md");
  });

  test("strips leading/trailing slashes", () => {
    expect(normalizePath("/docs/readme.md/")).toBe("docs/readme.md");
  });

  test("handles plain filename", () => {
    expect(normalizePath("readme.md")).toBe("readme.md");
  });
});

describe("pathsMatch", () => {
  test("exact match", () => {
    expect(pathsMatch("docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("case-insensitive match", () => {
    expect(pathsMatch("Docs/README.md", "docs/readme.md")).toBe(true);
  });

  test("suffix match (result is longer)", () => {
    expect(pathsMatch("/full/path/docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("suffix match (expected is longer)", () => {
    expect(pathsMatch("readme.md", "docs/readme.md")).toBe(true);
  });

  test("qmd:// prefix handled", () => {
    expect(pathsMatch("qmd://col/docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("different files don't match", () => {
    expect(pathsMatch("docs/readme.md", "docs/other.md")).toBe(false);
  });

  test("suffix matching requires a path-segment boundary", () => {
    expect(pathsMatch("docs/myfoo.md", "foo.md")).toBe(false);
    expect(pathsMatch("foo.md", "docs/myfoo.md")).toBe(false);
  });
});

describe("percentile", () => {
  test("uses the nearest-rank method without mutating input", () => {
    const values = [40, 10, 30, 20];

    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(40);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  test("returns zero for an empty sample", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("scoreResults", () => {
  test("perfect score: all expected in top-k", () => {
    const result = scoreResults(
      ["a.md", "b.md", "c.md"],
      ["a.md", "b.md"],
      2,
    );
    expect(result.precision_at_k).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.mrr).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.hits_at_k).toBe(2);
  });

  test("zero score: none found", () => {
    const result = scoreResults(
      ["x.md", "y.md", "z.md"],
      ["a.md", "b.md"],
      2,
    );
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.f1).toBe(0);
    expect(result.hits_at_k).toBe(0);
  });

  test("partial: found outside top-k", () => {
    const result = scoreResults(
      ["x.md", "y.md", "a.md"],
      ["a.md"],
      1,
    );
    expect(result.precision_at_k).toBe(0); // not in top-1
    expect(result.recall).toBe(1); // found somewhere
    expect(result.mrr).toBeCloseTo(1 / 3); // rank 3
    expect(result.hits_at_k).toBe(0);
  });

  test("MRR: first relevant at rank 2", () => {
    const result = scoreResults(
      ["x.md", "a.md", "b.md"],
      ["a.md", "b.md"],
      3,
    );
    expect(result.mrr).toBeCloseTo(0.5); // 1/2
  });

  test("reports recall@10 and keeps legacy recall over all returned results", () => {
    const result = scoreResults(
      [
        "noise-1.md",
        "relevant-a.md",
        "noise-3.md",
        "noise-4.md",
        "noise-5.md",
        "noise-6.md",
        "noise-7.md",
        "noise-8.md",
        "noise-9.md",
        "noise-10.md",
        "relevant-b.md",
      ],
      ["relevant-a.md", "relevant-b.md"],
      10,
    );

    expect(result.recall).toBe(1);
    expect(result.recall_at_10).toBe(0.5);
  });

  test("reports mrr@10 without changing legacy MRR", () => {
    const result = scoreResults(
      [
        "noise-1.md",
        "noise-2.md",
        "noise-3.md",
        "noise-4.md",
        "noise-5.md",
        "noise-6.md",
        "noise-7.md",
        "noise-8.md",
        "noise-9.md",
        "noise-10.md",
        "relevant.md",
      ],
      ["relevant.md"],
      10,
    );

    expect(result.mrr).toBeCloseTo(1 / 11);
    expect(result.mrr_at_10).toBe(0);
  });

  test("counts must-not-match documents in the top 10", () => {
    const result = scoreResults(
      ["forbidden-a.md", "relevant.md", "forbidden-b.md", "allowed.md"],
      ["relevant.md"],
      10,
      ["forbidden-a.md", "forbidden-b.md", "outside-results.md"],
    );

    expect(result.false_positive_count).toBe(2);
    expect(result.false_positive_files).toEqual(["forbidden-a.md", "forbidden-b.md"]);
  });

  test("reports recall@1/3/5 and matched documents", () => {
    const result = scoreResults(
      ["x.md", "qmd://concepts/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
      ["concepts/a.md", "b.md", "missing.md"],
      3,
    );

    expect(result.recall_at_1).toBe(0);
    expect(result.recall_at_3).toBeCloseTo(2 / 3);
    expect(result.recall_at_5).toBeCloseTo(2 / 3);
    expect(result.matched_files).toEqual(["concepts/a.md", "b.md"]);
    expect(result.unmatched_expected_files).toEqual(["missing.md"]);
  });

  test("empty results", () => {
    const result = scoreResults([], ["a.md"], 1);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.mrr).toBe(0);
  });

  test("empty expected", () => {
    const result = scoreResults(["a.md"], [], 1);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
  });
});
