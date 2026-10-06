import { OpenAIEmbeddingProvider } from "../../src/embedding/openai.js";
import { VoyageEmbeddingProvider } from "../../src/embedding/voyage.js";
import type { EmbeddingOperationOptions } from "../../src/embedding/provider.js";

interface Request {
  provider: "openai" | "voyage";
  cacheDir: string;
  baseUrl: string;
  texts: string[];
  apiKey?: string;
  identityFingerprint?: string;
  bypassCache?: boolean;
  deadline?: number;
}

process.once("message", async (request: Request) => {
  const Provider = request.provider === "openai" ? OpenAIEmbeddingProvider : VoyageEmbeddingProvider;
  const provider = new Provider({
    cacheDir: request.cacheDir,
    baseUrl: request.baseUrl,
    model: "custom-embedding",
    dimension: 3,
    apiKey: request.apiKey ?? "test-account",
    authorizeRequest: () => {},
    maxAttempts: 1,
  });
  const options: EmbeddingOperationOptions = {
    purpose: "index-build", kind: "document",
    identityFingerprint: request.identityFingerprint ?? "build-v1",
    bypassCache: request.bypassCache,
    deadline: request.deadline,
  };
  try {
    const results = await provider.embedBatch(request.texts, options);
    process.send?.({ results });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await provider.close();
    process.disconnect();
  }
});
process.send?.({ ready: true });
