import { describe, expect, test } from "vitest";
import {
  loadJiebaCapabilitySync,
  createJiebaLoader,
} from "../src/search/jieba-loader.js";
import {
  getCjkAnalyzerFingerprint,
} from "../src/search/cjk-index.js";

describe("CJK Custom User Dictionary Support", () => {
  const customDictContent = `抗重力 10 n
異步佇列 10 n
超大型機器學習 10 n`;
  const customDictBytes = new TextEncoder().encode(customDictContent);

  test("loads user dictionary and segments custom terms correctly (sync loader)", () => {
    const defaultCap = loadJiebaCapabilitySync();
    if (!defaultCap.available) {
      return; // Skip if jieba native component is unavailable on build environment
    }

    // Default segmentation of custom term
    const defaultCut = defaultCap.cut("我們正在開發超大型機器學習系統與異步佇列");
    // Without user dict, "超大型機器學習" might be split into "超大型", "機器", "學習"

    // Load with user dictionary
    const customCap = loadJiebaCapabilitySync(customDictBytes);
    expect(customCap.available).toBe(true);

    if (customCap.available) {
      const customCut = customCap.cut("我們正在開發超大型機器學習系統與異步佇列");
      expect(customCut).toContain("超大型機器學習");
      expect(customCut).toContain("異步佇列");
    }
  });

  test("loads user dictionary (async loader)", async () => {
    const loader = createJiebaLoader();
    const cap = await loader(customDictBytes);
    if (!cap.available) return;

    const cut = cap.cut("這是一個抗重力專案");
    expect(cut).toContain("抗重力");
  });

  test("changes analyzer fingerprint when custom dictionary is present", () => {
    const defaultFingerprint = getCjkAnalyzerFingerprint();
    const customFingerprint = getCjkAnalyzerFingerprint(customDictBytes);

    expect(defaultFingerprint).not.toBe(customFingerprint);
    expect(typeof customFingerprint).toBe("string");
    expect(customFingerprint.length).toBe(64); // SHA256 hex
  });
});
