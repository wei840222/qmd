export const REMOTE_EMBEDDING_CHUNK_PROFILE = Object.freeze({
  algorithm: "qmd-utf8-window-v1",
  maxInputBytes: 8_192,
  overlapBasisPoints: 1_500,
  formatter: "qmd-openai-embedding-v1",
});

export interface RemoteEmbeddingChunk {
  readonly text: string;
  readonly pos: number;
  /** Conservative token upper bound for the fully formatted provider input. */
  readonly tokenUpperBound: number;
  readonly inputBytes: number;
}

const utf8Encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function documentPrefix(title?: string): string {
  return title ? `${title}\n` : "";
}

function largestEndWithinByteBudget(content: string, start: number, byteBudget: number): number {
  let end = start;
  let bytes = 0;
  for (const codePoint of content.slice(start)) {
    const nextBytes = utf8Bytes(codePoint);
    if (bytes + nextBytes > byteBudget) break;
    bytes += nextBytes;
    end += codePoint.length;
  }
  return end;
}

function overlapStart(content: string, chunkStart: number, chunkEnd: number, targetBytes: number): number {
  if (targetBytes <= 0) return chunkEnd;
  const codePoints = Array.from(content.slice(chunkStart, chunkEnd));
  let bytes = 0;
  let utf16Length = 0;
  for (let index = codePoints.length - 1; index >= 0; index--) {
    const codePoint = codePoints[index]!;
    const nextBytes = utf8Bytes(codePoint);
    if (bytes + nextBytes > targetBytes) break;
    bytes += nextBytes;
    utf16Length += codePoint.length;
  }
  return chunkEnd - utf16Length;
}

/**
 * Split remote embedding input without loading a local tokenizer.
 *
 * OpenAI's input limit is enforced using UTF-8 bytes as a conservative token
 * upper bound. Boundaries always fall between Unicode code points and positions
 * remain UTF-16 offsets so callers can slice the original JavaScript string.
 */
export function chunkRemoteDocumentByUtf8Bytes(
  content: string,
  title?: string,
): RemoteEmbeddingChunk[] {
  if (content.length === 0) return [];

  const prefix = documentPrefix(title);
  const prefixBytes = utf8Bytes(prefix);
  const contentByteBudget = REMOTE_EMBEDDING_CHUNK_PROFILE.maxInputBytes - prefixBytes;
  if (contentByteBudget < 1) {
    throw new Error("Document title leaves no UTF-8 input budget for remote embedding content.");
  }
  const overlapBytes = Math.floor(
    contentByteBudget * REMOTE_EMBEDDING_CHUNK_PROFILE.overlapBasisPoints / 10_000,
  );

  const chunks: RemoteEmbeddingChunk[] = [];
  let start = 0;
  while (start < content.length) {
    const end = largestEndWithinByteBudget(content, start, contentByteBudget);
    if (end <= start) {
      throw new Error("A document code point exceeds the remote embedding input budget.");
    }
    const text = content.slice(start, end);
    const inputBytes = prefixBytes + utf8Bytes(text);
    chunks.push({
      text,
      pos: start,
      tokenUpperBound: inputBytes,
      inputBytes,
    });
    if (end >= content.length) break;

    const nextStart = overlapStart(content, start, end, overlapBytes);
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

export function canonicalRemoteChunkProfile(): typeof REMOTE_EMBEDDING_CHUNK_PROFILE {
  return REMOTE_EMBEDDING_CHUNK_PROFILE;
}
