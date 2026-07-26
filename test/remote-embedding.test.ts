import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type QMDStore } from "../src/index.js";

const roots: string[] = [];
const stores: QMDStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("remote embeddings without consent gates", () => {
  test("embeds and force-rebuilds directly without remote acknowledgement APIs or consent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-remote-embedding-"));
    roots.push(root);
    const documents = join(root, "documents");
    await mkdir(documents);
    await writeFile(join(documents, "guide.md"), "# Remote guide\n\nRemote content.");

    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
      return new Response(JSON.stringify({
        object: "list",
        model: body.model,
        data: body.input.map((_text, index) => ({
          object: "embedding",
          index,
          embedding: Array.from({ length: 1_536 }, () => 0.125),
        })),
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: {
        collections: { docs: { path: documents, pattern: "**/*.md" } },
        models: {
          embed_api_url: "https://api.openai.com/v1",
          embed_api_model: "text-embedding-3-small",
        },
      },
    });
    stores.push(store);

    try {
      await store.update();
      expect(store).not.toHaveProperty("preflightRemoteEmbedding");
      expect(store).not.toHaveProperty("acceptRemoteEmbeddingPreflight");
      expect(store).not.toHaveProperty("probeRemoteEmbedding");

      await expect(store.embed()).resolves.toMatchObject({ docsProcessed: 1, errors: 0 });
      await expect(store.embed({ force: true })).resolves.toMatchObject({ docsProcessed: 1, errors: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(store.internal.db.prepare(`
        SELECT name FROM sqlite_master WHERE name = 'remote_embedding_consents'
      `).get()).toBeFalsy();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });
});
