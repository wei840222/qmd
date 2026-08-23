import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures: string[] = [];

const REAL_NODE = process.execPath;

function makeTempFixture() {
  const root = mkdtempSync(join(tmpdir(), "qmd-bin-wrapper-"));
  fixtures.push(root);
  const capturePath = join(root, "capture.txt");
  const runtimeBin = join(root, "runtime-bin");
  mkdirSync(runtimeBin, { recursive: true });

  const runtimePath = join(runtimeBin, "node");
  // Shebang of bin/qmd is `#!/usr/bin/env node`, so PATH `node` must
  // still launch the trampoline. The trampoline itself must NOT
  // re-resolve `node` from PATH for the child (#577 leftover): that
  // is the NODE_MODULE_VERSION bug. Exit 42 if it does.
  writeFileSync(
    runtimePath,
    `#!/bin/sh
if [ "$(basename "$1")" = "qmd" ]; then
  exec "${REAL_NODE}" "$@"
else
  echo "qmd launcher must not re-resolve node from PATH" >&2
  exit 42
fi
`,
  );
  chmodSync(runtimePath, 0o755);

  return { root, capturePath, runtimeBin };
}

function makePackage(root: string, packagePath: string, lockfiles: string[] = [], options: { dist?: boolean; source?: boolean; tsx?: boolean; git?: boolean } = {}) {
  const packageRoot = join(root, packagePath);
  const includeDist = options.dist ?? true;
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  copyFileSync(join(repoRoot, "bin", "qmd"), join(packageRoot, "bin", "qmd"));
  chmodSync(join(packageRoot, "bin", "qmd"), 0o755);
  if (includeDist) {
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(
      join(packageRoot, "dist", "cli", "qmd.js"),
      [
        'const { writeFileSync } = require("node:fs");',
        'const capture = process.env.QMD_WRAPPER_CAPTURE;',
        'if (capture) {',
        '  writeFileSync(capture, ["node", process.argv[1], ...process.argv.slice(2)].join("\\n") + "\\n");',
        '}',
        '',
      ].join("\n"),
    );
  }
  if (options.source) {
    mkdirSync(join(packageRoot, "src", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "cli", "qmd.ts"), "// source fixture\n");
  }
  if (options.tsx) {
    mkdirSync(join(packageRoot, "node_modules", "tsx", "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'const capture = process.env.QMD_WRAPPER_CAPTURE;',
        'if (capture) {',
        '  writeFileSync(capture, ["node", process.argv[1], ...process.argv.slice(2)].join("\\n") + "\\n");',
        '}',
        '',
      ].join("\n"),
    );
  }
  if (options.git) {
    mkdirSync(join(packageRoot, ".git"), { recursive: true });
  }
  for (const lockfile of lockfiles) {
    writeFileSync(join(packageRoot, lockfile), "");
  }
  return packageRoot;
}

function symlinkRelative(target: string, linkPath: string) {
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(relative(dirname(linkPath), target), linkPath);
}

function runWrapper(commandPath: string, runtimeBin: string, capturePath: string, env: Record<string, string> = {}) {
  rmSync(capturePath, { force: true });
  execFileSync(commandPath, ["--version"], {
    env: {
      ...process.env,
      ...env,
      PATH: `${runtimeBin}:${process.env.PATH ?? ""}`,
      QMD_WRAPPER_CAPTURE: capturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [runtime, scriptPath, ...args] = readFileSync(capturePath, "utf8").trimEnd().split("\n");
  return { runtime, scriptPath, args };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("bin/qmd package wrapper", () => {
  test("direct package invocation resolves dist/cli/qmd.js from the package root", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "node_modules/@tobilu/qmd");

    const result = runWrapper(join(packageRoot, "bin", "qmd"), runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
    expect(result.args).toEqual(["--version"]);
  });

  test("npm/Homebrew global bin symlink resolves scoped package path", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "opt/homebrew/lib/node_modules/@tobilu/qmd");
    const globalBin = join(root, "opt", "homebrew", "bin", "qmd");
    symlinkRelative(join(packageRoot, "bin", "qmd"), globalBin);

    const result = runWrapper(globalBin, runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
  });

  test("multi-hop global bin symlink chain resolves to the real package root", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "opt/homebrew/lib/node_modules/@tobilu/qmd");
    const globalBin = join(root, "opt", "homebrew", "bin", "qmd");
    const shim = join(root, "opt", "homebrew", "Cellar", "qmd", "current", "bin", "qmd");
    symlinkRelative(join(packageRoot, "bin", "qmd"), shim);
    symlinkRelative(shim, globalBin);

    const result = runWrapper(globalBin, runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
  });

  test("linuxbrew global bin symlink resolves lib/node_modules scoped package path", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "home/linuxbrew/.linuxbrew/lib/node_modules/@tobilu/qmd");
    const globalBin = join(root, "home", "linuxbrew", ".linuxbrew", "bin", "qmd");
    symlinkRelative(join(packageRoot, "bin", "qmd"), globalBin);

    const result = runWrapper(globalBin, runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
  });

  test("npx scoped package .bin symlink resolves @tobilu/qmd package path", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "npm/_npx/abc123/node_modules/@tobilu/qmd");
    const npxBin = join(root, "npm", "_npx", "abc123", "node_modules", ".bin", "qmd");
    symlinkRelative(join(packageRoot, "bin", "qmd"), npxBin);

    const result = runWrapper(npxBin, runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
  });

  test("packaged tree uses dist even if source files are present", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "node_modules/@tobilu/qmd", [], { source: true });

    const result = runWrapper(join(packageRoot, "bin", "qmd"), runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
  });

  test("prefers source through tsx in a Node checkout even when dist exists", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "qmd", [], { source: true, tsx: true, git: true });

    const result = runWrapper(join(packageRoot, "bin", "qmd"), runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs")));
    expect(result.args).toEqual([realpathSync(join(packageRoot, "src", "cli", "qmd.ts")), "--version"]);
  });

  test("node child uses process.execPath, not a different PATH node (#577 leftover)", () => {
    const { root, runtimeBin, capturePath } = makeTempFixture();
    const packageRoot = makePackage(root, "node_modules/@tobilu/qmd");

    const result = runWrapper(join(packageRoot, "bin", "qmd"), runtimeBin, capturePath);

    expect(result.runtime).toBe("node");
    expect(result.scriptPath).toBe(realpathSync(join(packageRoot, "dist", "cli", "qmd.js")));
    expect(result.args).toEqual(["--version"]);
  });

  test("explains how to build when dist is missing and source cannot run", () => {
    const { root, runtimeBin } = makeTempFixture();
    const packageRoot = makePackage(root, "qmd", [], { dist: false });

    const result = spawnSync(join(packageRoot, "bin", "qmd"), ["--version"], {
      env: {
        ...process.env,
        PATH: `${runtimeBin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("qmd is not built");
    expect(result.stderr).toContain("pnpm install && pnpm run build");
    expect(result.stderr).toContain("npm install && npm run build");
    expect(result.stderr).toContain("qmd doctor");
  });
});
