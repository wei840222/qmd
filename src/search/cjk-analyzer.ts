import {
  createJiebaUnavailableCapability,
  loadJiebaCapability,
  loadJiebaCapabilitySync,
  type JiebaCapability,
  type JiebaDiagnostic,
} from "./jieba-loader.js";

const LEGACY_CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const DIRECT_CJK_PATTERN = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
const CJK_SCRIPT_EXTENSIONS_PATTERN = /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul})$/u;
const DIRECT_HAN_PATTERN = /^\p{Script=Han}$/u;
const HAN_SCRIPT_EXTENSIONS_PATTERN = /^\p{Script_Extensions=Han}$/u;
const DIRECT_KANA_OR_HANGUL_PATTERN = /^(?:\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
const KANA_OR_HANGUL_SCRIPT_EXTENSIONS_PATTERN = /^(?:\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul})$/u;
const LETTER_OR_MARK_PATTERN = /^[\p{L}\p{M}]$/u;
const LINE_BREAK_PATTERN = /[\u000b\u000c\r\n\u0085\u2028\u2029]/u;
const SENTENCE_TERMINAL_PATTERN = /\p{Sentence_Terminal}/u;
const IDENTIFIER_DOT_PATTERN = /^[.\u2024\ufe52\uff0e]$/u;
const IDENTIFIER_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}_-]/u;
const SEARCHABLE_TOKEN_PATTERN = /[\p{L}\p{N}]/u;

export const CJK_ANALYZER_POLICY_VERSIONS = Object.freeze({
  analyzer: "cjk-analyzer-v3",
  char: "legacy-script-runs-v1",
  wordBoundary: "unicode-sentence-terminal-v3",
  wordEligibility: "direct-script-and-shared-letter-mark-v2",
  bigram: "direct-script-and-shared-letter-mark-v2",
});

export type JiebaCapabilityLoader = () => Promise<JiebaCapability>;
export type JiebaCapabilitySyncLoader = () => JiebaCapability;

export interface CjkAnalyzerFailureDiagnostic {
  readonly code: "CJK_ANALYZER_FAILED";
  readonly message: "Chinese word segmentation failed while analyzing indexed content.";
  readonly runtime: string;
  readonly remediation: "Retry the operation; if it continues to fail, verify the dictionary and @node-rs/jieba runtime compatibility.";
}

export type CjkWordDiagnostic = JiebaDiagnostic | CjkAnalyzerFailureDiagnostic;

export type CjkWordCapability =
  | { readonly available: true }
  | { readonly available: false; readonly diagnostic: CjkWordDiagnostic };

export interface CjkAnalyzerResult {
  char: string;
  word: string;
  bigram: string;
  wordCapability: CjkWordCapability;
}

function serializeCharSignal(text: string): string {
  return text.replace(LEGACY_CJK_RUN_PATTERN, run => ` ${Array.from(run).join(" ")} `);
}

function belongsToScript(
  codePoint: string,
  directPattern: RegExp,
  scriptExtensionsPattern: RegExp,
): boolean {
  return directPattern.test(codePoint)
    || (LETTER_OR_MARK_PATTERN.test(codePoint) && scriptExtensionsPattern.test(codePoint));
}

function isCjkCodePoint(codePoint: string): boolean {
  return belongsToScript(codePoint, DIRECT_CJK_PATTERN, CJK_SCRIPT_EXTENSIONS_PATTERN);
}

export function containsCjk(text: string): boolean {
  return Array.from(text).some(isCjkCodePoint);
}

function hasScriptCodePoint(text: string, directPattern: RegExp, scriptExtensionsPattern: RegExp): boolean {
  return Array.from(text).some(codePoint => belongsToScript(codePoint, directPattern, scriptExtensionsPattern));
}

function serializeBigramSignal(text: string): string {
  const tokens: string[] = [];
  let previous: string | undefined;
  for (const codePoint of text) {
    if (!isCjkCodePoint(codePoint)) {
      previous = undefined;
      continue;
    }
    if (previous !== undefined) tokens.push(previous + codePoint);
    previous = codePoint;
  }
  return tokens.join(" ");
}

function isIdentifierDot(codePoints: string[], index: number): boolean {
  const codePoint = codePoints[index];
  if (codePoint === undefined || !IDENTIFIER_DOT_PATTERN.test(codePoint)) return false;
  const previous = codePoints[index - 1];
  const next = codePoints[index + 1];
  return previous !== undefined
    && next !== undefined
    && IDENTIFIER_CHARACTER_PATTERN.test(previous)
    && IDENTIFIER_CHARACTER_PATTERN.test(next);
}

function isSegmentBoundary(codePoints: string[], index: number): boolean {
  const codePoint = codePoints[index]!;
  if (LINE_BREAK_PATTERN.test(codePoint)) return true;
  return SENTENCE_TERMINAL_PATTERN.test(codePoint) && !isIdentifierDot(codePoints, index);
}

function getJiebaSegments(text: string): string[] {
  const segments: string[] = [];
  const codePoints = Array.from(text);
  let current = "";

  const flush = () => {
    const segment = current.trim();
    const hasHan = hasScriptCodePoint(segment, DIRECT_HAN_PATTERN, HAN_SCRIPT_EXTENSIONS_PATTERN);
    const hasKanaOrHangul = hasScriptCodePoint(
      segment,
      DIRECT_KANA_OR_HANGUL_PATTERN,
      KANA_OR_HANGUL_SCRIPT_EXTENSIONS_PATTERN,
    );
    if (hasHan && !hasKanaOrHangul) {
      segments.push(segment);
    }
    current = "";
  };

  for (let index = 0; index < codePoints.length; index++) {
    if (isSegmentBoundary(codePoints, index)) flush();
    else current += codePoints[index];
  }
  flush();
  return segments;
}

function serializeWordSignal(segments: string[], capability: Extract<JiebaCapability, { available: true }>): string {
  const tokens: string[] = [];
  for (const segment of segments) {
    const segmentTokens = capability.cut(segment, false);
    if (!Array.isArray(segmentTokens)) throw new TypeError("Invalid jieba token stream");
    for (const token of segmentTokens) {
      if (typeof token !== "string") throw new TypeError("Invalid jieba token");
      const trimmed = token.trim();
      if (trimmed && SEARCHABLE_TOKEN_PATTERN.test(trimmed)) tokens.push(trimmed);
    }
  }
  return tokens.join(" ");
}

function unavailableWordCapability(): Extract<CjkWordCapability, { available: false }> {
  const { diagnostic } = createJiebaUnavailableCapability();
  return Object.freeze({ available: false, diagnostic });
}

function failedWordCapability(): Extract<CjkWordCapability, { available: false }> {
  const diagnostic: CjkAnalyzerFailureDiagnostic = Object.freeze({
    code: "CJK_ANALYZER_FAILED",
    message: "Chinese word segmentation failed while analyzing indexed content.",
    runtime: `${process.platform}-${process.arch}`,
    remediation: "Retry the operation; if it continues to fail, verify the dictionary and @node-rs/jieba runtime compatibility.",
  });
  return Object.freeze({ available: false, diagnostic });
}

export function analyzeCjkWithCapability(text: string, capability: JiebaCapability): CjkAnalyzerResult {
  const char = serializeCharSignal(text);
  const bigram = serializeBigramSignal(text);

  if (!capability.available) {
    return { char, word: "", bigram, wordCapability: unavailableWordCapability() };
  }

  try {
    const word = serializeWordSignal(getJiebaSegments(text), capability);
    return {
      char,
      word,
      bigram,
      wordCapability: Object.freeze({ available: true }),
    };
  } catch {
    return { char, word: "", bigram, wordCapability: failedWordCapability() };
  }
}

export async function analyzeCjk(
  text: string,
  loadCapability: JiebaCapabilityLoader = loadJiebaCapability,
): Promise<CjkAnalyzerResult> {
  try {
    return analyzeCjkWithCapability(text, await loadCapability());
  } catch {
    const char = serializeCharSignal(text);
    const bigram = serializeBigramSignal(text);
    return { char, word: "", bigram, wordCapability: unavailableWordCapability() };
  }
}

export function analyzeCjkSync(
  text: string,
  loadCapability: JiebaCapabilitySyncLoader = loadJiebaCapabilitySync,
): CjkAnalyzerResult {
  try {
    return analyzeCjkWithCapability(text, loadCapability());
  } catch {
    const char = serializeCharSignal(text);
    const bigram = serializeBigramSignal(text);
    return { char, word: "", bigram, wordCapability: unavailableWordCapability() };
  }
}
