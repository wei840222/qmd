import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionConfig } from "../src/collections.js";
import {
  createStore,
  getStoreGlobalContext,
  renameStoreCollection,
  syncConfigToDb,
} from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fixturePath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-config-reconcile-")).then(directory => {
    temporaryDirectories.push(directory);
    return join(directory, "index.sqlite");
  });
}

function collectionRows(db: ReturnType<typeof createStore>["db"]): Array<{ name: string; path: string }> {
  return db.prepare(`SELECT name, path FROM store_collections ORDER BY name`).all() as Array<{ name: string; path: string }>;
}

describe("config to SQLite reconciliation", () => {
  test("repairs SQLite drift even when the external config hash is unchanged and reports exact diagnostics", async () => {
    const store = createStore(await fixturePath());
    try {
      const config: CollectionConfig = {
        collections: {
          alpha: { path: "/config/alpha", pattern: "**/*.md" },
          beta: { path: "/config/beta", pattern: "**/*.md" },
        },
        global_context: "authoritative context",
      };
      syncConfigToDb(store.db, config);

      expect(renameStoreCollection(store.db, "alpha", "drifted-alpha")).toBe(true);
      store.db.prepare(`UPDATE store_collections SET path = ? WHERE name = ?`).run("/drifted/beta", "beta");
      const hashBefore = store.db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get() as { value: string };

      const diagnostic = syncConfigToDb(store.db, config) as any;

      expect(diagnostic).toEqual({
        configHashChanged: false,
        reconciled: true,
        collections: {
          added: ["alpha"],
          updated: ["beta"],
          removed: ["drifted-alpha"],
        },
        globalContextUpdated: false,
      });
      expect(collectionRows(store.db)).toEqual([
        { name: "alpha", path: "/config/alpha" },
        { name: "beta", path: "/config/beta" },
      ]);
      expect(store.db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get()).toEqual(hashBefore);
      const persisted = store.db.prepare(`SELECT value FROM store_config WHERE key = 'config_sync_diagnostic'`).get() as { value: string };
      expect(JSON.parse(persisted.value)).toEqual(diagnostic);
    } finally {
      store.close();
    }
  });

  test("rolls back all collection, global-context, hash, and diagnostic changes when reconciliation fails", async () => {
    const store = createStore(await fixturePath());
    try {
      const baseline: CollectionConfig = {
        collections: {
          alpha: { path: "/old/alpha", pattern: "**/*.md" },
          beta: { path: "/old/beta", pattern: "**/*.md" },
        },
        global_context: "old context",
      };
      syncConfigToDb(store.db, baseline);
      const rowsBefore = collectionRows(store.db);
      const configRowsBefore = store.db.prepare(`SELECT key, value FROM store_config ORDER BY key`).all();

      store.db.exec(`
        CREATE TRIGGER fail_alpha_config_reconcile
        BEFORE UPDATE OF path ON store_collections
        WHEN NEW.name = 'alpha' AND NEW.path = '/new/alpha'
        BEGIN
          SELECT RAISE(ABORT, 'injected config reconcile failure');
        END;
      `);
      const changed: CollectionConfig = {
        collections: {
          gamma: { path: "/new/gamma", pattern: "**/*.md" },
          alpha: { path: "/new/alpha", pattern: "**/*.md" },
        },
        global_context: "new context",
      };

      expect(() => syncConfigToDb(store.db, changed)).toThrow(/injected config reconcile failure/);
      expect(collectionRows(store.db)).toEqual(rowsBefore);
      expect(store.db.prepare(`SELECT key, value FROM store_config ORDER BY key`).all()).toEqual(configRowsBefore);
    } finally {
      store.close();
    }
  });

  test("replays config-first collection rename and removal into documents after a crash boundary", async () => {
    const store = createStore(await fixturePath());
    try {
      const baseline: CollectionConfig = {
        collections: {
          old: { path: "/same/path", pattern: "**/*.md" },
          obsolete: { path: "/obsolete", pattern: "**/*.md" },
        },
      };
      syncConfigToDb(store.db, baseline);
      store.insertContent("rename-hash", "玉山重新命名", "2026-07-24T00:00:00.000Z");
      store.insertDocument("old", "rename.md", "重新命名", "rename-hash", "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z");
      store.insertContent("remove-hash", "玉山移除", "2026-07-24T00:00:00.000Z");
      store.insertDocument("obsolete", "remove.md", "移除", "remove-hash", "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z");
      const renamedId = (store.db.prepare(`SELECT id FROM documents WHERE collection = 'old'`).get() as { id: number }).id;
      const removedId = (store.db.prepare(`SELECT id FROM documents WHERE collection = 'obsolete'`).get() as { id: number }).id;

      const changed: CollectionConfig = {
        collections: {
          renamed: { path: "/same/path", pattern: "**/*.md" },
        },
      };
      syncConfigToDb(store.db, changed);

      expect(store.db.prepare(`SELECT collection, path FROM documents WHERE id = ?`).get(renamedId)).toEqual({
        collection: "renamed",
        path: "rename.md",
      });
      expect(store.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(removedId) == null).toBe(true);
      expect(store.db.prepare(`SELECT 1 FROM documents_fts WHERE rowid = ?`).get(removedId) == null).toBe(true);
      expect(store.db.prepare(`SELECT 1 FROM content WHERE hash = ?`).get("remove-hash") == null).toBe(true);
    } finally {
      store.close();
    }
  });

  test("reports a complete no-op when neither config nor SQLite has global context", async () => {
    const store = createStore(await fixturePath());
    try {
      const config: CollectionConfig = { collections: {} };
      syncConfigToDb(store.db, config);
      expect(syncConfigToDb(store.db, config)).toEqual({
        configHashChanged: false,
        reconciled: false,
        collections: { added: [], updated: [], removed: [] },
        globalContextUpdated: false,
      });
    } finally {
      store.close();
    }
  });

  test("preserves an empty global context and reports the second reconciliation as a no-op", async () => {
    const store = createStore(await fixturePath());
    try {
      const config: CollectionConfig = { collections: {}, global_context: "" };
      syncConfigToDb(store.db, config);

      expect(getStoreGlobalContext(store.db)).toBe("");
      expect(syncConfigToDb(store.db, config)).toEqual({
        configHashChanged: false,
        reconciled: false,
        collections: { added: [], updated: [], removed: [] },
        globalContextUpdated: false,
      });
    } finally {
      store.close();
    }
  });
});
