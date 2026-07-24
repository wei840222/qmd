import { LocalEmbeddingProviderOwner } from "../embedding/local.js";
import { CompositeEmbeddingProviderOwner } from "../embedding/owner.js";
import type { EmbeddingProvider, EmbeddingProviderOwner } from "../embedding/provider.js";
import { waitForLLMSessionsToDrain } from "../llm.js";

type LocalEmbeddingRuntime = ConstructorParameters<typeof LocalEmbeddingProviderOwner>[0];

export interface CliEmbeddingProviderConfig {
  provider: "local" | "openai";
  model: string;
  dimension: number | null;
}

export function createCliEmbeddingProviderOwner(
  config: CliEmbeddingProviderConfig,
  runtime: LocalEmbeddingRuntime,
  remoteProvider?: EmbeddingProvider,
): EmbeddingProviderOwner {
  if (config.provider === "local") {
    return new LocalEmbeddingProviderOwner(runtime, {
      model: config.model,
      ...(config.dimension == null ? {} : { dimension: config.dimension }),
    });
  }
  if (!remoteProvider?.remote) {
    throw new Error("OpenAI CLI composition requires a remote embedding provider.");
  }
  return new CompositeEmbeddingProviderOwner(remoteProvider, {
    dispose: async () => {
      await waitForLLMSessionsToDrain(runtime);
      await runtime.dispose();
    },
  });
}
