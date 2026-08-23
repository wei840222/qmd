#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

class PackageSmokeError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const { quiet, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet ? "pipe" : "inherit",
    shell: process.platform === "win32",
    ...spawnOptions,
  });
  if (result.status !== 0) {
    if (quiet) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new PackageSmokeError(`Package smoke failed: ${label}`, result.status ?? 1);
  }
}

function capture(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new PackageSmokeError(`Package smoke failed: ${label}`, result.status ?? 1);
  }
  return result.stdout;
}

function assertPath(path, label = path) {
  const full = join(root, path);
  if (!existsSync(full)) {
    throw new PackageSmokeError(`Package smoke failed: missing ${label} (${path})`);
  }
  return full;
}

function assertMissing(path, label = path) {
  if (existsSync(join(root, path))) {
    throw new PackageSmokeError(`Package smoke failed: unexpected ${label} (${path})`);
  }
}

function main() {
run("build compiled package", process.execPath, ["scripts/build.mjs"]);
run("AST grammar runtime packages", process.execPath, ["scripts/check-package-grammars.mjs"]);

for (const entry of pkg.files ?? []) {
  assertPath(entry.replace(/\/$/, ""), `package.json files[] entry ${entry}`);
}

for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
  const full = assertPath(binPath, `bin ${name}`);
  const mode = statSync(full).mode;
  if ((mode & 0o111) === 0) {
    throw new PackageSmokeError(`Package smoke failed: bin ${name} is not executable (${binPath})`);
  }
}

assertPath("dist/index.js", "compiled main export");
assertPath("dist/index.d.ts", "compiled type export");
assertPath("dist/cli/qmd.js", "compiled CLI");
assertPath("dist/search/jieba-loader.js", "compiled jieba capability loader");
assertPath("dist/search/cjk-analyzer.js", "compiled CJK analyzer");
assertPath("dist/search/zh-dict.txt", "compiled Chinese dictionary asset");
assertMissing("dist/search/zh-tw-dictionary.txt", "renamed Chinese dictionary asset");
assertMissing("dist/search/zh-tw-tech-dictionary.js", "legacy zh-TW dictionary module");
assertPath("THIRD_PARTY_NOTICES.md", "third-party notices");

run("compiled CLI under Node", process.execPath, ["dist/cli/qmd.js", "--help"], { quiet: true });
run("package wrapper", "sh", ["bin/qmd", "--help"], { quiet: true });

if (process.env.QMD_SKIP_BUN_SMOKE === "1") {
  console.log("==> compiled CLI under Bun (skipped by QMD_SKIP_BUN_SMOKE=1)");
} else {
  run("compiled CLI under Bun", "bun", ["dist/cli/qmd.js", "--help"], { quiet: true });
}

const packageSmokeRoot = process.env.QMD_PACKAGE_SMOKE_TMPDIR || join(root, ".tmp");
mkdirSync(packageSmokeRoot, { recursive: true });
const packageSmokeDir = mkdtempSync(join(packageSmokeRoot, "qmd-package-smoke-"));
try {
  const packOutput = capture("pack npm tarball", "npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packageSmokeDir,
  ]);
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult[0]?.filename;
  if (typeof tarballName !== "string") {
    throw new PackageSmokeError("Package smoke failed: npm pack did not report a tarball filename");
  }

  const consumerDir = join(packageSmokeDir, "consumer");
  mkdirSync(consumerDir);
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    "install packed tarball with Bun",
    "bun",
    ["add", "--ignore-scripts", join(packageSmokeDir, tarballName)],
    { cwd: consumerDir, quiet: true },
  );

  const installedScopeAndName = pkg.name.split("/");
  const installedRoot = join(consumerDir, "node_modules", ...installedScopeAndName);
  const loaderUrl = pathToFileURL(
    join(installedRoot, "dist", "search", "jieba-loader.js"),
  ).href;
  const analyzerUrl = pathToFileURL(
    join(installedRoot, "dist", "search", "cjk-analyzer.js"),
  ).href;
  for (const path of [
    "THIRD_PARTY_NOTICES.md",
    "dist/search/zh-dict.txt",
  ]) {
    if (!existsSync(join(installedRoot, path))) {
      throw new Error(`Packed package is missing ${path}`);
    }
  }
  const jiebaSmoke = `
    const { loadJiebaCapability } = await import(process.env.QMD_JIEBA_LOADER_URL);
    const capability = await loadJiebaCapability();
    if (!capability.available) throw new Error(capability.diagnostic.code);
    const actual = capability.cut("我們使用記憶體快取資料", false);
    const expected = ["我們", "使用", "記憶體", "快取", "資料"];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Unexpected jieba golden tokens");
    }
    const { analyzeCjk } = await import(process.env.QMD_CJK_ANALYZER_URL);
    const analyzed = await analyzeCjk("相依性雜湊佇列");
    if (analyzed.word !== "相依性 雜湊 佇列") throw new Error("Unexpected analyzer dictionary tokens");
    if (JSON.stringify(capability.cut("CC霜", false)) !== JSON.stringify(["CC霜"])) {
      throw new Error("Bundled Chinese dictionary is incomplete");
    }
  `;
  const smokeEnv = {
    ...process.env,
    QMD_JIEBA_LOADER_URL: loaderUrl,
    QMD_CJK_ANALYZER_URL: analyzerUrl,
  };

  run(
    "packed jieba capability under Node",
    process.execPath,
    ["--input-type=module", "--eval", jiebaSmoke],
    { cwd: consumerDir, env: smokeEnv, quiet: true },
  );
  if (process.env.QMD_SKIP_BUN_SMOKE !== "1") {
    run(
      "packed jieba capability under Bun",
      "bun",
      ["--eval", jiebaSmoke],
      { cwd: consumerDir, env: smokeEnv, quiet: true },
    );
  }
} finally {
  rmSync(packageSmokeDir, { recursive: true, force: true });
}
}

try {
  main();
} catch (error) {
  if (error instanceof PackageSmokeError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
