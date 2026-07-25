import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadJiebaCapability } from "../src/search/jieba-loader.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcesPath = join(projectRoot, "src", "search", "zh-dict.sources.json");
const dictionaryPath = join(projectRoot, "src", "search", "zh-dict.txt");

describe("versioned Chinese dictionary asset", () => {
  test("ships a dictionary whose fingerprint matches its source configuration", () => {
    expect(existsSync(sourcesPath)).toBe(true);
    expect(existsSync(dictionaryPath)).toBe(true);

    const sources = JSON.parse(readFileSync(sourcesPath, "utf8")) as {
      schemaVersion: number;
      output: { sha256: string };
    };
    const dictionary = readFileSync(dictionaryPath);

    expect(sources.schemaVersion).toBe(1);
    expect(sources.output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createHash("sha256").update(dictionary).digest("hex"))
      .toBe(sources.output.sha256);
  });

  test("loads terms contributed by the bundled dictionary", async () => {
    const capability = await loadJiebaCapability();
    expect(capability.available).toBe(true);
    if (!capability.available) return;

    expect(capability.cut("CC霜", false)).toEqual(["CC霜"]);
  });
});
