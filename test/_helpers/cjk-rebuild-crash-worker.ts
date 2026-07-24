import { rebuildCjkLexicalIndex } from "../../src/search/cjk-index.ts";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: cjk-rebuild-crash-worker <dbPath>");
  process.exit(2);
}

await rebuildCjkLexicalIndex(dbPath, {
  force: true,
  leaseDurationMs: 1_000,
  loadCapability: async () => ({
    available: true,
    cut: (text: string) => [text],
  }),
  onPhase: async (event) => {
    if (event.phase !== "snapshot-complete") return;
    process.stdout.write(`SNAPSHOT_COMPLETE:${event.buildId}\n`);
    await new Promise<never>(() => {});
  },
});
