import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { EmbeddingVector } from "../src/embedding/provider.js";

const workerPath = fileURLToPath(new URL("./_helpers/disk-embedding-worker.ts", import.meta.url));
const children = new Set<ChildProcess>();
let root: string;
let server: Server;
let baseUrl: string;
let calls: string[][];
let generation: number;
let hold: boolean;
let requestStarted: ReturnType<typeof Promise.withResolvers<void>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qmd-disk-cache-test-"));
  calls = [];
  generation = 1;
  hold = false;
  requestStarted = Promise.withResolvers<void>();
  server = createServer(async (request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body.input);
    requestStarted.resolve();
    if (hold) return;
    // Keep the producer in flight while the other synchronized processes contend.
    await new Promise(resolve => setTimeout(resolve, 100));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      object: "list", model: body.model,
      data: body.input.map((text: string, index: number) => ({
        object: "embedding", index, embedding: [text.length / 100, generation, 0],
      })).reverse(),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }));
  children.clear();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

interface Overrides {
  apiKey?: string;
  identityFingerprint?: string;
  bypassCache?: boolean;
  cacheDir?: string;
  deadline?: number;
}

async function startWorker(provider: "openai" | "voyage") {
  const child = fork(workerPath, [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  const ready = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<EmbeddingVector[]>();
  // Attach rejection handling immediately, including for the deliberately killed owner.
  void outcome.promise.catch(() => {});
  let results: EmbeddingVector[] | undefined;
  child.on("message", (message: { ready?: boolean; results?: EmbeddingVector[]; error?: string }) => {
    if (message.ready) ready.resolve();
    if (message.results) results = message.results;
    if (message.error) outcome.reject(new Error(message.error));
  });
  child.on("error", error => { ready.reject(error); outcome.reject(error); });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (code === 0 && results) outcome.resolve(results);
    else {
      const error = new Error(`Embedding worker exited (${code ?? signal}): ${stderr}`);
      ready.reject(error);
      outcome.reject(error);
    }
  });
  await ready.promise;
  return {
    child,
    run(texts: string[], overrides: Overrides = {}) {
      child.send({ provider, cacheDir: root, baseUrl, texts, ...overrides });
      return outcome.promise;
    },
  };
}

for (const provider of ["openai", "voyage"] as const) {
  describe(`${provider} disk document cache`, () => {
    async function embed(texts: string[], overrides: Overrides = {}) {
      return (await startWorker(provider)).run(texts, overrides);
    }

    test("shares one request between three independent processes and survives their exit", async () => {
      const workers = await Promise.all(Array.from({ length: 3 }, () => startWorker(provider)));
      const results = await Promise.all(workers.map(worker => worker.run(["shared"])));
      expect(results.map(result => result[0]!.vector)).toEqual(Array(3).fill([0.06, 1, 0]));
      expect(calls).toEqual([["shared"]]);
      await embed(["shared"]);
      await embed(["shared"]);
      expect(calls).toEqual([["shared"]]);
    });

    test("fetches only missing batch inputs and restores duplicate order across restarts", async () => {
      await embed(["one", "longer"]);
      const results = await embed(["longer", "new", "one", "new"]);
      expect(results.map(result => result.vector[0])).toEqual([0.06, 0.03, 0.03, 0.03]);
      expect(calls).toEqual([["one", "longer"], ["new"]]);
    });

    test("isolates credentials and index identities", async () => {
      await embed(["same"]);
      await embed(["same"], { apiKey: "different-account" });
      await embed(["same"], { identityFingerprint: "build-v2" });
      await embed(["same"]);
      expect(calls).toHaveLength(3);
    });

    test("force refresh becomes visible to a newly loaded process", async () => {
      expect((await embed(["same"]))[0]!.vector[1]).toBe(1);
      generation = 2;
      expect((await embed(["same"], { bypassCache: true }))[0]!.vector[1]).toBe(2);
      expect((await embed(["same"]))[0]!.vector[1]).toBe(2);
      expect(calls).toHaveLength(2);
    });

    test("recovers the SQLite lock after the producing process is killed", async () => {
      hold = true;
      const owner = await startWorker(provider);
      const outcome = owner.run(["interrupted"]);
      await requestStarted.promise;
      owner.child.kill("SIGKILL");
      await expect(outcome).rejects.toThrow("SIGKILL");
      hold = false;
      const results = await embed(["interrupted"]);
      expect(results[0]!.vector).toEqual([0.11, 1, 0]);
      await embed(["interrupted"]);
      // The interrupted remote request cannot be undone; the successor retries once.
      expect(calls).toHaveLength(2);
    });

    test("a waiting process respects its deadline without stealing the producer lock", async () => {
      hold = true;
      const [owner, waiter] = await Promise.all([startWorker(provider), startWorker(provider)]);
      const ownerOutcome = owner.run(["waiting"]);
      await requestStarted.promise;
      await expect(waiter.run(["waiting"], { deadline: Date.now() + 150 }))
        .rejects.toThrow(/deadline/i);
      expect(calls).toHaveLength(1);
      owner.child.kill("SIGKILL");
      await expect(ownerOutcome).rejects.toThrow("SIGKILL");
      hold = false;
      expect((await embed(["waiting"]))[0]!.vector).toEqual([0.07, 1, 0]);
    });

    test("falls back when the existing cache database is corrupt", async () => {
      await writeFile(join(root, "document-embeddings-v1.sqlite"), "invalid sqlite contents");
      expect((await embed(["fallback"]))[0]!.vector).toEqual([0.08, 1, 0]);
      expect(calls).toHaveLength(1);
    });

    test("falls back to remote computation when the cache path is not a directory", async () => {
      const path = join(root, "file");
      await writeFile(path, "not a directory");
      expect((await embed(["fallback"], { cacheDir: path }))[0]!.vector).toEqual([0.08, 1, 0]);
      expect(calls).toHaveLength(1);
    });
  });
}
