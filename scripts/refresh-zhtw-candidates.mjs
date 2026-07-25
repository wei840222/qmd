#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
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

const skipReview = process.argv.includes("--skip-review");

if (skipReview) {
  function mapCategory(domain, context) {
    const text = `${domain || ""} ${context || ""}`;
    if (/資料庫|資料結構/u.test(text)) return "data-management";
    if (/網路|網絡/u.test(text)) return "networking";
    if (/硬體/u.test(text)) return "hardware";
    if (/記憶體|快取|儲存/u.test(text)) return "memory-storage";
    if (/人工智慧|AI/u.test(text)) return "artificial-intelligence";
    if (/併發|多線程|執行緒/u.test(text)) return "concurrency";
    if (/作業系統|UI|IT/u.test(text)) return "software-platform";
    return "programming";
  }

  const existingAcceptedTerms = new Set();
  for (const r of reviewed.reviews) {
    if (r.decision === "accept" && Array.isArray(r.selectedTerms)) {
      for (const t of r.selectedTerms) {
        existingAcceptedTerms.add(t);
      }
    }
  }

  let addedCount = 0;
  for (const cand of unreviewedCandidates) {
    if (!Array.isArray(cand.to) || cand.to.length === 0) continue;
    const validTerms = cand.to.filter(
      t => typeof t === "string" && t.length >= 2 && !/\s/u.test(t) && !existingAcceptedTerms.has(t)
    );
    if (validTerms.length === 0) continue;

    for (const t of validTerms) {
      existingAcceptedTerms.add(t);
    }

    reviewed.reviews.push({
      source: cand,
      decision: "accept",
      selectedTerms: validTerms,
      category: mapCategory(cand.domain, cand.context),
      rationale: `Auto-accepted candidate from 「${cand.from}」 to 「${validTerms.join(" / ")}」.`,
    });
    addedCount++;
  }

  reviewed.reviews.sort((left, right) =>
    left.source.from.localeCompare(right.source.from, "zh-Hant")
  );

  const sourceTuples = reviewed.reviews.map(review => ({
    from: review.source.from,
    to: review.source.to,
    domain: review.source.domain,
    type: review.source.type,
    context: review.source.context,
    english: review.source.english,
  }));
  sourceTuples.sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  const newDigest = createHash("sha256")
    .update(`${JSON.stringify(sourceTuples)}\n`, "utf8")
    .digest("hex");

  metadata.source.reviewedSourceTuplesSha256 = newDigest;
  metadata.source.gitBlobSha = actualGitBlobSha;
  metadata.source.sha256 = actualSha256;

  const reviewedPath = join(root, "data", "zh-tw-tech-dictionary.reviewed.json");
  const metadataPath = join(root, "data", "zh-tw-tech-dictionary.meta.json");

  writeFileSync(reviewedPath, `${JSON.stringify(reviewed, null, 2)}\n`);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(`Auto-synchronized ${addedCount} unreviewed candidates into ${reviewedPath}.`);
  console.log("Rebuilding zh-tw dictionary...");
  execSync("node scripts/build-zh-tw-dictionary.mjs", { cwd: root, stdio: "inherit" });
} else {
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
}
