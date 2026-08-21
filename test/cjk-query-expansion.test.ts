import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, hybridQuery, type Store } from "../src/store.js";
import {
  parseExpansionDirective,
  resolveExpansionPolicy,
} from "../src/search/query-expansion.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("shared query expansion policy", () => {
  test.each([
    ["資料庫同步", "cjk-default"],
    ["API 資料庫 migration", "cjk-default"],
    ["資", "cjk-default"],
  ] as const)("auto skips CJK query %s", (query, reason) => {
    expect(resolveExpansionPolicy({
      query,
      mode: "auto",
      strongSignal: false,
    })).toEqual({ action: "skip", reason, query });
  });

  test("auto skips non-CJK strong signals and otherwise expands", () => {
    expect(resolveExpansionPolicy({
      query: "database migration",
      mode: "auto",
      strongSignal: true,
    })).toEqual({
      action: "skip",
      reason: "strong-signal",
      query: "database migration",
    });
    expect(resolveExpansionPolicy({
      query: "database migration",
      mode: "auto",
      strongSignal: false,
    })).toEqual({
      action: "expand",
      reason: "auto-expand",
      query: "database migration",
    });
  });

  test("force overrides both CJK default and strong-signal bypass", () => {
    expect(resolveExpansionPolicy({
      query: "資料庫同步",
      mode: "force",
      strongSignal: true,
    })).toEqual({
      action: "expand",
      reason: "explicit-force",
      query: "資料庫同步",
    });
  });

  test("strips lex and expand prefixes before policy and CJK detection", () => {
    expect(parseExpansionDirective("  lex: 資料庫同步  ")).toEqual({
      directive: "skip",
      query: "資料庫同步",
    });
    expect(parseExpansionDirective("EXPAND: 資料庫同步")).toEqual({
      directive: "force",
      query: "資料庫同步",
    });
  });

  test("rejects an explicit force combined with lex prefix", () => {
    expect(() => resolveExpansionPolicy({
      query: "lex: 資料庫同步",
      mode: "force",
      strongSignal: false,
    })).toThrow("conflicting expansion directives");
  });
});

function fakeStore(options: {
  onSearch?: (query: string) => void;
  searchResults?: ReturnType<Store["searchFTS"]>;
  expandQuery?: Store["expandQuery"];
} = {}): Store {
  const db = {
    prepare: () => ({ get: () => undefined }),
    close: () => undefined,
  } as any;
  return {
    db,
    searchFTS: (query: string) => {
      options.onSearch?.(query);
      return options.searchResults ?? [];
    },
    expandQuery: options.expandQuery ?? (async () => []),
    getContextForFile: () => null,
  } as any;
}

describe("hybrid query expansion integration", () => {
  test("strips prefix before lexical retrieval and honors explicit skip", async () => {
    const searched: string[] = [];
    const decisions: string[] = [];
    const store = fakeStore({
      onSearch: query => searched.push(query),
      expandQuery: async () => {
        throw new Error("expansion must be skipped");
      },
    });
    try {
      await hybridQuery(store, "expand: 資料庫同步", {
        expansion: "skip",
        hooks: { onExpansionDecision: decision => decisions.push(decision.reason) },
      });
      expect(searched).toEqual(["資料庫同步"]);
      expect(decisions).toEqual(["explicit-skip"]);
    } finally {
      store.db.close();
    }
  });

  test("production expansion classifies a forced empty result as no-result", async () => {
    const errors: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "qmd-expansion-empty-"));
    tempDirs.push(root);
    const store = createStore(join(root, "index.sqlite"));
    store.llm = {
      generateModelName: "fake-expansion-model",
      expandQuery: async () => [],
    } as any;
    try {
      await expect(hybridQuery(store, "expand: 資料庫同步", {
        expansion: "auto",
        hooks: {
          onExpansionError: event => errors.push(event.reason),
        },
      })).rejects.toThrow("explicitly forced");
      expect(errors).toEqual(["no-result"]);
    } finally {
      store.db.close();
    }
  });

  test("production expansion classifies provider failures separately", async () => {
    const errors: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "qmd-expansion-error-"));
    tempDirs.push(root);
    const store = createStore(join(root, "index.sqlite"));
    store.llm = {
      generateModelName: "fake-expansion-model",
      expandQuery: async () => {
        throw new Error("provider unavailable");
      },
    } as any;
    try {
      await expect(hybridQuery(store, "expand: database migration", {
        hooks: {
          onExpansionError: event => errors.push(event.reason),
        },
      })).rejects.toThrow("provider unavailable");
      expect(errors).toEqual(["provider-error"]);
    } finally {
      store.db.close();
    }
  });

  test("rejects force combined with lex prefix", async () => {
    const errors: string[] = [];
    const store = fakeStore();
    try {
      await expect(hybridQuery(store, "lex: 資料庫同步", {
        expansion: "force",
        hooks: {
          onExpansionError: event => errors.push(event.reason),
        },
      })).rejects.toThrow("conflicting expansion directives");
      expect(errors).toEqual(["conflicting-directives"]);
    } finally {
      store.db.close();
    }
  });

  test("includes the expansion decision in explain output", async () => {
    const store = fakeStore({
      searchResults: [{
        filepath: "qmd://notes/sync.md",
        displayPath: "sync.md",
        title: "資料庫同步",
        body: "資料庫同步策略",
        context: null,
        hash: "abc123hash",
        modifiedAt: "2026-07-23T00:00:00Z",
        bodyLength: 8,
        score: 0.5,
        source: "fts",
        collectionName: "notes",
        docid: "abc123",
      }],
    });
    try {
      const results = await hybridQuery(store, "資料庫同步", {
        expansion: "skip",
        explain: true,
        skipRerank: true,
      });
      expect(results[0]?.explain?.expansion).toEqual({
        action: "skip",
        reason: "explicit-skip",
        query: "資料庫同步",
      });
    } finally {
      store.db.close();
    }
  });
});
