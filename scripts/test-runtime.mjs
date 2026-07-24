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
  console.error("Usage: bun scripts/test-runtime.mjs <node|bun> [--models-only] [--dry-run]");
  process.exit(2);
}

function commandFor(runtime, file, pattern) {
  const command = runtime === "node"
    ? ["node", "./node_modules/vitest/vitest.mjs", "run", "--reporter=verbose", "--testTimeout", "60000"]
    : ["bun", "test", "--timeout", "60000", "--preload", "./src/test-preload.ts"];
  if (file) command.push(file);
  if (pattern) command.push("-t", pattern);
  return command;
}

function displayCommand(command) {
  return command.map(argument => JSON.stringify(argument)).join(" ");
}

async function run(name, command, env, dryRun) {
  console.log(`\n=== ${name} ===`);
  console.log(displayCommand(command));
  if (dryRun) return;

  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

const [runtime, ...flags] = process.argv.slice(2);
if (runtime !== "node" && runtime !== "bun") usage();
if (flags.some(flag => flag !== "--models-only" && flag !== "--dry-run")) usage();

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
  await run(`${runtime} base suite`, commandFor(runtime), baseEnv, dryRun);
}
for (const group of MODEL_TEST_GROUPS) {
  await run(`${runtime} local model: ${group.name}`, commandFor(runtime, group.file, group.pattern), modelEnv, dryRun);
}
