import { describe, expect, test } from "vitest";
import { analyzeCjk } from "../src/search/cjk-analyzer.js";
import {
  createJiebaLoader,
  type JiebaCapability,
  type JiebaDiagnostic,
} from "../src/search/jieba-loader.js";

const diagnostic: JiebaDiagnostic = {
  code: "JIEBA_NATIVE_UNAVAILABLE",
  message: "Chinese word segmentation is unavailable for this runtime.",
  runtime: `${process.platform}-${process.arch}`,
  remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.",
};

async function unavailable(): Promise<JiebaCapability> {
  return { available: false, diagnostic };
}

describe("CJK analyzer without jieba", () => {
  test("returns a sanitized capability and preserves char and bigram fallback signals", async () => {
    const result = await analyzeCjk("玉山同步器", unavailable);

    expect(result).toEqual({
      char: " 玉 山 同 步 器 ",
      word: "",
      bigram: "玉山 山同 同步 步器",
      wordCapability: { available: false, diagnostic },
    });
    expect(JSON.stringify(result)).not.toContain("stack");
    expect(JSON.stringify(result)).not.toContain("cause");
  });

  test("sanitizes a real loader failure while preserving independent fallback signals", async () => {
    const secret = "dlopen /home/private/TOKEN=secret";
    const loader = createJiebaLoader(async () => {
      throw new Error(secret);
    });
    const capability = await loader();

    const result = await analyzeCjk("玉山同步器", async () => capability);

    expect(result.char).toBe(" 玉 山 同 步 器 ");
    expect(result.word).toBe("");
    expect(result.bigram).toBe("玉山 山同 同步 步器");
    expect(result.wordCapability.available).toBe(false);
    expect(Object.isFrozen(result.wordCapability)).toBe(true);
    if (!("diagnostic" in result.wordCapability) || !("diagnostic" in capability)) {
      throw new Error("unreachable");
    }
    expect(Object.isFrozen(result.wordCapability.diagnostic)).toBe(true);
    expect(result.wordCapability.diagnostic).not.toBe(capability.diagnostic);
    expect(result.wordCapability.diagnostic.code).toBe("JIEBA_NATIVE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("converts a rejecting capability loader into a sanitized fallback result", async () => {
    const secret = "loader failed TOKEN=secret";

    const result = await analyzeCjk("玉山同步器", async () => {
      throw new Error(secret);
    });

    expect(result.char).toBe(" 玉 山 同 步 器 ");
    expect(result.word).toBe("");
    expect(result.bigram).toBe("玉山 山同 同步 步器");
    expect(result.wordCapability.available).toBe(false);
    if (result.wordCapability.available) throw new Error("unreachable");
    expect(result.wordCapability.diagnostic.code).toBe("JIEBA_NATIVE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("discards partial words when native segmentation throws", async () => {
    let calls = 0;
    const secret = "cut failed /home/private/TOKEN=secret";
    const loader = async (): Promise<JiebaCapability> => ({
      available: true,
      cut: segment => {
        calls += 1;
        if (calls === 1) return [segment];
        throw new Error(secret);
      },
    });

    const result = await analyzeCjk("玉山。同步器", loader);

    expect(calls).toBe(2);
    expect(result.char).toBe(" 玉 山 。 同 步 器 ");
    expect(result.word).toBe("");
    expect(result.bigram).toBe("玉山 同步 步器");
    expect(result.wordCapability.available).toBe(false);
    if (result.wordCapability.available) throw new Error("unreachable");
    expect(result.wordCapability.diagnostic.code).toBe("CJK_ANALYZER_FAILED");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test.each([
    ["a non-array token stream", null],
    ["a non-string token", ["玉山", null]],
  ])("treats %s as an analyzer failure", async (_label, tokens) => {
    const loader = async (): Promise<JiebaCapability> => ({
      available: true,
      cut: () => tokens as any,
    });

    const result = await analyzeCjk("玉山同步器", loader);

    expect(result.char).toBe(" 玉 山 同 步 器 ");
    expect(result.word).toBe("");
    expect(result.bigram).toBe("玉山 山同 同步 步器");
    expect(result.wordCapability.available).toBe(false);
    if (result.wordCapability.available) throw new Error("unreachable");
    expect(result.wordCapability.diagnostic.code).toBe("CJK_ANALYZER_FAILED");
  });

  test("keeps non-CJK text byte-for-byte in the char signal without inventing other tokens", async () => {
    const input = "API-v2.0 / cache_123";

    const result = await analyzeCjk(input, unavailable);

    expect(result.char).toBe(input);
    expect(result.word).toBe("");
    expect(result.bigram).toBe("");
    expect(result.wordCapability.available).toBe(false);
  });
});
