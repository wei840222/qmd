/**
 * Collections configuration management
 *
 * This module manages the YAML-based collection configuration at ~/.config/qmd/index.yml.
 * Collections define which directories to index and their associated contexts.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "node:crypto";
import { basename, join, dirname, resolve } from "path";
import { qmdHomedir } from "./paths.js";
import YAML from "yaml";
import type { EmbeddingConfig } from "./embedding/config.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Context definitions for a collection
 * Key is path prefix (e.g., "/", "/2024", "/Board of Directors")
 * Value is the context description
 */
export type ContextMap = Record<string, string>;

/**
 * A single collection configuration
 */
export interface Collection {
  path: string;              // Absolute path to index
  pattern: string;           // Glob pattern (e.g., "**/*.md")
  ignore?: string[];         // Glob patterns to exclude (e.g., ["Sessions/**"])
  context?: ContextMap;      // Optional context definitions
  update?: string;           // Optional bash command to run during qmd update
  includeByDefault?: boolean; // Include in queries by default (default: true)
}

/**
 * Model configuration for embedding, reranking, and generation
 */
export interface ModelsConfig {
  embed?: string;
  rerank?: string;
  generate?: string;
}

/**
 * The complete configuration file structure
 */
export interface CollectionConfig {
  global_context?: string;                    // Context applied to all collections
  editor_uri?: string;                        // Editor URI template for terminal hyperlinks
  editor_uri_template?: string;               // Alias for editor_uri
  collections: Record<string, Collection>;    // Collection name -> config
  models?: ModelsConfig;
  embedding?: EmbeddingConfig;
}

/**
 * Collection with its name (for return values)
 */
export interface NamedCollection extends Collection {
  name: string;
}

// ============================================================================
// Configuration paths
// ============================================================================

// Current index name (default: "index")
let currentIndexName: string = "index";

// SDK mode: optional in-memory config or custom config path
export type CollectionConfigSource =
  | { type: "file"; path?: string }
  | { type: "inline"; config: CollectionConfig };

export function createCollectionConfigSource(
  source?: { configPath?: string; config?: CollectionConfig },
): CollectionConfigSource {
  if (source?.config) {
    source.config.collections ??= {};
    return { type: "inline", config: source.config };
  }
  return { type: "file", path: source?.configPath };
}

let configSource: CollectionConfigSource = createCollectionConfigSource();

export type ConfigWriteStage = "before-temp-write" | "before-rename";
let configWriteFaultInjector: ((stage: ConfigWriteStage) => void) | undefined;

/** @internal Test-only fault injection for crash-safety verification. */
export function setConfigWriteFaultInjectorForTests(
  injector?: (stage: ConfigWriteStage) => void,
): void {
  configWriteFaultInjector = injector;
}

/**
 * Set the config source for SDK mode.
 * - File path: load/save from a specific YAML file
 * - Inline config: use an in-memory CollectionConfig (saveConfig updates in place, no file I/O)
 * - undefined: reset to default file-based config
 */
export function setConfigSource(source?: { configPath?: string; config?: CollectionConfig }): void {
  configSource = createCollectionConfigSource(source);
}

/**
 * Set the current index name for config file lookup
 * Config file will be ~/.config/qmd/{indexName}.yml
 */
export function setConfigIndexName(name: string): void {
  // Resolve relative paths to absolute paths and sanitize for use as filename
  if (name.includes('/')) {
    const absolutePath = resolve(process.cwd(), name);
    // Replace path separators with underscores to create a valid filename
    currentIndexName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  } else {
    currentIndexName = name;
  }
}

function getConfigDir(): string {
  // Allow override via QMD_CONFIG_DIR for testing
  if (process.env.QMD_CONFIG_DIR) {
    return process.env.QMD_CONFIG_DIR;
  }
  // Respect XDG Base Directory specification (consistent with store.ts)
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "qmd");
  }
  return join(qmdHomedir(), ".config", "qmd");
}

function getConfigFilePath(): string {
  return join(getConfigDir(), `${currentIndexName}.yml`);
}

/**
 * Find a project-local QMD config by walking upward from startDir.
 * The local config lives at .qmd/index.yaml or .qmd/index.yml and,
 * when used by the CLI, keeps both config and index DB writes inside
 * the project instead of the global ~/.config / ~/.cache locations.
 */
export function findLocalConfigPath(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);

  while (true) {
    const qmdDir = join(dir, ".qmd");
    const yamlPath = join(qmdDir, "index.yaml");
    if (existsSync(yamlPath)) return yamlPath;

    const ymlPath = join(qmdDir, "index.yml");
    if (existsSync(ymlPath)) return ymlPath;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Return the local SQLite index path paired with a local .qmd/index.yaml file. */
export function getLocalDbPath(configPath: string): string {
  return join(dirname(configPath), "index.sqlite");
}

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

// ============================================================================
// Core functions
// ============================================================================

/**
 * Load configuration from the configured source.
 * - Inline config: returns the in-memory object directly
 * - File-based: reads from YAML file (default ~/.config/qmd/index.yml)
 * Returns empty config if file doesn't exist
 */
export function loadConfig(source: CollectionConfigSource = configSource): CollectionConfig {
  // SDK inline config mode
  if (source.type === 'inline') {
    return source.config;
  }

  // File-based config (SDK custom path or default)
  const configPath = source.path || getConfigFilePath();
  if (!existsSync(configPath)) {
    return { collections: {} };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(content) as CollectionConfig | null | undefined;
    const config = parsed ?? { collections: {} };

    // Ensure collections object exists
    if (!config.collections) {
      config.collections = {};
    }

    return config;
  } catch (error) {
    throw new Error(`Failed to parse ${configPath}: ${error}`);
  }
}

/**
 * Save configuration to the configured source.
 * - Inline config: updates the in-memory object (no file I/O)
 * - File-based: writes to YAML file (default ~/.config/qmd/index.yml)
 */
export function saveConfig(
  config: CollectionConfig,
  source: CollectionConfigSource = configSource,
): void {
  // SDK inline config mode: update in place, no file I/O
  if (source.type === 'inline') {
    source.config = config;
    return;
  }

  const configPath = source.path || getConfigFilePath();
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  try {
    const yaml = YAML.stringify(config, {
      indent: 2,
      lineWidth: 0,  // Don't wrap lines
    });
    const temporaryPath = join(
      configDir,
      `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryFd: number | undefined;
    let renamed = false;
    try {
      temporaryFd = openSync(temporaryPath, "wx", 0o600);
      configWriteFaultInjector?.("before-temp-write");
      writeFileSync(temporaryFd, yaml, "utf8");
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      temporaryFd = undefined;

      configWriteFaultInjector?.("before-rename");
      renameSync(temporaryPath, configPath);
      renamed = true;

      const directoryFd = openSync(configDir, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      if (!renamed && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  } catch (error) {
    throw new Error(`Failed to write ${configPath}: ${error}`);
  }
}

/**
 * Get a specific collection by name
 * Returns null if not found
 */
export function getCollection(name: string): NamedCollection | null {
  const config = loadConfig();
  const collection = config.collections[name];

  if (!collection) {
    return null;
  }

  return { name, ...collection };
}

/**
 * List all collections
 */
export function listCollections(): NamedCollection[] {
  const config = loadConfig();
  return Object.entries(config.collections).map(([name, collection]) => ({
    name,
    ...collection,
  }));
}

/**
 * Get collections that are included by default in queries
 */
export function getDefaultCollections(): NamedCollection[] {
  return listCollections().filter(c => c.includeByDefault !== false);
}

/**
 * Get collection names that are included by default
 */
export function getDefaultCollectionNames(): string[] {
  return getDefaultCollections().map(c => c.name);
}

/**
 * Update a collection's settings
 */
export function updateCollectionSettings(
  name: string,
  settings: { update?: string | null; includeByDefault?: boolean }
): boolean {
  const config = loadConfig();
  const collection = config.collections[name];
  if (!collection) return false;

  if (settings.update !== undefined) {
    if (settings.update === null) {
      delete collection.update;
    } else {
      collection.update = settings.update;
    }
  }

  if (settings.includeByDefault !== undefined) {
    if (settings.includeByDefault === true) {
      // true is default, remove the field
      delete collection.includeByDefault;
    } else {
      collection.includeByDefault = settings.includeByDefault;
    }
  }

  saveConfig(config);
  return true;
}

/**
 * Add or update a collection
 */
export function addCollection(
  name: string,
  path: string,
  pattern: string = "**/*.md",
  ignore?: string[],
  source: CollectionConfigSource = configSource,
): void {
  const config = loadConfig(source);

  config.collections[name] = {
    path,
    pattern,
    ignore: ignore ?? config.collections[name]?.ignore,
    context: config.collections[name]?.context, // Preserve existing context
  };

  saveConfig(config, source);
}

/**
 * Remove a collection
 */
export function removeCollection(
  name: string,
  source: CollectionConfigSource = configSource,
): boolean {
  const config = loadConfig(source);

  if (!config.collections[name]) {
    return false;
  }

  delete config.collections[name];
  saveConfig(config, source);
  return true;
}

/**
 * Rename a collection
 */
export function renameCollection(
  oldName: string,
  newName: string,
  source: CollectionConfigSource = configSource,
): boolean {
  const config = loadConfig(source);

  if (!config.collections[oldName]) {
    return false;
  }

  if (config.collections[newName]) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  config.collections[newName] = config.collections[oldName];
  delete config.collections[oldName];
  saveConfig(config, source);
  return true;
}

// ============================================================================
// Context management
// ============================================================================

/**
 * Get global context
 */
export function getGlobalContext(): string | undefined {
  const config = loadConfig();
  return config.global_context;
}

/**
 * Set global context
 */
export function setGlobalContext(
  context: string | undefined,
  source: CollectionConfigSource = configSource,
): void {
  const config = loadConfig(source);
  config.global_context = context;
  saveConfig(config, source);
}

/**
 * Get all contexts for a collection
 */
export function getContexts(collectionName: string): ContextMap | undefined {
  const collection = getCollection(collectionName);
  return collection?.context;
}

/**
 * Add or update a context for a specific path in a collection
 */
export function addContext(
  collectionName: string,
  pathPrefix: string,
  contextText: string,
  source: CollectionConfigSource = configSource,
): boolean {
  const config = loadConfig(source);
  const collection = config.collections[collectionName];

  if (!collection) {
    return false;
  }

  if (!collection.context) {
    collection.context = {};
  }

  collection.context[pathPrefix] = contextText;
  saveConfig(config, source);
  return true;
}

/**
 * Remove a context from a collection
 */
export function removeContext(
  collectionName: string,
  pathPrefix: string,
  source: CollectionConfigSource = configSource,
): boolean {
  const config = loadConfig(source);
  const collection = config.collections[collectionName];

  if (!collection?.context?.[pathPrefix]) {
    return false;
  }

  delete collection.context[pathPrefix];

  // Remove empty context object
  if (Object.keys(collection.context).length === 0) {
    delete collection.context;
  }

  saveConfig(config, source);
  return true;
}

/**
 * List all contexts across all collections
 */
export function listAllContexts(): Array<{
  collection: string;
  path: string;
  context: string;
}> {
  const config = loadConfig();
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Add global context if present
  if (config.global_context) {
    results.push({
      collection: "*",
      path: "/",
      context: config.global_context,
    });
  }

  // Add collection contexts
  for (const [name, collection] of Object.entries(config.collections)) {
    if (collection.context) {
      for (const [path, context] of Object.entries(collection.context)) {
        results.push({
          collection: name,
          path,
          context,
        });
      }
    }
  }

  return results;
}

/**
 * Find best matching context for a given collection and path
 * Returns the most specific matching context (longest path prefix match)
 */
export function findContextForPath(
  collectionName: string,
  filePath: string
): string | undefined {
  const config = loadConfig();
  const collection = config.collections[collectionName];

  if (!collection?.context) {
    return config.global_context;
  }

  // Find all matching prefixes
  const matches: Array<{ prefix: string; context: string }> = [];

  for (const [prefix, context] of Object.entries(collection.context)) {
    // Normalize paths for comparison
    const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;

    if (normalizedPath.startsWith(normalizedPrefix)) {
      matches.push({ prefix: normalizedPrefix, context });
    }
  }

  // Return most specific match (longest prefix)
  if (matches.length > 0) {
    matches.sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0]!.context;
  }

  // Fallback to global context
  return config.global_context;
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Get the config file path (useful for error messages)
 */
export function getConfigPath(): string {
  if (configSource.type === 'inline') return '<inline>';
  return configSource.path || getConfigFilePath();
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  if (configSource.type === 'inline') return true;
  const path = configSource.path || getConfigFilePath();
  return existsSync(path);
}

/**
 * Validate a collection name
 * Collection names must be valid and not contain special characters
 */
export function isValidCollectionName(name: string): boolean {
  // Allow alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
