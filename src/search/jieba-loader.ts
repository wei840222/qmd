import { createRequire } from "node:module";
import { ZH_TW_TECH_DICTIONARY_BYTES } from "./zh-tw-tech-dictionary.js";

export interface JiebaDiagnostic {
  readonly code: "JIEBA_NATIVE_UNAVAILABLE";
  readonly message: "Chinese word segmentation is unavailable for this runtime.";
  readonly runtime: string;
  readonly remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.";
}

export type JiebaCapability =
  | {
      readonly available: true;
      readonly cut: (text: string, hmm?: boolean) => string[];
    }
  | {
      readonly available: false;
      readonly diagnostic: JiebaDiagnostic;
    };

export type JiebaModuleImporter = (specifier: string) => Promise<unknown>;

interface JiebaInstanceLike {
  cut(text: string, hmm?: boolean): string[];
  loadDict(dictionary: Uint8Array): void;
}

interface JiebaConstructorLike {
  withDict(dictionary: Uint8Array): JiebaInstanceLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value as Record<string, unknown>
    : null;
}

export function createJiebaUnavailableCapability(): Extract<JiebaCapability, { available: false }> {
  const diagnostic: JiebaDiagnostic = Object.freeze({
    code: "JIEBA_NATIVE_UNAVAILABLE",
    message: "Chinese word segmentation is unavailable for this runtime.",
    runtime: `${process.platform}-${process.arch}`,
    remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.",
  });
  return Object.freeze({
    available: false,
    diagnostic,
  });
}

function initializeCapability(packageModule: unknown, dictionaryModule: unknown): JiebaCapability {
  const packageRecord = asRecord(packageModule);
  const dictionaryRecord = asRecord(dictionaryModule);
  const Jieba = asRecord(packageRecord?.Jieba) as unknown as JiebaConstructorLike | null;
  const dictionary = dictionaryRecord?.dict;

  if (
    !Jieba
    || typeof Jieba.withDict !== "function"
    || !(dictionary instanceof Uint8Array)
  ) {
    return createJiebaUnavailableCapability();
  }

  const instance = Jieba.withDict(dictionary);
  if (
    !instance
    || typeof instance.cut !== "function"
    || typeof instance.loadDict !== "function"
  ) {
    return createJiebaUnavailableCapability();
  }
  instance.loadDict(ZH_TW_TECH_DICTIONARY_BYTES);

  return Object.freeze({
    available: true,
    cut: (text: string, hmm = false) => instance.cut(text, hmm),
  });
}

async function loadCapability(importModule: JiebaModuleImporter): Promise<JiebaCapability> {
  try {
    const [packageModule, dictionaryModule] = await Promise.all([
      importModule("@node-rs/jieba"),
      importModule("@node-rs/jieba/dict.js"),
    ]);
    return initializeCapability(packageModule, dictionaryModule);
  } catch {
    return createJiebaUnavailableCapability();
  }
}

export function createJiebaLoader(
  importModule: JiebaModuleImporter = specifier => import(specifier),
): () => Promise<JiebaCapability> {
  let cached: Promise<JiebaCapability> | undefined;
  return () => {
    cached ??= loadCapability(importModule);
    return cached;
  };
}

export const loadJiebaCapability = createJiebaLoader();

const require = createRequire(import.meta.url);
let synchronousCapability: JiebaCapability | undefined;

/** @internal Override the synchronous mutation analyzer in tests. */
export function setSynchronousJiebaCapabilityForTests(
  capability?: JiebaCapability,
): void {
  synchronousCapability = capability;
}

/** Load the same analyzer and versioned dictionary for synchronous mutation paths. */
export function loadJiebaCapabilitySync(): JiebaCapability {
  if (synchronousCapability) return synchronousCapability;
  try {
    synchronousCapability = initializeCapability(
      require("@node-rs/jieba"),
      require("@node-rs/jieba/dict.js"),
    );
  } catch {
    synchronousCapability = createJiebaUnavailableCapability();
  }
  return synchronousCapability;
}
