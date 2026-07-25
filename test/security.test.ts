import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore as createSdkStore } from "../src/index.js";
import {
  createStore,
  hashContent,
  insertContent,
  insertDocument,
} from "../src/store.js";

const roots: string[] = [];
const originalApiKey = process.env.OPENAI_API_KEY;

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `qmd-security-${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("security boundaries", () => {
  test("parameterizes collection filters instead of executing injected SQL", async () => {
    const root = await temporaryRoot("sql");
    const store = createStore(join(root, "index.sqlite"));
    const body = "database security marker";
    const hash = await hashContent(body);
    const now = new Date().toISOString();

    try {
      insertContent(store.db, hash, body, now);
      insertDocument(store.db, "safe", "document.md", "Security", hash, now, now);

      expect(store.searchFTS("security", 10, "safe")).toHaveLength(1);
      expect(store.searchFTS("security", 10, `safe' OR 1=1 --`)).toEqual([]);
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  test("treats traversal-shaped retrieval input as an index pattern, not a filesystem path", async () => {
    const root = await temporaryRoot("traversal");
    const secret = "outside-index-secret-marker";
    await writeFile(join(root, "secret.txt"), secret);
    const store = createStore(join(root, "index.sqlite"));

    try {
      const result = store.findDocuments("../../secret.txt", { includeBody: true });
      expect(result.docs).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(store.findDocument("../../secret.txt", { includeBody: true })).toMatchObject({
        error: "not_found",
      });
    } finally {
      store.close();
    }
  });

  test("never persists the remote API key in SQLite or diagnostics", async () => {
    const root = await temporaryRoot("credentials");
    const dbPath = join(root, "index.sqlite");
    const secret = "qmd-security-test-api-key";
    process.env.OPENAI_API_KEY = secret;
    const store = await createSdkStore({
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
      const status = await store.getStatus();
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(status.diagnostics?.embedding.provider.keyConfigured).toBe(true);
    } finally {
      await store.close();
    }

    expect((await readFile(dbPath)).includes(Buffer.from(secret))).toBe(false);
  });

  test("does not let API-key presence switch a local store to remote mode", async () => {
    const root = await temporaryRoot("environment");
    process.env.OPENAI_API_KEY = "present-but-not-selected";
    const store = await createSdkStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: {} },
    });

    try {
      const status = await store.getStatus();
      expect(status.diagnostics?.embedding.provider).toMatchObject({
        id: "local-llama-cpp",
        remote: false,
        keyConfigured: false,
      });
    } finally {
      await store.close();
    }
  });
});
