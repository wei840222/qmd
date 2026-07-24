import { formatDocForEmbedding, formatQueryForEmbedding } from "../llm.js";
import { EmbeddingProviderError } from "./provider.js";

export function canonicalLocalEmbeddingIdentityMaterial(model: string, dimension: number): string {
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new EmbeddingProviderError(
      "DIMENSION_MISMATCH",
      "Embedding identity dimension must be a positive integer.",
    );
  }
  return JSON.stringify({
    provider: "local-llama-cpp",
    model,
    dimension,
    remote: false,
    query_format: formatQueryForEmbedding("__qmd_query_identity__", model),
    document_format: formatDocForEmbedding(
      "__qmd_document_identity__",
      "__qmd_document_identity_title__",
      model,
    ),
  });
}
