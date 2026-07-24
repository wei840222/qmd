import { describe, expect, test, vi } from "vitest";
import {
  analyzeCjk,
  analyzeCjkSync,
  type CjkAnalyzerResult,
} from "../src/search/cjk-analyzer.js";
import type { JiebaCapability } from "../src/search/jieba-loader.js";
import { normalizeCjkForFTS } from "../src/store.js";

function availableCapability(cut: (text: string, hmm?: boolean) => string[]): JiebaCapability {
  return { available: true, cut };
}

async function analyzeWith(
  text: string,
  cut: (text: string, hmm?: boolean) => string[],
): Promise<CjkAnalyzerResult> {
  return analyzeCjk(text, async () => availableCapability(cut));
}

describe("CJK analyzer", () => {
  test("uses the default jieba capability for eligible Han segments", async () => {
    const result = await analyzeCjk("我們使用記憶體快取資料");

    expect(result.word).toBe("我 們 使用 記憶體 快取 資 料");
    expect(result.wordCapability).toEqual({ available: true });
  });

  test("keeps synchronous mutation analysis identical to asynchronous analysis", async () => {
    const input = "API v2.0 資料庫同步。\n卡タ資料\n台灣正體中文記憶體快取";

    expect(analyzeCjkSync(input)).toEqual(await analyzeCjk(input));
  });

  test("preserves the existing character serialization for Han, Kana, Hangul, and Latin text", async () => {
    const result = await analyzeWith("API v2資料庫 カタ한글", () => []);

    expect(result.char).toBe("API v2 資 料 庫   カ タ 한 글 ");
  });

  test("uses deterministic sentence segments and gates jieba to Han segments without Kana or Hangul", async () => {
    const cut = vi.fn((segment: string) => (
      segment === "API v2 資料庫同步"
        ? ["API", " ", "v2", "資料庫", "同步", ","]
        : ["未知", "名稱"]
    ));
    const input = "API v2 資料庫同步。\nカタカナ資料\n한글資料！未知名稱";

    const first = await analyzeWith(input, cut);
    const second = await analyzeWith(input, cut);

    expect(first).toEqual(second);
    expect(cut.mock.calls.map(([segment]) => segment)).toEqual([
      "API v2 資料庫同步",
      "未知名稱",
      "API v2 資料庫同步",
      "未知名稱",
    ]);
    expect(first.word).toBe("API v2 資料庫 同步 未知 名稱");
    expect(first.wordCapability).toEqual({ available: true });
  });

  test("handles Unicode line and sentence boundaries without splitting identifiers or semicolons", async () => {
    const cut = vi.fn((segment: string) => [segment]);
    const input = "API v2.0 資料庫；同步\u2028カタ\u2029資料庫؟カタ\u0085檔案.md同步\u000b資料庫\u000c索引";

    await analyzeWith(input, cut);

    expect(cut.mock.calls.map(([segment]) => segment)).toEqual([
      "API v2.0 資料庫；同步",
      "資料庫",
      "檔案.md同步",
      "資料庫",
      "索引",
    ]);
  });

  test("keeps Unicode identifier dots internal", async () => {
    const cut = vi.fn((segment: string) => [segment]);
    const first = "模組﹒子項資料";
    const second = "模組․子項資料";

    await analyzeWith(`${first}。${second}`, cut);

    expect(cut.mock.calls.map(([segment]) => segment)).toEqual([first, second]);
  });

  test("creates adjacent code-point bigrams inside each CJK run without crossing other boundaries", async () => {
    const input = "資料庫同步，API2\n卡8S卡。カタ資料！한글資料";

    const result = await analyzeWith(input, () => []);

    expect(result.bigram).toBe([
      "資料", "料庫", "庫同", "同步",
      "カタ", "タ資", "資料",
      "한글", "글資", "資料",
    ].join(" "));
  });

  test("uses Unicode script extensions for Kana gating and bigrams without changing legacy char serialization", async () => {
    const cut = vi.fn((segment: string) => [segment]);
    const input = "スーパー ﾊﾟｰ は\u3099 時々";

    const result = await analyzeWith(input, cut);

    expect(cut).not.toHaveBeenCalled();
    expect(result.char).toBe(normalizeCjkForFTS(input));
    expect(result.word).toBe("");
    expect(result.bigram).toBe("スー ーパ パー ﾊﾟ ﾟｰ ば 時々");
  });

  test("includes non-letter direct-script CJK code points without admitting shared punctuation", async () => {
    const cut = vi.fn((segment: string) => [segment]);
    const input = "〇一。資料㋐。資料・庫";

    const result = await analyzeWith(input, cut);

    expect(cut.mock.calls.map(([segment]) => segment)).toEqual(["〇一", "資料・庫"]);
    expect(result.char).toBe(normalizeCjkForFTS(input));
    expect(result.word).toBe("〇一 資料・庫");
    expect(result.bigram).toBe("〇一 資料 料㋐ 資料");
  });

  test("keeps an identifier dot internal after a decomposed Unicode letter", async () => {
    const cut = vi.fn((segment: string) => [segment]);
    const input = "版本e\u0301.md資料";

    await analyzeWith(input, cut);

    expect(cut.mock.calls.map(([segment]) => segment)).toEqual([input]);
  });

  test("does not apply NFKC or terminology substitution to mixed Han, Latin, digits, and punctuation", async () => {
    const cut = vi.fn(() => ["ＡＰＩ１２３", "資料庫"]);
    const input = "ＡＰＩ１２３資料庫，記憶體";

    const result = await analyzeWith(input, cut);

    expect(cut).toHaveBeenCalledWith(input, false);
    expect(result.char).toBe("ＡＰＩ１２３ 資 料 庫 ， 記 憶 體 ");
    expect(result.word).toBe("ＡＰＩ１２３ 資料庫");
    expect(result.bigram).toBe("資料 料庫 記憶 憶體");
    expect(result.char).not.toContain("内存");
  });

  test("keeps single-character unknown names in char while bigrams require two code points", async () => {
    const result = await analyzeWith("𠮷", () => ["𠮷"]);

    expect(result.char).toBe(" 𠮷 ");
    expect(result.word).toBe("𠮷");
    expect(result.bigram).toBe("");
  });
});
