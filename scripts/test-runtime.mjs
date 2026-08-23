#!/usr/bin/env node
import { spawn } from "node:child_process";

const MODEL_TEST_GROUPS = [
  {
    name: "tokenizer",
    file: "test/store.test.ts",
    pattern: "^Token-based Chunking",
  },
  {
    name: "embedding-core",
    file: "test/llm.test.ts",
    pattern: [
      "returns embedding with correct dimensions",
      "returns consistent embeddings",
      "returns different embeddings",
      "returns embeddings for multiple texts",
      "returns same results as individual embed calls",
      "handles empty array",
      "batch is faster than sequential",
      "session provides access",
      "session prevents idle unload",
      "session embedBatch",
    ].join("|"),
  },
  {
    name: "embedding-concurrency",
    file: "test/llm.test.ts",
    pattern: "handles concurrent embedBatch calls",
  },
  {
    name: "embedding-store",
    file: "test/store.test.ts",
    pattern: "LlamaCpp Integration.*searchVec",
  },
  {
    name: "embedding-eval",
    file: "test/eval.test.ts",
    pattern: "BM25 Search|Vector Search|Hybrid Search",
  },
  {
    name: "rerank-core",
    file: "test/llm.test.ts",
    pattern: [
      "LlamaCpp Integration.*rerank",
      "LLM Session Management.*session rerank",
    ].join("|"),
  },
  {
    name: "rerank-store",
    file: "test/store.test.ts",
    pattern: "LlamaCpp Integration.*rerank",
  },
  {
    name: "expansion-core",
    file: "test/llm.test.ts",
    pattern: "LlamaCpp Integration.*expandQuery",
  },
  {
    name: "expansion-store",
    file: "test/store.test.ts",
    pattern: "LlamaCpp Integration.*expandQuery",
  },
  {
    name: "session-lifecycle",
    file: "test/llm.test.ts",
    pattern: [
      "LLM Session Management.*session is invalid",
      "LLM Session Management.*nested sessions",
      "LLM Session Management.*max duration",
      "LLM Session Management.*external abort",
      "LLM Session Management.*session provides abort signal",
      "LLM Session Management.*returns value",
      "LLM Session Management.*propagates errors",
    ].join("|"),
  },
];

function usage() {
  console.error("Usage: node scripts/test-runtime.mjs [--models-only] [--dry-run]");
  process.exit(2);
}

function commandFor(file, pattern) {
  const command = [process.execPath, "./node_modules/vitest/vitest.mjs", "run", "--reporter=verbose", "--testTimeout", "60000"];
  if (file) command.push(file);
  if (pattern) command.push("-t", pattern);
  return command;
}

function displayCommand(command) {
  return command.map(argument => JSON.stringify(argument)).join(" ");
}

function run(name, command, env, dryRun) {
  console.log(`\n=== ${name} ===`);
  console.log(displayCommand(command));
  if (dryRun) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        process.exit(code ?? 1);
      } else {
        resolve();
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith("--"));
const positional = args.filter(arg => !arg.startsWith("--"));

if (positional.length > 0 && positional[0] !== "node") {
  usage();
}
if (flags.some(flag => flag !== "--models-only" && flag !== "--dry-run")) {
  usage();
}

const modelsOnly = flags.includes("--models-only");
const dryRun = flags.includes("--dry-run");
const { CI: _inheritedCi, ...modelProcessEnv } = process.env;
const baseEnv = {
  ...process.env,
  CI: "true",
  QMD_MODEL_INTEGRATION: "0",
  QMD_MODEL_INTEGRATION_DIMENSION: "0",
};
const modelEnv = {
  ...modelProcessEnv,
  QMD_MODEL_INTEGRATION: "0",
  QMD_MODEL_INTEGRATION_DIMENSION: "0",
};

if (!modelsOnly) {
  await run("Node.js base suite", commandFor(), baseEnv, dryRun);
}
for (const group of MODEL_TEST_GROUPS) {
  await run(`Node.js local model: ${group.name}`, commandFor(group.file, group.pattern), modelEnv, dryRun);
}
