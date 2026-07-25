import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { analyzeCjk } from "../src/search/cjk-analyzer.js";
import { loadJiebaCapability } from "../src/search/jieba-loader.js";
import {
  ZH_TW_TECH_DICTIONARY_BYTES,
  ZH_TW_TECH_DICTIONARY_SHA256,
  ZH_TW_TECH_DICTIONARY_TERMS,
  ZH_TW_TECH_DICTIONARY_TEXT,
  ZH_TW_TECH_DICTIONARY_VERSION,
} from "../src/search/zh-tw-tech-dictionary.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type Review = {
  source: {
    from: string;
    to: string[];
    domain: string | null;
    type: string;
    context: string;
    english: string;
  };
  decision: "accept" | "reject";
  selectedTerms: string[];
  category?: string;
  rationale: string;
};

const REVIEW_CATEGORIES = new Set([
  "artificial-intelligence",
  "concurrency",
  "data-management",
  "data-structures",
  "hardware",
  "memory-storage",
  "networking",
  "programming",
  "software-platform",
]);

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf8"));
}

function runGeneratorWithReviews(mutate: (reviews: Review[]) => void): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "qmd-dictionary-generator-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "src", "search"), { recursive: true });
    cpSync(
      join(projectRoot, "scripts", "build-zh-tw-dictionary.mjs"),
      join(root, "scripts", "build-zh-tw-dictionary.mjs"),
    );
    cpSync(
      join(projectRoot, "data", "zh-tw-tech-dictionary.meta.json"),
      join(root, "data", "zh-tw-tech-dictionary.meta.json"),
    );
    const reviewed = structuredClone(readJson("data/zh-tw-tech-dictionary.reviewed.json")) as {
      schemaVersion: number;
      sourceCommit: string;
      reviews: Review[];
    };
    mutate(reviewed.reviews);
    writeFileSync(
      join(root, "data", "zh-tw-tech-dictionary.reviewed.json"),
      `${JSON.stringify(reviewed, null, 2)}\n`,
    );
    return spawnSync(process.execPath, ["scripts/build-zh-tw-dictionary.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkGeneratorAfterMetadataChange(): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "qmd-dictionary-metadata-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "src", "search"), { recursive: true });
    for (const relativePath of [
      "scripts/build-zh-tw-dictionary.mjs",
      "data/zh-tw-tech-dictionary.reviewed.json",
      "src/search/zh-tw-tech-dictionary.ts",
    ]) {
      cpSync(join(projectRoot, relativePath), join(root, relativePath));
    }
    const metadata = structuredClone(readJson("data/zh-tw-tech-dictionary.meta.json")) as {
      selection: { frequency: number; tag: string };
    };
    metadata.selection.frequency = 42;
    metadata.selection.tag = "custom";
    writeFileSync(
      join(root, "data", "zh-tw-tech-dictionary.meta.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    return spawnSync(process.execPath, ["scripts/build-zh-tw-dictionary.mjs", "--check"], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("versioned zh-TW technical dictionary", () => {
  test("pins the reviewed upstream source and license metadata", () => {
    const metadata = readJson("data/zh-tw-tech-dictionary.meta.json") as {
      schemaVersion: number;
      dictionaryVersion: string;
      source: Record<string, string>;
    };

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      dictionaryVersion: ZH_TW_TECH_DICTIONARY_VERSION,
      source: {
        repository: "https://github.com/sysprog21/zhtw-mcp",
        commit: "2e0f4e4912a8ffdacf7fa3a155cb20c29cba043b",
        path: "assets/ruleset.json",
        gitBlobSha: "f0a4b271b2d34725517b5626bede1192951abdcf",
        sha256: "2d43bf2f84a0a842911b216dc61b63d1f194509f396c64dc11a56748de9b657a",
        reviewedSourceTuplesSha256: "9d87929fbd9a6d2818bfa531770317b4068dfcd7c33885d6b71a0cd1139b1709",
        license: "MIT",
      },
    });
  });

  test("generates only accepted, explicitly selected terms in stable order", () => {
    const reviewed = readJson("data/zh-tw-tech-dictionary.reviewed.json") as {
      schemaVersion: number;
      sourceCommit: string;
      reviews: Review[];
    };
    const acceptedTerms = [...new Set(reviewed.reviews
      .filter(review => review.decision === "accept")
      .flatMap(review => review.selectedTerms))]
      .sort();
    const rejectedTerms = reviewed.reviews
      .filter(review => review.decision === "reject")
      .flatMap(review => review.source.to);

    expect(reviewed.schemaVersion).toBe(1);
    expect(reviewed.sourceCommit).toBe("2e0f4e4912a8ffdacf7fa3a155cb20c29cba043b");
    expect(reviewed.reviews.filter(review => review.decision === "accept").length).toBeGreaterThanOrEqual(30);
    expect(reviewed.reviews.filter(review => review.decision === "reject").length).toBeGreaterThanOrEqual(2);
    expect(reviewed.reviews.some(review => review.decision === "accept")).toBe(true);
    expect(reviewed.reviews.some(review => review.decision === "reject")).toBe(true);
    const acceptedReviews = reviewed.reviews.filter(review => review.decision === "accept");
    expect(acceptedReviews.every(review => review.category && REVIEW_CATEGORIES.has(review.category))).toBe(true);
    expect(acceptedReviews.every(review => review.rationale.trim().length > 0)).toBe(true);
    expect(new Set(acceptedReviews.map(review => review.rationale)).size).toBe(acceptedReviews.length);
    expect(ZH_TW_TECH_DICTIONARY_TERMS).toEqual(acceptedTerms);
    const productionTerms = new Set<string>(ZH_TW_TECH_DICTIONARY_TERMS);
    expect(rejectedTerms.every(term => !productionTerms.has(term))).toBe(true);
    expect(ZH_TW_TECH_DICTIONARY_TERMS.every(term => term.length > 1 && !/\s/u.test(term))).toBe(true);
  });

  test("keeps dictionary bytes and fingerprint deterministic", () => {
    const metadata = readJson("data/zh-tw-tech-dictionary.meta.json") as {
      selection: { frequency: number; tag: string };
    };
    const expectedText = `${ZH_TW_TECH_DICTIONARY_TERMS
      .map(term => `${term} ${metadata.selection.frequency} ${metadata.selection.tag}`)
      .join("\n")}\n`;

    expect(ZH_TW_TECH_DICTIONARY_TEXT).toBe(expectedText);
    expect(new TextDecoder().decode(ZH_TW_TECH_DICTIONARY_BYTES)).toBe(expectedText);
    expect(createHash("sha256").update(ZH_TW_TECH_DICTIONARY_BYTES).digest("hex"))
      .toBe(ZH_TW_TECH_DICTIONARY_SHA256);
  });

  test("rejects duplicate selected terms instead of silently deduplicating them", () => {
    const result = runGeneratorWithReviews(reviews => {
      const accepted = reviews.find(review => review.decision === "accept");
      if (!accepted) throw new Error("test fixture is missing an accepted review");
      const duplicate = structuredClone(accepted);
      duplicate.rationale = `${duplicate.rationale} 重複詞條案例：${duplicate.selectedTerms[0]}`;
      reviews.push(duplicate);
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("duplicate selected term");
  });

  test("rejects a term that is both accepted and rejected", () => {
    const result = runGeneratorWithReviews(reviews => {
      const accepted = reviews.find(review => review.decision === "accept");
      const rejected = reviews.find(review => review.decision === "reject");
      if (!accepted || !rejected) throw new Error("test fixture is missing accept/reject reviews");
      rejected.source.to = [...accepted.selectedTerms];
      rejected.rationale = `拒絕候選詞「${accepted.selectedTerms[0]}」以驗證決策衝突。`;
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("both accepted and rejected");
  });

  test("rejects non-NFC source and selected terms", () => {
    const result = runGeneratorWithReviews(reviews => {
      const accepted = structuredClone(reviews.find(review => review.decision === "accept"));
      if (!accepted) throw new Error("test fixture is missing an accepted review");
      const nonNfcTerm = "e\u0301快取";
      accepted.source.from = nonNfcTerm;
      accepted.source.to = [nonNfcTerm];
      accepted.selectedTerms = [nonNfcTerm];
      reviews.push(accepted);
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("must use NFC normalization");
  });

  test("rejects a coordinated source and selection rewrite absent from pinned upstream", () => {
    const result = runGeneratorWithReviews(reviews => {
      const accepted = reviews.find(review => review.decision === "accept");
      if (!accepted) throw new Error("test fixture is missing an accepted review");
      accepted.source.to = ["偽造詞條"];
      accepted.selectedTerms = ["偽造詞條"];
      accepted.rationale = "偽造詞條雖具唯一理由，但不在 pinned upstream source tuples。";
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("reviewed source tuple digest mismatch");
  });

  test("rejects duplicate review rationales", () => {
    const result = runGeneratorWithReviews(reviews => {
      if (reviews.length < 2) throw new Error("test fixture needs at least two reviews");
      reviews[1]!.rationale = reviews[0]!.rationale;
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("duplicate rationale");
  });

  test("rejects a rationale without a term-specific anchor", () => {
    const result = runGeneratorWithReviews(reviews => {
      const accepted = reviews.find(review => review.decision === "accept");
      if (!accepted) throw new Error("test fixture is missing an accepted review");
      accepted.rationale = "此項已由人工確認，符合靜態收錄政策。";
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("term-specific anchor");
  });

  test("metadata-controlled Jieba settings change the generated artifact and fingerprint", () => {
    const result = checkGeneratorAfterMetadataChange();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("dictionary module is stale");
  });

  test("loads Taiwan technical terms through the production loader and analyzer", async () => {
    const capability = await loadJiebaCapability();
    expect(capability.available).toBe(true);
    if (!capability.available) return;

    expect(capability.cut("使用快取記憶體與執行緒佇列", false))
      .toEqual(["使用", "快取記憶體", "與", "執行緒", "佇列"]);
    for (const term of ZH_TW_TECH_DICTIONARY_TERMS) {
      if (!/[（）()]/u.test(term)) {
        expect(capability.cut(term, false)).toEqual([term]);
      }
    }

    const analyzed = await analyzeCjk("相依性雜湊佇列");
    expect(analyzed.word).toBe("相依性 雜湊 佇列");
  });

  test("the committed generated module is current", () => {
    execFileSync(process.execPath, ["scripts/build-zh-tw-dictionary.mjs", "--check"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  });

  test("does not attach upstream downloads to build, install, or runtime", () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    const lifecycleScripts = [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prebuild",
      "build",
      "postbuild",
    ];
    for (const name of lifecycleScripts) {
      expect(packageJson.scripts?.[name] ?? "").not.toContain("refresh-zhtw-candidates");
    }

    const generator = readFileSync(join(projectRoot, "scripts", "build-zh-tw-dictionary.mjs"), "utf8");
    const loader = readFileSync(join(projectRoot, "src", "search", "jieba-loader.ts"), "utf8");
    expect(generator).not.toContain("fetch(");
    expect(loader).not.toContain("fetch(");
  });
});
