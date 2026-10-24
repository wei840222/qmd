import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createStore } from "../src/index.js";
import { setConfigSource } from "../src/collections.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

const roots: string[] = [];
const servers: Server[] = [];
const mcpServers: HttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(mcpServers.splice(0).map(server => server.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  setConfigSource();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runCli(root: string, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "VOYAGE_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "QMD_EMBED_MODEL", "QMD_GENERATE_MODEL", "QMD_RERANK_MODEL"]) delete env[name];
  const child = spawn(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "src/cli/qmd.ts"), ...args], {
    cwd: root,
    env: { ...env, CI: "true", PWD: root, INDEX_PATH: join(root, "index.sqlite"), QMD_CONFIG_DIR: join(root, "config") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
  return { stdout, stderr, code };
}

async function fixture(models: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "qmd-remote-cli-mcp-"));
  roots.push(root);
  await mkdir(join(root, "config"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs/deploy.md"), "# Deployment\n\nThe blue unicorn deployment needs a readiness probe.\n");
  const configPath = join(root, "config/index.yml");
  await writeFile(configPath, YAML.stringify({ collections: { docs: { path: join(root, "docs"), pattern: "**/*.md" } }, ...(Object.keys(models).length ? { models } : {}) }));
  const update = await runCli(root, "update");
  expect(update.code, update.stderr).toBe(0);
  return { root, configPath };
}

describe("remote-only CLI and MCP", () => {
  test("keeps lexical reads and diagnostics model-free and retires pull without config writes", async () => {
    const { root, configPath } = await fixture();
    const before = await readFile(configPath, "utf8");
    for (const args of [["search", "unicorn", "--json"], ["get", "docs/deploy.md"], ["doctor"], ["collection", "list"]]) {
      const result = await runCli(root, ...args);
      expect(result.code, result.stderr).toBe(0);
    }
    const pull = await runCli(root, "pull", "--refresh");
    expect(pull.code).not.toBe(0);
    expect(pull.stderr).toContain("retired");
    expect(await readFile(configPath, "utf8")).toBe(before);
    const vector = await runCli(root, "vsearch", "unicorn");
    expect(vector.code).not.toBe(0);
    expect(vector.stderr).toMatch(/remote|retired|rebuild/i);
  });

  test("uses configured loopback APIs for CLI builds/search and MCP query without local fallback", async () => {
    const requests: Array<{ path: string; body: Record<string, any> }> = [];
    let mode: "normal" | "error" | "stall" = "normal";
    let onStalled: (() => void) | undefined;
    let onAborted: (() => void) | undefined;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      requests.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/chat/completions") && mode === "error") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: "test-only failure" } }));
        return;
      }
      if (req.url?.endsWith("/chat/completions") && mode === "stall") {
        res.on("close", () => onAborted?.());
        onStalled?.();
        return;
      }
      if (req.url?.endsWith("/embeddings")) {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.end(JSON.stringify({ data: inputs.map((_: unknown, index: number) => ({ index, embedding: [0.5, 0.5, 0.5, 0.5] })), usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } }));
      } else if (req.url?.endsWith("/rerank")) {
        res.end(JSON.stringify({ results: body.documents.map((_: unknown, index: number) => ({ index, relevance_score: 0.95 })) }));
      } else if (req.url?.endsWith("/chat/completions")) {
        res.end(JSON.stringify({ choices: [{ message: { content: "lex: unicorn deployment\nvec: unicorn deployment readiness" } }] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const { root, configPath } = await fixture({
      embed_api_url: endpoint, embed_api_model: "test-embed", embed_dimension: 4,
      embed_api_key: "test-only-key",
      generate_api_url: endpoint, generate_api_model: "test-expansion",
      rerank_api_url: `${endpoint}/rerank`, rerank_api_model: "test-rerank",
    });
    for (const args of [["doctor"], ["status"], ["search", "unicorn", "--json"]]) {
      const result = await runCli(root, ...args);
      expect(result.code, result.stderr).toBe(0);
    }
    expect(requests).toHaveLength(0);
    const embed = await runCli(root, "embed", "--force");
    expect(embed.code, embed.stderr).toBe(0);
    expect(requests.some(request => request.path.endsWith("/embeddings") && request.body.model === "test-embed")).toBe(true);
    const query = await runCli(root, "query", "unicorn deployment readiness", "--expand", "--json");
    expect(query.code, query.stderr).toBe(0);
    expect(JSON.parse(query.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining("deploy.md") })]));
    expect(requests.some(request => request.path.endsWith("/chat/completions") && request.body.model === "test-expansion")).toBe(true);
    expect(requests.some(request => request.path.endsWith("/rerank") && request.body.model === "test-rerank")).toBe(true);

    const sdk = await createStore({ dbPath: join(root, "index.sqlite"), configPath });
    try {
      const sdkStart = requests.length;
      await sdk.embed({ force: true });
      expect(requests.length).toBeGreaterThan(sdkStart);
      const sdkResults = await sdk.search({ query: "unicorn deployment readiness SDK", expansion: "force", rerank: true });
      expect(sdkResults.some(result => result.displayPath.endsWith("deploy.md"))).toBe(true);
      const sdkLexicalStart = requests.length;
      expect(await sdk.searchLex("unicorn")).not.toHaveLength(0);
      expect(requests).toHaveLength(sdkLexicalStart);
      mode = "error";
      await expect(sdk.expandQuery("SDK remote error unique request")).rejects.toThrow(/503/);
    } finally {
      await sdk.close();
      mode = "normal";
    }
    const cancellable = await createStore({ dbPath: join(root, "index.sqlite"), configPath, readOnly: true });
    mode = "stall";
    const stalled = new Promise<void>(resolve => { onStalled = resolve; });
    const aborted = new Promise<void>(resolve => { onAborted = resolve; });
    const cancellation = expect(cancellable.expandQuery("SDK close cancels a remote request")).rejects.toThrow(/disposed|abort/i);
    await stalled;
    await cancellable.close();
    await cancellation;
    await aborted;
    mode = "normal";

    setConfigSource({ configPath });
    const mcp = await startMcpHttpServer(0, { dbPath: join(root, "index.sqlite"), quiet: true });
    mcpServers.push(mcp);
    const before = requests.length;
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "query" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "query", arguments: { query: "unicorn deployment readiness details", expansion: "force", rerank: true },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "remote-only-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} },
      } }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.result?.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("deploy.md");
    expect(requests.length).toBeGreaterThan(before);
    const lexicalStart = requests.length;
    const lexical = await fetch(`http://127.0.0.1:${mcp.port}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ searches: [{ type: "lex", query: "unicorn" }], rerank: false }) });
    expect(lexical.status).toBe(200);
    expect(await lexical.text()).toContain("deploy.md");
    expect(requests).toHaveLength(lexicalStart);
  }, 60_000);

  test("a shared HTTP MCP server resumes reranking after its backend recovers", async () => {
    let unavailable = false;
    let rerankRequests = 0;
    const backend = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      rerankRequests++;
      res.setHeader("content-type", "application/json");
      if (unavailable) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary outage" }));
      } else {
        res.end(JSON.stringify({ results: body.documents.map((_: unknown, index: number) => ({ index, relevance_score: 0.95 })) }));
      }
    });
    servers.push(backend);
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address();
    if (!address || typeof address === "string") throw new Error("missing loopback address");
    const { root, configPath } = await fixture({
      rerank_api_url: `http://127.0.0.1:${address.port}/v1/rerank`,
      rerank_api_model: "test-rerank",
    });
    setConfigSource({ configPath });
    const mcp = await startMcpHttpServer(0, { dbPath: join(root, "index.sqlite"), quiet: true });
    mcpServers.push(mcp);

    const query = async (context: string) => {
      const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "query" },
        body: JSON.stringify({ jsonrpc: "2.0", id: context, method: "tools/call", params: {
          name: "query", arguments: {
            searches: [{ type: "lex", query: "unicorn" }],
            rerankContext: context, rerank: true,
          },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "recovery-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} },
        } }),
      });
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };

    const initial = await query("baseline");
    expect(initial.result?.isError).not.toBe(true);
    expect(JSON.stringify(initial)).toContain("deploy.md");
    expect(rerankRequests).toBe(1);

    unavailable = true;
    const failed = await query("outage");
    expect(failed.result?.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("503");
    expect(rerankRequests).toBe(2);

    unavailable = false;
    const recovered = await query("recovered");
    expect(recovered.result?.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(JSON.stringify(recovered)).toContain("deploy.md");
    expect(rerankRequests).toBe(3);
  });
});
