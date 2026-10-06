import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embedDocumentsWithDiskCache } from "../src/embedding/disk-document-cache.js";
import { DOCUMENT_CACHE_MAX_ENTRIES, DOCUMENT_CACHE_TTL_MS } from "../src/embedding/document-cache.js";
import { OpenAIEmbeddingProvider } from "../src/embedding/openai.js";
import { createStore } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qmd-disk-storage-"));
  directories.push(root);
  const cacheDir = join(root, "cache");
  const file = join(cacheDir, "document-embeddings-v1.sqlite");
  const fetch = vi.fn(async (texts: string[]) => texts.map(text => ({
    model: "model", dimension: 3, vector: [text.length / 100, 0.2, 0.3],
  })));
  const authorize = vi.fn(async () => {});
  const run = (texts: string[], bypass = false, signal = new AbortController().signal) =>
    embedDocumentsWithDiskCache(cacheDir, "identity", texts, "model", 3, fetch, authorize, signal, bypass);
  return { root, cacheDir, file, fetch, authorize, run };
}

describe("disk embedding cache storage", () => {
  test("bounds stored entries and expires cached results", async () => {
    const f = fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await f.run(Array.from({ length: DOCUMENT_CACHE_MAX_ENTRIES + 1 }, (_, i) => `text-${i}`));
    const db = new DatabaseSync(f.file);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM embeddings").get()).toMatchObject({ n: DOCUMENT_CACHE_MAX_ENTRIES });
    } finally { db.close(); }
    await f.run(["ttl"]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(now + DOCUMENT_CACHE_TTL_MS + 1);
    await f.run(["ttl"]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  test("evicts entries to respect the payload budget", async () => {
    const f = fixture();
    await f.run(["initial"]);
    const db = new DatabaseSync(f.file);
    try {
      // Fill capacity through fixture metadata to avoid allocating 64 MiB in the test.
      db.prepare("UPDATE embeddings SET bytes = ?").run(64 * 1024 * 1024);
    } finally { db.close(); }
    await f.run(["next"]);
    const after = new DatabaseSync(f.file);
    try {
      const row = after.prepare("SELECT sum(bytes) AS bytes FROM embeddings").get()!;
      expect(row.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally { after.close(); }
  });

  test.each(["not json", '{"model":"model","dimension":3,"vector":[1,2]}', '{"model":"model","dimension":3,"vector":[1e999,2,3]}'])("repairs a corrupt row: %s", async payload => {
    const f = fixture();
    await f.run(["same"]);
    const db = new DatabaseSync(f.file);
    try { db.prepare("UPDATE embeddings SET payload = ?").run(payload); }
    finally { db.close(); }
    expect((await f.run(["same"]))[0]!.vector).toEqual([0.04, 0.2, 0.3]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await f.run(["same"]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  test("rechecks cache-hit authorization and keeps failure out of the cache", async () => {
    const f = fixture();
    await f.run(["cached"]);
    f.authorize.mockRejectedValueOnce(new Error("lease lost"));
    await expect(f.run(["cached"])).rejects.toThrow("lease lost");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockResolvedValueOnce([{ model: "model", dimension: 3, vector: [0, NaN, 0] }]);
    await expect(f.run(["new"])).rejects.toMatchObject({ code: "DIMENSION_MISMATCH" });
    await f.run(["new"]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  test("cancellation releases the writer even when a transport ignores its signal", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.fetch>>>();
    const started = Promise.withResolvers<void>();
    f.fetch.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
    const controller = new AbortController();
    const owner = f.run(["same"], false, controller.signal);
    const rejected = expect(owner).rejects.toThrow();
    await started.promise;
    controller.abort();
    await rejected;
    await f.run(["same"]);
    gate.resolve([{ model: "model", dimension: 3, vector: [9, 9, 9] }]);
    expect((await f.run(["same"]))[0]!.vector).toEqual([0.04, 0.2, 0.3]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  test("a failure while publishing does not repeat a successful API call", async () => {
    const f = fixture();
    await f.run(["cached"]);
    const db = new DatabaseSync(f.file);
    try { db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON embeddings BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); }
    finally { db.close(); }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await f.run(["new"]))[0]!.vector).toEqual([0.03, 0.2, 0.3]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test("does not persist input text or credentials", async () => {
    const f = fixture();
    const provider = new OpenAIEmbeddingProvider({
      cacheDir: f.cacheDir, apiKey: "private-credential-sentinel", baseUrl: "https://fixture.invalid/v1",
      model: "custom", dimension: 3, authorizeRequest: () => {},
      fetch: async () => new Response(JSON.stringify({
        object: "list", model: "custom", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })),
    });
    try {
      await provider.embed("private-document-sentinel", { purpose: "index-build", kind: "document", identityFingerprint: "identity" });
    } finally { await provider.close(); }
    const contents = readFileSync(f.file).toString();
    expect(contents).not.toContain("private-credential-sentinel");
    expect(contents).not.toContain("private-document-sentinel");
  });

  test.each([false, true])("SDK config only opens disk cache for document embedding (readOnly=%s)", async readOnly => {
    const f = fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      object: "list", model: "custom", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })));
    vi.stubGlobal("fetch", fetch);
    const store = await createStore({
      dbPath: join(f.root, "index.sqlite"), readOnly,
      config: { collections: {}, models: {
        embed_api_url: "https://fixture.invalid/v1", embed_api_model: "custom", embed_dimension: 3,
        embed_cache_dir: f.cacheDir, embed_api_key: "fixture-key",
      } },
    });
    try {
      expect(existsSync(f.cacheDir)).toBe(false);
      await store.searchLex("none");
      expect(existsSync(f.cacheDir)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
