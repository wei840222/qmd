import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/index.js";
import { beginEmbeddingBuild, completeEmbeddingBuild } from "../src/embedding/identity.js";
import { remoteEmbeddingIdentity } from "../src/embedding/remote-consent.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function remoteCli(
  args: string[],
  command = "embed",
  apiKey: string | null = "",
  seedPending = false,
  seedReady = false,
  remoteConfig = true,
  legacyEmbedModel?: string,
) {
  const repositoryRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "qmd-cli-remote-"));
  roots.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const dbPath = join(root, "index.sqlite");
  const docsDir = join(root, "docs");
  if (seedPending) {
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "pending.md"), "# Pending\n\nremote content\n");
    const seed = await createStore({
      dbPath,
      config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
    });
    try {
      await seed.update();
      seed.internal.db.exec(
        "CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[1536] distance_metric=cosine)",
      );
    } finally {
      await seed.close();
    }
  }
  if (seedReady) {
    const seed = await createStore({
      dbPath,
      config: {
        collections: {},
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
    });
    try {
      const identity = remoteEmbeddingIdentity(seed.internal.embeddingProvider!);
      const lease = beginEmbeddingBuild(seed.internal.db, identity, {
        ownerId: "cli-ready-openai-status",
        now: 1_000,
        leaseMs: 1_000,
        allowDestructiveRebuild: true,
      });
      completeEmbeddingBuild(seed.internal.db, lease, 1_100);
    } finally {
      await seed.close();
    }
  }
  const modelsConfig = remoteConfig
    ? "models:\n  embed_api_url: https://api.openai.com/v1\n  embed_api_model: text-embedding-3-small\n"
    : legacyEmbedModel === undefined ? "" : `models:\n  embed: ${legacyEmbedModel}\n`;
  await writeFile(join(configDir, "index.yml"), seedPending
    ? `collections:\n  docs:\n    path: ${JSON.stringify(docsDir)}\n    pattern: "**/*.md"\n${modelsConfig}`
    : `collections: {}\n${modelsConfig}`);
  const dbBefore = existsSync(dbPath) ? await readFile(dbPath) : undefined;
  const result = spawnSync(
    "node",
    [
      join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      join(repositoryRoot, "src", "cli", "qmd.ts"),
      command,
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "",
        NO_COLOR: "1",
        QMD_FORCE_CPU: "1",
        ...(apiKey === null ? { OPENAI_API_KEY: undefined } : { OPENAI_API_KEY: apiKey }),
        QMD_CONFIG_DIR: configDir,
        XDG_CACHE_HOME: join(root, "cache"),
        INDEX_PATH: dbPath,
      },
    },
  );
  const dbAfter = existsSync(dbPath) ? await readFile(dbPath) : undefined;
  return Object.assign(result, {
    indexExistsAfter: dbAfter !== undefined,
    indexBytesUnchanged: dbBefore !== undefined
      && dbAfter !== undefined
      && dbBefore.equals(dbAfter),
  });
}

describe("remote embedding CLI consent", () => {
  test("reports an absent API key as not configured", async () => {
    const result = await remoteCli([], "status", null);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("API key:  not configured");
  });

  test("reports a ready OpenAI identity consistently in status without a provider request", async () => {
    const result = await remoteCli([], "status", null, false, true);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Provider: openai");
    expect(result.stdout).toMatch(/Identity: [0-9a-f]{12} \(ready\)/);
    expect(result.stdout).toContain("Pending:  0");
  });

  test("reports a ready OpenAI identity in doctor without local reproduction or a remote request", async () => {
    const result = await remoteCli([], "doctor", null, false, true);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/embedding identity: openai\/text-embedding-3-small; state=ready/);
    expect(result.stdout).toContain("embedding vector sample: skipped for remote provider; doctor sends no remote embedding request");
  });

  test("prints a no-key preflight without sending a remote request", async () => {
    const result = await remoteCli(["--remote-preflight"]);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      providerId: string;
      pendingDocuments: number;
      inputTokenUpperBound: number;
      policyVersion: string;
    };
    expect(output).toMatchObject({
      providerId: "openai",
      pendingDocuments: 0,
      inputTokenUpperBound: 0,
    });
    expect(output.policyVersion).toBe("qmd-remote-embedding-v2");
    expect(result.indexExistsAfter).toBe(false);
  });

  test("explains the paired models configuration required for remote options", async () => {
    const result = await remoteCli(["--remote-preflight"], "embed", null, false, false, false);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("models.embed_api_url");
    expect(result.stderr).toContain("models.embed_api_model");
    expect(result.stderr).not.toContain("embedding.provider: openai");
  });

  test("rejects the deprecated OpenAI models.embed shorthand before local model loading", async () => {
    const result = await remoteCli(
      ["--remote-preflight"],
      "embed",
      null,
      false,
      false,
      false,
      "openai:text-embedding-3-small",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("models.embed no longer accepts OpenAI shorthand");
    expect(result.stderr).toContain("models.embed_api_model");
    expect(result.indexExistsAfter).toBe(false);
  });

  test("keeps an existing index byte-identical during preflight", async () => {
    const result = await remoteCli(["--remote-preflight"], "embed", "", true);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pendingDocuments: 1 });
    expect(result.indexBytesUnchanged).toBe(true);
  });

  test("rejects a remote build before exact acknowledgement", async () => {
    const result = await remoteCli([], "embed", "test-key", true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Remote embedding requires acknowledgement of the exact current preflight");
  });

  test("rejects incomplete acknowledgement flags", async () => {
    const result = await remoteCli(["--remote-accept", "preflight-id"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--remote-accept requires --remote-fingerprint and --remote-policy");
  });

  test("requires force with remote rebuild authorization", async () => {
    const result = await remoteCli(["--allow-remote"], "embed", "test-key");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--allow-remote requires --force");
  });

  test("does not treat the deprecated destructive flag as remote authorization", async () => {
    const result = await remoteCli(["--allow-destructive-rebuild"], "embed", "test-key", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Remote embedding requires acknowledgement");
  });
});
