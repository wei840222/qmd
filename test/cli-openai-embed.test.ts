import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("remote embedding CLI", () => {
  test("does not advertise removed remote consent flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-cli-remote-"));
    roots.push(root);
    const configDir = join(root, "config");
    await writeFile(join(root, "index.yml"), "collections: {}\n");
    const result = spawnSync(
      "node",
      [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "cli", "qmd.ts"), "--help"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, QMD_CONFIG_DIR: configDir },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    for (const flag of [
      "--remote-preflight",
      "--remote-accept",
      "--remote-fingerprint",
      "--remote-policy",
      "--remote-probe",
      "--allow-remote",
    ]) expect(result.stdout).not.toContain(flag);
  });
});
