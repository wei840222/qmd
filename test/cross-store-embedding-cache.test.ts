import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore, type QMDStore } from "../src/index.js";

const stores: QMDStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(provider: "openai" | "voyageai", disk = false) {
  const root = await mkdtemp(join(tmpdir(), "qmd-cross-store-cache-"));
  directories.push(root);
  const docs = join(root, "docs");
  await mkdir(docs);
  const endpoint = `https://${randomUUID()}.invalid/v1`;
  const model = provider === "openai" ? "text-embedding-3-small" : "voyage-3.5";
  const requests: string[][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toBe(`${endpoint}/embeddings`);
    const payload = JSON.parse(String(init.body));
    requests.push([...payload.input]);
    // Yield so independent stores can join an outstanding embedding request.
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      object: "list",
      model: payload.model,
      data: payload.input.map((input: string, index: number) => ({
        object: "embedding",
        index,
        embedding: [input.length / 1000, 0.2, 0.3],
      })),
      usage: { prompt_tokens: payload.input.length, total_tokens: payload.input.length },
    }), { headers: { "content-type": "application/json" } });
  }));
  const open = async (name: string, path = docs) => {
    const store = await createStore({
      dbPath: join(root, `${name}.sqlite`),
      config: {
        collections: { docs: { path, pattern: "**/*.md" } },
        models: {
          embed_provider: provider,
          embed_api_model: model,
          embed_api_url: endpoint,
          embed_api_key: "test-shared-account",
          embed_dimension: 3,
          ...(disk ? { embed_cache_dir: join(root, "cache") } : {}),
        },
      },
    });
    stores.push(store);
    return store;
  };
  return { root, docs, requests, open };
}

function expectReadyChunk(store: QMDStore) {
  expect(store.internal.db.prepare(`
    SELECT status FROM embedding_index_state WHERE singleton = 1
  `).get()).toMatchObject({ status: "ready" });
  expect(store.internal.db.prepare(`
    SELECT cv.seq, cv.total_chunks
    FROM documents d
    JOIN content_vectors cv ON cv.hash = d.hash
    JOIN vectors_vec vv ON vv.hash_seq = cv.hash || '_' || cv.seq
    WHERE d.active = 1
  `).all()).toEqual([{ seq: 0, total_chunks: 1 }]);
}

describe.each([
  ["openai", false], ["voyageai", false], ["openai", true], ["voyageai", true],
] as const)("%s cross-store document embeddings (disk=%s)", (provider, disk) => {
  test.each(["sequential", "concurrent"] as const)("shares changed content across three %s stores", async mode => {
    const { root, docs, requests, open } = await fixture(provider, disk);
    const document = join(docs, "shared.md");
    await writeFile(document, "# Shared guide\n\nOriginal shared document.\n");
    const agents = await Promise.all(["a", "b", "c"].map(name => open(name)));
    const refresh = async (store: QMDStore) => {
      await store.update();
      return store.embed();
    };
    for (const store of agents) await refresh(store);
    expect(existsSync(join(root, "cache", "document-embeddings-v1.sqlite"))).toBe(disk);
    requests.length = 0;

    await writeFile(document, "# Shared guide\n\nChanged shared document unique marker.\n");
    const results = [];
    if (mode === "concurrent") results.push(...await Promise.all(agents.map(refresh)));
    else for (const store of agents) results.push(await refresh(store));

    expect(results.map(result => result.chunksEmbedded)).toEqual([1, 1, 1]);
    for (const store of agents) expectReadyChunk(store);
    expect(requests.flat()).toHaveLength(1);
    expect(requests).toHaveLength(1);

    requests.length = 0;
    const unchanged = await Promise.all(agents.map(refresh));
    expect(unchanged.map(result => result.chunksEmbedded)).toEqual([0, 0, 0]);
    expect(requests).toHaveLength(0);
  });

  test("keeps differently titled documents separate", async () => {
    const { root, docs, requests, open } = await fixture(provider, disk);
    const otherDocs = join(root, "other-docs");
    await mkdir(otherDocs);
    await writeFile(join(docs, "shared.md"), "# First title\n\nThe same document body.\n");
    await writeFile(join(otherDocs, "shared.md"), "# Second title\n\nThe same document body.\n");
    const agents = await Promise.all([open("first"), open("second", otherDocs)]);
    for (const store of agents) await store.update();
    const results = await Promise.all(agents.map(store => store.embed()));
    expect(results.map(result => result.chunksEmbedded)).toEqual([1, 1]);
    expect(requests.flat()).toHaveLength(2);
    expect(new Set(requests.flat()).size).toBe(2);
    for (const store of agents) expectReadyChunk(store);
  });
});
