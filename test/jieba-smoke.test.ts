import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createJiebaLoader,
  loadJiebaCapability,
  type JiebaCapability,
} from "../src/search/jieba-loader.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function expectAvailable(capability: JiebaCapability) {
  if (!capability.available) {
    throw new Error(`Expected jieba to be available, got ${capability.diagnostic.code}`);
  }
  return capability;
}

describe("jieba capability loader", () => {
  test("keeps platform packages transitive and records verified targets in the lockfile", () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    const directDependencies = {
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    };
    const directPlatformPackages = Object.keys(directDependencies).filter(name => (
      name.startsWith("@node-rs/jieba-")
    ));

    expect(packageJson.dependencies["@node-rs/jieba"]).toBe("2.0.2");
    expect(directPlatformPackages).toEqual([]);

    const pnpmLockfile = readFileSync(join(projectRoot, "pnpm-lock.yaml"), "utf8");
    expect(pnpmLockfile).toContain("'@node-rs/jieba':");
    expect(pnpmLockfile).toContain("specifier: 2.0.2");
    expect(pnpmLockfile).toContain("'@node-rs/jieba-linux-x64-gnu@2.0.2'");
    expect(pnpmLockfile).toContain("'@node-rs/jieba-darwin-x64@2.0.2'");
    expect(pnpmLockfile).toContain("'@node-rs/jieba-darwin-arm64@2.0.2'");
  });

  test("loads the native package lazily and returns stable golden tokens", async () => {
    const capability = expectAvailable(await loadJiebaCapability());

    expect(capability.cut("我們使用記憶體快取資料", false)).toEqual([
      "我們",
      "使用",
      "記憶體",
      "快取",
      "資料",
    ]);
  });

  test("freezes the cached capability so callers cannot poison later analysis", async () => {
    const capability = await loadJiebaCapability();

    expect(Object.isFrozen(capability)).toBe(true);
    if (capability.available) {
      expect(() => {
        (capability as { cut: (text: string) => string[] }).cut = () => ["POISON"];
      }).toThrow(TypeError);
      expect(capability.cut("資料庫", false)).not.toEqual(["POISON"]);
    } else {
      expect(Object.isFrozen(capability.diagnostic)).toBe(true);
    }
  });

  test("initializes package and dictionary exactly once across concurrent callers", async () => {
    const imported: string[] = [];
    const loadedDictionaries: Uint8Array[] = [];
    const cut = (text: string) => [text];
    const loader = createJiebaLoader(async specifier => {
      imported.push(specifier);
      if (specifier === "@node-rs/jieba") {
        return { Jieba: { withDict: () => ({ cut, loadDict: (value: Uint8Array) => loadedDictionaries.push(value) }) } };
      }
      throw new Error("unexpected module");
    });

    const [first, second] = await Promise.all([loader(), loader()]);

    expect(first).toBe(second);
    expect(imported).toEqual(["@node-rs/jieba"]);
    expect(loadedDictionaries).toHaveLength(0);
    expect(expectAvailable(first).cut("test", false)).toEqual(["test"]);
  });

  test("returns a sanitized diagnostic when the native module cannot load", async () => {
    const secretError = "dlopen failed at /home/private-user/project/native.node with TOKEN=secret";
    const loader = createJiebaLoader(async () => {
      throw new Error(secretError);
    });

    const capability = await loader();

    expect(capability.available).toBe(false);
    if (capability.available) throw new Error("unreachable");
    expect(capability.diagnostic).toEqual({
      code: "JIEBA_NATIVE_UNAVAILABLE",
      message: "Chinese word segmentation is unavailable for this runtime.",
      runtime: `${process.platform}-${process.arch}`,
      remediation: "Reinstall @node-rs/jieba with optional dependencies enabled on a supported OS, architecture, and libc.",
    });
    expect(JSON.stringify(capability)).not.toContain(secretError);
    expect(JSON.stringify(capability)).not.toContain("private-user");
  });

  test("treats an incompatible module API as unavailable without exposing internals", async () => {
    const loader = createJiebaLoader(async specifier => (
      specifier === "@node-rs/jieba" ? { Jieba: {} } : { dict: new Uint8Array([1]) }
    ));

    const capability = await loader();

    expect(capability.available).toBe(false);
    if (capability.available) throw new Error("unreachable");
    expect(capability.diagnostic.code).toBe("JIEBA_NATIVE_UNAVAILABLE");
    expect(JSON.stringify(capability)).not.toContain("withDict");
  });
});
