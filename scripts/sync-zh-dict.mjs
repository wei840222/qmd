#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcesPath = join(root, "src", "search", "zh-dict.sources.json");
const outputPath = join(root, "src", "search", "zh-dict.txt");
const updatePins = process.argv.includes("--update-pins");
const require = createRequire(import.meta.url);

function fail(message) {
  throw new Error(`Invalid Chinese dictionary source: ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
}

function compareTerms(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertHash(value, label, length) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) {
    fail(`${label} must be a lowercase hexadecimal hash`);
  }
}

function assertRemoteSource(source, label) {
  if (!source || typeof source !== "object") fail(`${label} is missing`);
  if (typeof source.repository !== "string" || typeof source.branch !== "string"
    || typeof source.commit !== "string" || typeof source.path !== "string") {
    fail(`${label} has invalid repository metadata`);
  }
  const url = new URL(source.repository);
  if (url.hostname !== "github.com" || url.pathname.split("/").filter(Boolean).length !== 2) {
    fail(`${label} repository must be a canonical GitHub URL`);
  }
  assertHash(source.commit, `${label}.commit`, 40);
  assertHash(source.gitBlobSha, `${label}.gitBlobSha`, 40);
  assertHash(source.sha256, `${label}.sha256`, 64);
}

function rawUrl(source) {
  const [owner, repository] = new URL(source.repository).pathname.split("/").filter(Boolean);
  return `https://raw.githubusercontent.com/${owner}/${repository}/${source.commit}/${source.path}`;
}

function apiUrl(source) {
  const [owner, repository] = new URL(source.repository).pathname.split("/").filter(Boolean);
  return `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(source.branch)}`;
}

async function downloadPinnedSource(source, label) {
  const response = await fetch(rawUrl(source), { redirect: "error" });
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== source.sha256 || gitBlobSha(bytes) !== source.gitBlobSha) {
    throw new Error(`${label} hash mismatch.`);
  }
  return bytes;
}

async function updateRemotePin(source, label) {
  const response = await fetch(apiUrl(source), {
    headers: { Accept: "application/vnd.github+json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`${label} commit lookup failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload || typeof payload.sha !== "string" || !/^[a-f0-9]{40}$/u.test(payload.sha)) {
    throw new Error(`${label} commit lookup returned an invalid SHA.`);
  }
  source.commit = payload.sha;
  const responseWithNewPin = await fetch(rawUrl(source), { redirect: "error" });
  if (!responseWithNewPin.ok) throw new Error(`${label} download failed with HTTP ${responseWithNewPin.status}.`);
  const bytes = Buffer.from(await responseWithNewPin.arrayBuffer());
  source.sha256 = sha256(bytes);
  source.gitBlobSha = gitBlobSha(bytes);
  return bytes;
}

function loadNodeRsDictionary(source) {
  if (!source || typeof source !== "object") fail("nodeRs is missing");
  if (typeof source.package !== "string" || typeof source.version !== "string" || typeof source.path !== "string") {
    fail("nodeRs has invalid package metadata");
  }
  assertHash(source.gitBlobSha, "nodeRs.gitBlobSha", 40);
  assertHash(source.sha256, "nodeRs.sha256", 64);
  const packageJsonPath = require.resolve(`${source.package}/package.json`);
  const packageJson = readJson(packageJsonPath);
  if (packageJson.version !== source.version) {
    throw new Error(`Expected ${source.package}@${source.version}, found ${packageJson.version}.`);
  }
  const bytes = readFileSync(join(dirname(packageJsonPath), source.path));
  if (sha256(bytes) !== source.sha256 || gitBlobSha(bytes) !== source.gitBlobSha) {
    throw new Error("@node-rs/jieba dictionary hash mismatch.");
  }
  return bytes;
}

function parseDictionary(bytes, label) {
  const entries = new Map();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    const match = /^(\S+) (\d+) (\S+)$/u.exec(line);
    if (!match) fail(`${label} line ${index + 1} is not a jieba dictionary entry`);
    const [, term, frequency, tag] = match;
    if (term.normalize("NFC") !== term) fail(`${label} line ${index + 1} is not NFC normalized`);
    entries.set(term, `${term} ${frequency} ${tag}`);
  }
  if (entries.size === 0) fail(`${label} has no dictionary entries`);
  return entries;
}

function selectTechnicalTerms(bytes, settings) {
  if (!settings || typeof settings !== "object" || !Array.isArray(settings.domains)
    || !Number.isSafeInteger(settings.frequency) || settings.frequency <= 0
    || typeof settings.tag !== "string" || !settings.tag || /\s/u.test(settings.tag)) {
    fail("technicalTerms has invalid selection settings");
  }
  const domains = settings.domains;
  if (!domains.every(domain => typeof domain === "string" && domain)) {
    fail("technicalTerms.domains must contain non-empty strings");
  }
  const ruleset = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(ruleset.spelling_rules)) fail("zhtwMcp ruleset is missing spelling_rules");
  const terms = new Set();
  for (const rule of ruleset.spelling_rules) {
    const domain = /@domain ([^。；]+)/u.exec(rule?.context ?? "")?.[1]?.trim();
    if (
      rule?.type !== "cross_strait"
      || !domain
      || !domains.some(candidate => domain.includes(candidate))
      || !Array.isArray(rule.to)
    ) continue;
    for (const term of rule.to) {
      if (typeof term === "string" && term.length >= 2 && !/\s/u.test(term) && term.normalize("NFC") === term) {
        terms.add(term);
      }
    }
  }
  return [...terms].sort(compareTerms).map(term => `${term} ${settings.frequency} ${settings.tag}`);
}

const sources = readJson(sourcesPath);
if (sources.schemaVersion !== 1 || !sources.output || typeof sources.output !== "object") {
  fail("unsupported source schema");
}
assertRemoteSource(sources.apclab, "apclab");
assertRemoteSource(sources.zhtwMcp, "zhtwMcp");

const nodeRsBytes = loadNodeRsDictionary(sources.nodeRs);
const apclabBytes = updatePins
  ? await updateRemotePin(sources.apclab, "APCLab dictionary")
  : await downloadPinnedSource(sources.apclab, "APCLab dictionary");
const zhtwMcpBytes = updatePins
  ? await updateRemotePin(sources.zhtwMcp, "zhtw-mcp ruleset")
  : await downloadPinnedSource(sources.zhtwMcp, "zhtw-mcp ruleset");

const entries = parseDictionary(nodeRsBytes, "@node-rs/jieba dictionary");
for (const [term, entry] of parseDictionary(apclabBytes, "APCLab dictionary")) entries.set(term, entry);
for (const entry of selectTechnicalTerms(zhtwMcpBytes, sources.technicalTerms)) {
  entries.set(entry.split(" ", 1)[0], entry);
}

const dictionaryText = `${[...entries.keys()].sort(compareTerms).map(term => entries.get(term)).join("\n")}\n`;
const dictionaryBytes = Buffer.from(dictionaryText, "utf8");
sources.output.sha256 = sha256(dictionaryBytes);
writeFileSync(outputPath, dictionaryBytes);
writeFileSync(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
console.log(`Generated ${entries.size} Chinese dictionary entries at ${outputPath}.`);
