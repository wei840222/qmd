import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/index.js";
import { openDatabase } from "../src/db.js";
import { getCjkLexicalIndexState } from "../src/search/cjk-index.js";
import { insertContent, insertDocument } from "../src/store.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("CJK CLI integration", () => {
  test("update publishes the CJK lexical index after reindexing collections", async () => {
    const repositoryRoot = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "qmd-cjk-cli-update-"));
    roots.push(root);
    const configDir = join(root, "config");
    const notesDir = join(root, "notes");
    const dbPath = join(root, "index.sqlite");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(notesDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(notesDir, "guide.md"), "# 台灣資料庫指南\n\n使用記憶體快取。\n"),
      writeFile(join(configDir, "index.yml"), [
        "collections:",
        "  notes:",
        `    path: ${JSON.stringify(notesDir)}`,
        "    pattern: \"**/*.md\"",
        "",
      ].join("\n")),
    ]);

    const result = spawnSync(
      "node",
      [
        join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        join(repositoryRoot, "src", "cli", "qmd.ts"),
        "update",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          NO_COLOR: "1",
          QMD_CONFIG_DIR: configDir,
          XDG_CACHE_HOME: join(root, "cache"),
          INDEX_PATH: dbPath,
          OPENAI_API_KEY: undefined,
          QMD_EMBED_MODEL: undefined,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const db = openDatabase(dbPath);
    try {
      expect(getCjkLexicalIndexState(db)).toMatchObject({
        status: "ready",
        wordCapability: "available",
        diagnosticCode: null,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM documents_fts_words").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM documents_fts_bigrams").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("search filters repeated collections before limiting candidates", async () => {
    const repositoryRoot = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "qmd-cli-search-filter-"));
    roots.push(root);
    const configDir = join(root, "config");
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    const outsideDir = join(root, "outside");
    const dbPath = join(root, "index.sqlite");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(firstDir, { recursive: true }),
      mkdir(secondDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);

    const store = await createStore({
      dbPath,
      config: {
        collections: {
          first: { path: firstDir, pattern: "**/*.md" },
          second: { path: secondDir, pattern: "**/*.md" },
          outside: { path: outsideDir, pattern: "**/*.md" },
        },
      },
    });
    try {
      const timestamp = "2026-07-24T00:00:00.000Z";
      for (let index = 0; index < 60; index += 1) {
        const hash = `cli-outside-${index}`;
        insertContent(store.internal.db, hash, "needle ".repeat(20), timestamp);
        insertDocument(store.internal.db, "outside", `${index}.md`, `Outside ${index}`, hash, timestamp, timestamp);
      }
      insertContent(store.internal.db, "cli-search-target", "needle target", timestamp);
      insertDocument(store.internal.db, "second", "target.md", "Target", "cli-search-target", timestamp, timestamp);
    } finally {
      await store.close();
    }

    await writeFile(join(configDir, "index.yml"), [
      "collections:",
      "  first:",
      `    path: ${JSON.stringify(firstDir)}`,
      "    pattern: \"**/*.md\"",
      "  second:",
      `    path: ${JSON.stringify(secondDir)}`,
      "    pattern: \"**/*.md\"",
      "  outside:",
      `    path: ${JSON.stringify(outsideDir)}`,
      "    pattern: \"**/*.md\"",
      "",
    ].join("\n"));

    const result = spawnSync(
      "node",
      [
        join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        join(repositoryRoot, "src", "cli", "qmd.ts"),
        "search",
        "needle",
        "-c",
        "first",
        "-c",
        "second",
        "--format",
        "json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          NO_COLOR: "1",
          QMD_CONFIG_DIR: configDir,
          XDG_CACHE_HOME: join(root, "cache"),
          INDEX_PATH: dbPath,
          OPENAI_API_KEY: undefined,
          QMD_EMBED_MODEL: undefined,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Array<{ file: string }>;
    expect(output.map(item => item.file)).toEqual(["qmd://second/target.md"]);
  });

  test("query searches every requested collection", async () => {
    const repositoryRoot = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "qmd-cjk-cli-"));
    roots.push(root);
    const configDir = join(root, "config");
    const noiseDir = join(root, "noise");
    const targetDir = join(root, "target");
    const dbPath = join(root, "index.sqlite");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(noiseDir, { recursive: true }),
      mkdir(targetDir, { recursive: true }),
    ]);

    const store = await createStore({
      dbPath,
      config: {
        collections: {
          noise: { path: noiseDir, pattern: "**/*.md" },
          target: { path: targetDir, pattern: "**/*.md" },
        },
      },
    });
    try {
      const timestamp = "2026-07-24T00:00:00.000Z";
      for (let index = 0; index < 601; index += 1) {
        const hash = `cli-noise-${index}`;
        insertContent(store.internal.db, hash, "資料庫同步 ".repeat(8), timestamp);
        insertDocument(store.internal.db, "noise", `noise-${index}.md`, `Noise ${index}`, hash, timestamp, timestamp);
      }
      insertContent(store.internal.db, "cli-target", "資料庫同步 第二集合專屬", timestamp);
      insertDocument(store.internal.db, "target", "only.md", "Target", "cli-target", timestamp, timestamp);
    } finally {
      await store.close();
    }

    await writeFile(join(configDir, "index.yml"), [
      "collections:",
      "  noise:",
      `    path: ${JSON.stringify(noiseDir)}`,
      "    pattern: \"**/*.md\"",
      "  target:",
      `    path: ${JSON.stringify(targetDir)}`,
      "    pattern: \"**/*.md\"",
      "",
    ].join("\n"));

    const result = spawnSync(
      "node",
      [
        join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        join(repositoryRoot, "src", "cli", "qmd.ts"),
        "query",
        "第二集合專屬",
        "-c",
        "noise",
        "-c",
        "target",
        "--no-rerank",
        "--format",
        "json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          NO_COLOR: "1",
          QMD_CONFIG_DIR: configDir,
          XDG_CACHE_HOME: join(root, "cache"),
          INDEX_PATH: dbPath,
          OPENAI_API_KEY: undefined,
          QMD_EMBED_MODEL: undefined,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as Array<{ file: string }>;
    expect(output.some(item => item.file.endsWith("target/only.md")), JSON.stringify(output)).toBe(true);
  });
});
