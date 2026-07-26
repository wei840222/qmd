import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type QMDStore } from "../src/index.js";
import { inspectIndexDiagnostics } from "../src/diagnostics.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import {
  beginEmbeddingBuild,
  completeEmbeddingBuild,
  createEmbeddingIdentity,
} from "../src/embedding/identity.js";
import { UnavailableOpenAIEmbeddingProvider } from "../src/embedding/openai.js";
import { canonicalEmbeddingBuildMaterial } from "../src/store.js";

const roots: string[] = [];
const stores: QMDStore[] = [];

function remoteProvider(): EmbeddingProvider {
  return {
    providerId: "openai-test",
    model: "text-embedding-3-small",
    dimension: 3,
    remote: true,
    canonicalIdentityMaterial: () => "provider=openai-test\nmodel=text-embedding-3-small\ndimension=3",
    canonicalIdentityMaterialForDimension: dimension =>
      `provider=openai-test\nmodel=text-embedding-3-small\ndimension=${dimension}`,
    formatQuery: text => text,
    formatDocument: (text, title) => `${title ?? ""}\n${text}`,
    embed: async () => ({
      vector: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
      dimension: 3,
    }),
    embedBatch: async inputs => inputs.map(() => ({
      vector: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
      dimension: 3,
    })),
    close: async () => undefined,
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("index diagnostics", () => {
  test("is side-effect free and exposes only allowlisted remote configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-diagnostics-"));
    roots.push(root);
    const store = await createStore({ dbPath: join(root, "index.sqlite") });
    stores.push(store);
    const db = store.internal.db;
    const before = Number((db.prepare(`SELECT total_changes() AS changes`).get() as { changes: number }).changes);

    const diagnostics = inspectIndexDiagnostics(db, {
      fallbackModel: "text-embedding-3-small",
      provider: remoteProvider(),
      keyConfigured: true,
    });
    const after = Number((db.prepare(`SELECT total_changes() AS changes`).get() as { changes: number }).changes);

    expect(after).toBe(before);
    expect(diagnostics.embedding.provider).toMatchObject({
      id: "openai-test",
      remote: true,
      model: "text-embedding-3-small",
      dimension: 3,
      keyConfigured: true,
    });
    expect(diagnostics.embedding).not.toHaveProperty("remote");
    expect(JSON.stringify(diagnostics)).not.toContain("apiKey");
    expect(JSON.stringify(diagnostics)).not.toContain("OPENAI_API_KEY");
    expect(diagnostics.lexical.channels).toEqual({
      char: "ready",
      word: "ready",
      bigram: "ready",
    });
  });

  test("adds nested embedding and lexical diagnostics to SDK status", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-sdk-status-"));
    roots.push(root);
    const store = await createStore({ dbPath: join(root, "index.sqlite") });
    stores.push(store);

    const before = Number((store.internal.db.prepare(`SELECT total_changes() AS changes`).get() as { changes: number }).changes);
    const status = await store.getStatus();
    const after = Number((store.internal.db.prepare(`SELECT total_changes() AS changes`).get() as { changes: number }).changes);

    expect(after).toBe(before);
    expect(status.diagnostics?.embedding.provider.id).toBe("local-llama-cpp");
    expect(status.diagnostics?.embedding.build.state).toBe("empty");
    expect(status.diagnostics?.lexical).toMatchObject({
      state: "empty",
      jiebaCapability: "unknown",
      repairCommand: null,
    });
  });

  test("keeps SDK status and health side-effect free on a legacy read-only index", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-readonly-legacy-status-"));
    roots.push(root);
    const dbPath = join(root, "index.sqlite");
    const writable = await createStore({ dbPath });
    writable.internal.db.exec("DROP TABLE embedding_index_state");
    await writable.close();

    const readOnly = await createStore({ dbPath, readOnly: true });
    stores.push(readOnly);

    await expect(readOnly.getStatus()).resolves.toMatchObject({
      totalDocuments: 0,
      needsEmbedding: 0,
      diagnostics: {
        embedding: { build: { state: "missing" } },
      },
    });
    await expect(readOnly.getIndexHealth()).resolves.toMatchObject({
      needsEmbedding: 0,
      totalDocs: 0,
    });
    const identityTable = readOnly.internal.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_state'
    `).get();
    expect(identityTable == null).toBe(true);
  });

  test.each([
    { kind: "local", provider: undefined as EmbeddingProvider | undefined },
    { kind: "openai", provider: new UnavailableOpenAIEmbeddingProvider() as EmbeddingProvider },
  ])("recognizes a ready $kind identity from configured provider data without provider calls", async ({ kind, provider }) => {
    const root = await mkdtemp(join(tmpdir(), `qmd-configured-${kind}-status-`));
    roots.push(root);
    const store = await createStore({ dbPath: join(root, "index.sqlite") });
    stores.push(store);
    const identityProvider = provider ?? store.internal.embeddingProvider!;
    const dimension = identityProvider.dimension ?? 3;
    const identity = createEmbeddingIdentity({
      providerId: identityProvider.providerId,
      model: identityProvider.model,
      dimension,
      remote: identityProvider.remote,
      canonicalMaterial: canonicalEmbeddingBuildMaterial(
        identityProvider.canonicalIdentityMaterialForDimension?.(dimension)
          ?? identityProvider.canonicalIdentityMaterial(),
        "regex",
      ),
    });
    const lease = beginEmbeddingBuild(store.internal.db, identity, {
      ownerId: `configured-${kind}-status`,
      now: 1_000,
      leaseMs: 1_000,
      allowDestructiveRebuild: true,
    });
    completeEmbeddingBuild(store.internal.db, lease, 1_100);

    const diagnostics = inspectIndexDiagnostics(store.internal.db, {
      fallbackModel: identity.model,
      configuredProvider: {
        id: identity.providerId,
        remote: identity.remote,
        model: identity.model,
        dimension: identity.dimension,
      },
    });

    expect(diagnostics.embedding.identity.fullFingerprint).toBe(identity.fingerprint);
    expect(diagnostics.embedding.identity.compatible).toBe(true);
    expect(diagnostics.embedding.build.state).toBe("ready");
    expect(diagnostics.embedding.chunks.pendingDocuments).toBe(0);
  });


  test("reports dirty lexical state with per-channel readiness and repair reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-dirty-status-"));
    roots.push(root);
    const store = await createStore({ dbPath: join(root, "index.sqlite") });
    stores.push(store);
    store.internal.db.prepare(`
      UPDATE cjk_index_state
      SET status = 'dirty', diagnostic_code = 'CJK_CONFIG_RESYNC',
          dirty_since_mutation_seq = 7
      WHERE singleton = 1
    `).run();

    const diagnostics = inspectIndexDiagnostics(store.internal.db, {
      fallbackModel: "local-model",
      provider: store.internal.embeddingProvider,
    });

    expect(diagnostics.lexical).toMatchObject({
      state: "dirty",
      dirtySinceMutationSeq: 7,
      rebuildReason: "CJK_CONFIG_RESYNC",
      repairCommand: "qmd update",
      channels: { word: "stale", bigram: "stale" },
    });
  });
});
