import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { analyzeCjk } from "../src/search/cjk-analyzer.js";
import { loadJiebaCapability } from "../src/search/jieba-loader.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dictionaryPath = join(projectRoot, "src", "search", "zh-dict.txt");
const sourcesPath = join(projectRoot, "src", "search", "zh-dict.sources.json");

describe("versioned Chinese dictionary", () => {
  test("keeps the generated dictionary fingerprint in its source configuration", () => {
    const sources = JSON.parse(readFileSync(sourcesPath, "utf8")) as {
      schemaVersion: number;
      output: { sha256: string };
      apclab: { commit: string; sha256: string; gitBlobSha: string };
      zhtwMcp: { commit: string; sha256: string; gitBlobSha: string };
    };
    const dictionary = readFileSync(dictionaryPath);

    expect(sources.schemaVersion).toBe(1);
    expect(sources.output.sha256).toBe(createHash("sha256").update(dictionary).digest("hex"));
    for (const source of [sources.apclab, sources.zhtwMcp]) {
      expect(source.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(source.gitBlobSha).toMatch(/^[a-f0-9]{40}$/u);
    }
  });

  test("loads base and technical terms through the production analyzer", async () => {
    const capability = await loadJiebaCapability();
    expect(capability.available).toBe(true);
    if (!capability.available) return;

    expect(capability.cut("CC霜", false)).toEqual(["CC霜"]);
    expect(capability.cut("使用快取記憶體與執行緒佇列", false))
      .toEqual(["使用", "快取記憶體", "與", "執行緒", "佇列"]);
    expect((await analyzeCjk("相依性雜湊佇列")).word).toBe("相依性 雜湊 佇列");
  });

  test("does not attach source downloads to install, build, or runtime", () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    for (const name of ["preinstall", "install", "postinstall", "prepare", "prebuild", "build", "postbuild"]) {
      expect(packageJson.scripts?.[name] ?? "").not.toContain("sync-zh-dict");
    }
    expect(readFileSync(join(projectRoot, "src", "search", "jieba-loader.ts"), "utf8")).not.toContain("fetch(");
  });
});