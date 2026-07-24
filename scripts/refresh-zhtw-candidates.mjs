#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(root, "data", "zh-tw-tech-dictionary.meta.json"), "utf8"));
const reviewed = JSON.parse(readFileSync(join(root, "data", "zh-tw-tech-dictionary.reviewed.json"), "utf8"));
const source = metadata.source;
const repositoryUrl = new URL(source.repository);
const [owner, repository] = repositoryUrl.pathname.split("/").filter(Boolean);
if (repositoryUrl.hostname !== "github.com" || !owner || !repository) {
  throw new Error("Pinned ruleset repository must be a canonical GitHub URL.");
}
const sourceUrl = `https://raw.githubusercontent.com/${owner}/${repository}/${source.commit}/${source.path}`;

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.byteLength}\0`);
  return createHash("sha1").update(header).update(buffer).digest("hex");
}

function comparableSource(rule) {
  const domain = /@domain ([^。；]+)/u.exec(rule.context ?? "")?.[1]?.trim() ?? null;
  return {
    from: rule.from,
    to: rule.to ?? [],
    domain,
    type: rule.type,
    context: rule.context ?? "",
    english: rule.english ?? "",
  };
}

const response = await fetch(sourceUrl, { redirect: "error" });
if (!response.ok) throw new Error(`Pinned ruleset download failed with HTTP ${response.status}.`);
const bytes = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash("sha256").update(bytes).digest("hex");
const actualGitBlobSha = gitBlobSha(bytes);
if (actualSha256 !== source.sha256 || actualGitBlobSha !== source.gitBlobSha) {
  throw new Error(`Pinned ruleset hash mismatch (sha256=${actualSha256}, gitBlob=${actualGitBlobSha}).`);
}

const ruleset = JSON.parse(bytes.toString("utf8"));
const rules = Array.isArray(ruleset.spelling_rules) ? ruleset.spelling_rules : [];
const reviewedByFrom = new Map(reviewed.reviews.map(entry => [entry.source.from, entry]));
const upstreamByFrom = new Map(rules.map(rule => [rule.from, rule]));
const changedReviewed = [];
for (const entry of reviewed.reviews) {
  const upstream = upstreamByFrom.get(entry.source.from);
  if (!upstream) {
    changedReviewed.push({ from: entry.source.from, status: "missing", reviewed: entry.source });
    continue;
  }
  const current = comparableSource(upstream);
  if (JSON.stringify(current) !== JSON.stringify(entry.source)) {
    changedReviewed.push({ from: entry.source.from, status: "changed", reviewed: entry.source, upstream: current });
  }
}

const technicalDomains = /@domain (?:IT|程式|資料庫|網路|硬體|UI|資安|作業系統|資料結構)/u;
const unreviewedCandidates = rules
  .filter(rule => rule.type === "cross_strait")
  .filter(rule => technicalDomains.test(rule.context ?? ""))
  .filter(rule => !reviewedByFrom.has(rule.from))
  .map(comparableSource)
  .sort((left, right) => left.from < right.from ? -1 : left.from > right.from ? 1 : 0);

const candidateDiff = {
  schemaVersion: 1,
  source: {
    repository: source.repository,
    commit: source.commit,
    path: source.path,
    gitBlobSha: actualGitBlobSha,
    sha256: actualSha256,
  },
  changedReviewed,
  unreviewedCandidates,
};
const output = `${JSON.stringify(candidateDiff, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const destination = process.argv[outputIndex + 1];
  if (!destination) throw new Error("--output requires a path.");
  writeFileSync(resolve(destination), output);
} else {
  process.stdout.write(output);
}
