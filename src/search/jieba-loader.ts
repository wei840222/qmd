import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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

function initializeCapability(
  packageModule: unknown,
  userDictionary?: Uint8Array,
): JiebaCapability {
  const packageRecord = asRecord(packageModule);
  const Jieba = (packageRecord?.Jieba ?? null) as JiebaConstructorLike | null;

  if (
    !Jieba
    || typeof Jieba.withDict !== "function"
  ) {
    return createJiebaUnavailableCapability();
  }

  const instance = Jieba.withDict(readFileSync(new URL("./zh-dict.txt", import.meta.url)));
  if (
    !instance
    || typeof instance.cut !== "function"
    || typeof instance.loadDict !== "function"
  ) {
    return createJiebaUnavailableCapability();
  }
  if (userDictionary && userDictionary.byteLength > 0) {
    instance.loadDict(userDictionary);
  }

  return Object.freeze({
    available: true,
    cut: (text: string, hmm = false) => instance.cut(text, hmm),
  });
}

async function loadCapability(
  importModule: JiebaModuleImporter,
  userDictionary?: Uint8Array,
): Promise<JiebaCapability> {
  try {
    const packageModule = await importModule("@node-rs/jieba");
    return initializeCapability(packageModule, userDictionary);
  } catch {
    return createJiebaUnavailableCapability();
  }
}

export function createJiebaLoader(
  importModule: JiebaModuleImporter = specifier => import(specifier),
): (userDictionary?: Uint8Array) => Promise<JiebaCapability> {
  let cached: Promise<JiebaCapability> | undefined;
  return (userDictionary?: Uint8Array) => {
    if (userDictionary) return loadCapability(importModule, userDictionary);
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
export function loadJiebaCapabilitySync(userDictionary?: Uint8Array): JiebaCapability {
  if (synchronousCapability && !userDictionary) return synchronousCapability;
  try {
    const cap = initializeCapability(
      require("@node-rs/jieba"),
      userDictionary,
    );
    if (!userDictionary) synchronousCapability = cap;
    return cap;
  } catch {
    return createJiebaUnavailableCapability();
  }
}
