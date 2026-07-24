import type { EmbeddingProvider, EmbeddingProviderOwner } from "./provider.js";

export interface DisposableEmbeddingRuntime {
  dispose(): Promise<void>;
}

/** Owns a provider and the runtime it depends on. */
export class CompositeEmbeddingProviderOwner implements EmbeddingProviderOwner {
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly provider: EmbeddingProvider,
    private readonly runtime: DisposableEmbeddingRuntime,
  ) {}

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    let providerError: unknown;
    try {
      await this.provider.close();
    } catch (error) {
      providerError = error;
    }

    let runtimeError: unknown;
    try {
      await this.runtime.dispose();
    } catch (error) {
      runtimeError = error;
    }

    if (providerError !== undefined) throw providerError;
    if (runtimeError !== undefined) throw runtimeError;
  }
}
