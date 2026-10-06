import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAIEmbeddingProvider } from "../src/embedding/openai.js";
import { VoyageEmbeddingProvider } from "../src/embedding/voyage.js";
import type { EmbeddingProvider, EmbeddingOperationOptions } from "../src/embedding/provider.js";

const options: EmbeddingOperationOptions = {
  purpose: "index-build", kind: "document", identityFingerprint: "build-v1",
};
const providers: EmbeddingProvider[] = [];
afterEach(async () => { await Promise.all(providers.splice(0).map(p => p.close())); });

function response(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({
    object: "list", model: body.model,
    data: body.input.map((text: string, index: number) => ({
      object: "embedding", index,
      embedding: Array(body.dimensions ?? body.output_dimension ?? 3).fill(text.length / 100),
    })).reverse(),
    usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
  }), { status: 200 });
}

for (const Provider of [OpenAIEmbeddingProvider, VoyageEmbeddingProvider]) {
  describe(Provider.name, () => {
    function fixture() {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => response(init));
      const open = (overrides: Record<string, unknown> = {}) => {
        const provider = new Provider({
          baseUrl: "https://cache-test.invalid/v1", model: "custom-embedding", dimension: 3,
          apiKey: "test-account", maxAttempts: 1, fetch, authorizeRequest: () => {}, ...overrides,
        });
        providers.push(provider);
        return provider;
      };
      return { fetch, open };
    }

    test("deduplicates partial batches, restores order, and protects cached vectors from mutation", async () => {
      const { fetch, open } = fixture();
      const a = open();
      await a.embedBatch(["one", "longer"], options);
      const results = await open().embedBatch(["longer", "new", "one", "new"], options);
      expect(results.map(r => r.vector[0])).toEqual([0.06, 0.03, 0.03, 0.03]);
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input))
        .toEqual([["one", "longer"], ["new"]]);
      expect(results[0]!.usage).toBeUndefined();
      results[0]!.vector[0] = 99;
      expect((await a.embed("longer", options)).vector[0]).toBe(0.06);
    });

    test("isolates credentials, endpoint, model, dimension, identity and query inputs", async () => {
      const { fetch, open } = fixture();
      const a = open();
      await a.embed("same", options);
      await open().embed("same", options);
      expect(fetch).toHaveBeenCalledTimes(1);
      for (const override of [
        { apiKey: "rotated-account" }, { baseUrl: "https://other.invalid/v1" },
        { model: "another-model" }, { dimension: 4 },
      ]) await open(override).embed("same", options);
      await a.embed("same", { ...options, identityFingerprint: "format-v2" });
      await a.embed("same", { ...options, purpose: "query-embedding", kind: "query" });
      expect(fetch).toHaveBeenCalledTimes(7);
    });

    test("forced computation refreshes the cache and supersedes older flights", async () => {
      const { fetch, open } = fixture();
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      fetch.mockImplementationOnce(async (_url, init) => {
        started.resolve();
        await gate.promise;
        const body = await response(init).json();
        body.data[0].embedding = [0.9, 0.9, 0.9];
        return new Response(JSON.stringify(body));
      });
      const older = open().embed("shared", options);
      await started.promise;
      const newer = await open().embed("shared", { ...options, bypassCache: true });
      expect(newer.vector[0]).toBe(0.06);
      gate.resolve();
      expect((await older).vector[0]).toBe(0.9);
      expect((await open().embed("shared", options)).vector[0]).toBe(0.06);
      expect(fetch).toHaveBeenCalledTimes(2);
      await open().embed("shared", { ...options, bypassCache: true });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    test("checks authorization, closure, cancellation and deadlines on cache hits", async () => {
      const { fetch, open } = fixture();
      await open().embed("cached", options);
      await expect(open({ authorizeRequest: () => { throw new Error("lease lost"); } })
        .embed("cached", options)).rejects.toThrow("lease lost");
      await expect(open({ authorizeRequest: undefined }).embed("cached", options))
        .rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_REQUIRED" });
      const closed = open();
      await closed.close();
      await expect(closed.embed("cached", options)).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
      await expect(open().embed("cached", { ...options, signal: AbortSignal.abort() }))
        .rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      await expect(open().embed("cached", { ...options, deadline: Date.now() - 1 }))
        .rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each(["abort", "deadline", "close"])("recovers another store's flight after owner %s", async interruption => {
      const { fetch, open } = fixture();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementationOnce(async (_url, init) => {
        started.resolve();
        await new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        throw new Error("unreachable");
      });
      const owner = open();
      const controller = new AbortController();
      const first = owner.embed("shared", {
        ...options, signal: controller.signal,
        ...(interruption === "deadline" ? { deadline: Date.now() + 50 } : {}),
      });
      const firstOutcome = first.catch(error => error.code);
      await started.promise;
      const second = open().embed("shared", options);
      if (interruption === "abort") controller.abort();
      if (interruption === "close") await owner.close();
      expect(await firstOutcome).toBe({ abort: "OPERATION_ABORTED", deadline: "DEADLINE_EXCEEDED", close: "PROVIDER_CLOSED" }[interruption]);
      await expect(second).resolves.toMatchObject({ vector: [0.06, 0.06, 0.06] });
      expect(fetch).toHaveBeenCalledTimes(2);
      await open().embed("shared", options);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    test("a failed owner lease does not reject an independently authorized joiner", async () => {
      const { fetch, open } = fixture();
      const started = Promise.withResolvers<void>();
      const guard = Promise.withResolvers<void>();
      const owner = open({ authorizeRequest: async () => {
        started.resolve();
        await guard.promise;
      } }).embed("shared", options);
      const outcome = owner.catch(error => error.message);
      await started.promise;
      const joiner = open().embed("shared", options);
      guard.reject(new Error("owner lease lost"));
      expect(await outcome).toBe("owner lease lost");
      await expect(joiner).resolves.toMatchObject({ vector: [0.06, 0.06, 0.06] });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("a cancelled joiner does not abort the owner's request", async () => {
      const { fetch, open } = fixture();
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementationOnce(async (_url, init) => {
        started.resolve();
        await gate.promise;
        expect(init?.signal?.aborted).toBe(false);
        return response(init);
      });
      const owner = open().embed("shared", options);
      await started.promise;
      const controller = new AbortController();
      const joiner = open().embed("shared", { ...options, signal: controller.signal });
      controller.abort();
      await expect(joiner).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      gate.resolve();
      await owner;
      await open().embed("shared", options);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each(["missing", "dimension", "http", "timeout"])("does not cache a %s failure", async failure => {
      const { fetch, open } = fixture();
      fetch.mockImplementationOnce(async (_url, init) => {
        if (failure === "http") return new Response(null, { status: 500 });
        if (failure === "timeout") {
          await new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
        }
        const body = await response(init).json();
        if (failure === "missing") body.data.pop();
        else body.data[0].embedding.pop();
        return new Response(JSON.stringify(body));
      });
      const a = open({ requestTimeoutMs: 10 });
      await expect(a.embedBatch(["one", "two"], options)).rejects.toBeDefined();
      await expect(a.embedBatch(["one", "two"], options)).resolves.toHaveLength(2);
      await open().embedBatch(["two", "one"], options);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
}
