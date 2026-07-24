import { describe, expect, test } from "vitest";
import {
  REMOTE_EMBEDDING_CHUNK_PROFILE,
  chunkRemoteDocumentByUtf8Bytes,
} from "../src/embedding/remote-chunking.js";

const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

describe("remote embedding UTF-8 chunking", () => {
  test.each([
    ["ASCII", "x".repeat(20_000)],
    ["Traditional Chinese", "台灣技術術語與文件檢索。".repeat(1_000)],
    ["emoji", "👩🏻‍💻🔍".repeat(2_000)],
  ])("keeps every %s provider input within the conservative byte budget", (_label, content) => {
    const title = "索引標題";
    const chunks = chunkRemoteDocumentByUtf8Bytes(content, title);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.pos).toBe(0);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      expect(content.slice(chunk.pos, chunk.pos + chunk.text.length)).toBe(chunk.text);
      expect(bytes(`${title}\n${chunk.text}`)).toBeLessThanOrEqual(
        REMOTE_EMBEDDING_CHUNK_PROFILE.maxInputBytes,
      );
      expect(chunk.inputBytes).toBe(bytes(`${title}\n${chunk.text}`));
      expect(chunk.tokenUpperBound).toBe(chunk.inputBytes);
      if (index > 0) {
        const previous = chunks[index - 1]!;
        expect(chunk.pos).toBeGreaterThan(previous.pos);
        expect(chunk.pos).toBeLessThan(previous.pos + previous.text.length);
      }
    }
    const last = chunks.at(-1)!;
    expect(last.pos + last.text.length).toBe(content.length);
  });

  test("accounts for the title prefix when selecting chunk boundaries", () => {
    const title = "T".repeat(2_000);
    const chunks = chunkRemoteDocumentByUtf8Bytes("x".repeat(10_000), title);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(bytes(`${title}\n${chunk.text}`)).toBeLessThanOrEqual(8_192);
    }
  });

  test("fails closed when the title consumes the entire request budget", () => {
    expect(() => chunkRemoteDocumentByUtf8Bytes("content", "x".repeat(8_192)))
      .toThrow("leaves no UTF-8 input budget");
  });
});
