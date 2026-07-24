#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reviewedPath = join(root, "data", "zh-tw-tech-dictionary.reviewed.json");
const metadataPath = join(root, "data", "zh-tw-tech-dictionary.meta.json");
const outputPath = join(root, "src", "search", "zh-tw-tech-dictionary.ts");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(`Invalid zh-TW dictionary input: ${message}`);
}

function requireNfcTerm(value, label) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (normalized !== value) fail(`${label} must use NFC normalization`);
  return normalized;
}

const reviewCategories = new Set([
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

const reviewed = readJson(reviewedPath);
const metadata = readJson(metadataPath);

if (reviewed.schemaVersion !== 1 || metadata.schemaVersion !== 1) fail("unsupported schema version");
if (reviewed.sourceCommit !== metadata.source?.commit) fail("source commit mismatch");
if (typeof metadata.dictionaryVersion !== "string" || !metadata.dictionaryVersion) fail("missing dictionary version");
if (!Array.isArray(reviewed.reviews) || reviewed.reviews.length === 0) fail("reviews must not be empty");
if (!metadata.selection || typeof metadata.selection !== "object") fail("missing dictionary selection settings");
const frequency = metadata.selection.frequency;
const tag = metadata.selection.tag;
if (!Number.isSafeInteger(frequency) || frequency <= 0) fail("selection frequency must be a positive safe integer");
if (typeof tag !== "string" || !tag || /\s/u.test(tag)) fail("selection tag must be a non-empty token");

const acceptedTerms = [];
const acceptedTermOwners = new Map();
const rejectedTermOwners = new Map();
const sourceTuples = [];
const rationaleOwners = new Map();
for (const [index, review] of reviewed.reviews.entries()) {
  const source = review?.source;
  if (!source || typeof source.from !== "string" || !Array.isArray(source.to)) {
    fail(`review ${index} is missing source from/to`);
  }
  requireNfcTerm(source.from, `review ${index} source.from`);
  for (const [targetIndex, target] of source.to.entries()) {
    requireNfcTerm(target, `review ${index} source.to[${targetIndex}]`);
  }
  if (
    !(Object.hasOwn(source, "domain"))
    || (source.domain !== null && typeof source.domain !== "string")
    || typeof source.type !== "string"
    || typeof source.context !== "string"
    || typeof source.english !== "string"
  ) {
    fail(`review ${index} is missing canonical source fields`);
  }
  sourceTuples.push({
    from: source.from,
    to: source.to,
    domain: source.domain,
    type: source.type,
    context: source.context,
    english: source.english,
  });
  if (!reviewCategories.has(review.category)) fail(`review ${index} has an invalid category`);
  if (typeof review.rationale !== "string" || !review.rationale.trim()) {
    fail(`review ${index} is missing a rationale`);
  }
  const canonicalRationale = review.rationale.trim().replace(/\s+/gu, " ");
  const priorRationaleOwner = rationaleOwners.get(canonicalRationale);
  if (priorRationaleOwner !== undefined) {
    fail(`duplicate rationale in reviews ${priorRationaleOwner} and ${index}`);
  }
  rationaleOwners.set(canonicalRationale, index);
  if (!Array.isArray(review.selectedTerms)) fail(`review ${index} selectedTerms must be an array`);
  const rationaleAnchors = [source.from, ...source.to, ...review.selectedTerms];
  if (!rationaleAnchors.some(anchor => typeof anchor === "string" && anchor && canonicalRationale.includes(anchor))) {
    fail(`review ${index} rationale is missing a term-specific anchor`);
  }

  if (review.decision === "reject") {
    if (review.selectedTerms.length !== 0) fail(`rejected review ${index} selects production terms`);
    for (const term of source.to) rejectedTermOwners.set(term.normalize("NFC"), index);
    continue;
  }
  if (review.decision !== "accept" || review.selectedTerms.length === 0) {
    fail(`review ${index} must explicitly accept or reject`);
  }

  for (const term of review.selectedTerms) {
    const normalizedTerm = requireNfcTerm(term, `review ${index} selected term`);
    if (normalizedTerm.length < 2 || /\s/u.test(normalizedTerm)) {
      fail(`review ${index} contains an unsafe dictionary term`);
    }
    if (!source.to.includes(normalizedTerm)) fail(`review ${index} selects a term absent from upstream to[]`);
    const priorOwner = acceptedTermOwners.get(normalizedTerm);
    if (priorOwner !== undefined) {
      fail(`duplicate selected term ${JSON.stringify(normalizedTerm)} in reviews ${priorOwner} and ${index}`);
    }
    acceptedTermOwners.set(normalizedTerm, index);
    acceptedTerms.push(normalizedTerm);
  }
}

for (const [term, acceptedIndex] of acceptedTermOwners) {
  const rejectedIndex = rejectedTermOwners.get(term);
  if (rejectedIndex !== undefined) {
    fail(`term ${JSON.stringify(term)} is both accepted and rejected in reviews ${acceptedIndex} and ${rejectedIndex}`);
  }
}

const expectedSourceTupleDigest = metadata.source?.reviewedSourceTuplesSha256;
if (typeof expectedSourceTupleDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSourceTupleDigest)) {
  fail("missing reviewed source tuple digest");
}
sourceTuples.sort((left, right) => left.from < right.from ? -1 : left.from > right.from ? 1 : 0);
const sourceTupleDigest = createHash("sha256")
  .update(`${JSON.stringify(sourceTuples)}\n`, "utf8")
  .digest("hex");
if (sourceTupleDigest !== expectedSourceTupleDigest) {
  fail("reviewed source tuple digest mismatch");
}

const terms = acceptedTerms.sort();
const dictionaryText = `${terms.map(term => `${term} ${frequency} ${tag}`).join("\n")}\n`;
const dictionarySha256 = createHash("sha256").update(dictionaryText, "utf8").digest("hex");
const generated = `// Generated by scripts/build-zh-tw-dictionary.mjs. Do not edit manually.\n\nexport const ZH_TW_TECH_DICTIONARY_VERSION = ${JSON.stringify(metadata.dictionaryVersion)};\nexport const ZH_TW_TECH_DICTIONARY_SHA256 = ${JSON.stringify(dictionarySha256)};\nexport const ZH_TW_TECH_DICTIONARY_TERMS = ${JSON.stringify(terms, null, 2)} as const;\nexport const ZH_TW_TECH_DICTIONARY_TEXT = ${JSON.stringify(dictionaryText)};\nexport const ZH_TW_TECH_DICTIONARY_BYTES = new TextEncoder().encode(ZH_TW_TECH_DICTIONARY_TEXT);\n`;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    console.error("Generated zh-TW dictionary module is missing. Run scripts/build-zh-tw-dictionary.mjs.");
    process.exit(1);
  }
  if (current !== generated) {
    console.error("Generated zh-TW dictionary module is stale. Run scripts/build-zh-tw-dictionary.mjs.");
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, generated);
}
