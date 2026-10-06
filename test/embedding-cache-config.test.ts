import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCollectionConfigSource,
  loadConfig,
  resolveEmbeddingCacheDir,
  saveConfig,
  type CollectionConfig,
} from "../src/collections.js";
import { resolveEmbeddingConfig } from "../src/embedding/config.js";
import { qmdHomedir } from "../src/paths.js";
import { gatedItems, hasGatedItems, sensitiveDigest } from "../src/trust.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "qmd-cache-config-"));
  directories.push(directory);
  return directory;
}
function config(cacheDir?: string): CollectionConfig {
  return { collections: {}, models: { embed_cache_dir: cacheDir } };
}

describe("embedding cache directory configuration", () => {
  test("resolves inline, YAML and project-local relative paths without creating directories", () => {
    const directory = temporaryDirectory();
    const inline = createCollectionConfigSource({ config: config("cache") });
    expect(resolveEmbeddingCacheDir(loadConfig(inline), inline)).toBe(resolve("cache"));
    const file = createCollectionConfigSource({ configPath: join(directory, "index.yml") });
    saveConfig(config("cache"), file);
    expect(resolveEmbeddingCacheDir(loadConfig(file), file)).toBe(join(directory, "cache"));
    expect(readFileSync(join(directory, "index.yml"), "utf8")).toContain("embed_cache_dir: cache");
    expect(existsSync(join(directory, "cache"))).toBe(false);
    const local = createCollectionConfigSource({ configPath: join(directory, ".qmd", "index.yml") });
    expect(resolveEmbeddingCacheDir(config("cache"), local)).toBe(join(directory, "cache"));
    expect(resolveEmbeddingCacheDir(config("~/cache"), local)).toBe(join(qmdHomedir(), "cache"));
    expect(resolveEmbeddingCacheDir(config("~"), local)).toBe(qmdHomedir());
    expect(resolveEmbeddingCacheDir(config(directory), local)).toBe(directory);
    expect(resolveEmbeddingCacheDir(config(), local)).toBeUndefined();
  });

  test.each(["", "  ", 42, false, null, {}, []])("rejects invalid cache directory %j on load and save", raw => {
    const value = config(raw as string);
    const inline = createCollectionConfigSource({ config: value });
    expect(() => loadConfig(inline)).toThrow("models.embed_cache_dir must be a non-empty string");
    expect(() => saveConfig(value, inline)).toThrow("models.embed_cache_dir must be a non-empty string");
    const directory = temporaryDirectory();
    const configPath = join(directory, "index.yml");
    writeFileSync(configPath, JSON.stringify(value));
    expect(() => loadConfig(createCollectionConfigSource({ configPath }))).toThrow("models.embed_cache_dir");
  });

  test("cache location does not change canonical embedding configuration", () => {
    const options = { defaultLocalModel: "local-model" };
    expect(resolveEmbeddingConfig({ ...options, config: config("/tmp/cache-a") }).canonical)
      .toEqual(resolveEmbeddingConfig({ ...options, config: config("/tmp/cache-b") }).canonical);
  });

  test("project-local external cache paths require trust and changing them invalidates approval", () => {
    const directory = temporaryDirectory();
    const path = join(directory, ".qmd", "index.yml");
    const builtins = { embed: "embed", rerank: "rerank", generate: "generate" };
    const snapshot = { hooks: [], paths: [], models: {} };
    expect(hasGatedItems(gatedItems(path, { ...snapshot, cacheDir: "cache" }, builtins))).toBe(false);
    const outside = temporaryDirectory();
    symlinkSync(outside, join(directory, "linked"), "dir");
    expect(hasGatedItems(gatedItems(path, { ...snapshot, cacheDir: "linked/not-created" }, builtins))).toBe(true);
    const external = { ...snapshot, cacheDir: join(tmpdir(), "qmd-shared-cache") };
    expect(gatedItems(path, external, builtins).cacheDir).toBe(external.cacheDir);
    expect(hasGatedItems(gatedItems(path, external, builtins))).toBe(true);
    expect(sensitiveDigest(external, path, builtins))
      .not.toBe(sensitiveDigest(snapshot, path, builtins));
    expect(sensitiveDigest(external, path, builtins))
      .not.toBe(sensitiveDigest({ ...external, cacheDir: `${external.cacheDir}-other` }, path, builtins));
  });
});
