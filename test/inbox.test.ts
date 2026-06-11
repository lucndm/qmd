/**
 * inbox.test.ts - Tests for the Inbox & Upload feature
 *
 * Covers: getInboxDir, ensureInboxCollection, listInboxFiles,
 *         ingestFile, moveInboxFile, MCP tools, REST endpoints
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import type { Database } from "../src/db.js";
import { unlinkSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, writeFile, readdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../src/collections.js";
import { setConfigIndexName, syncConfigToDb } from "../src/collections.js";
import { OpenAILLM, type OpenAILLMConfig } from "../src/llm-openai.js";
import {
  createStore,
  ensureInboxCollection,
  listInboxFiles,
  ingestFile,
  moveInboxFile,
  upsertStoreCollection,
  reindexCollection,
  type Store,
} from "../src/store.js";
import { getInboxDir, qmdHomedir } from "../src/paths.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

let testDir: string;
let testDbPath: string;
let testConfigDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-inbox-test-"));
});

afterAll(async () => {
  try {
    const files = await readdir(testDir);
    for (const f of files) await unlink(join(testDir, f));
    await rmdir(testDir);
  } catch {}
});

function createTestStore(): Store {
  testDbPath = join(testDir, `inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const store = createStore(testDbPath);

  if (process.env.QMD_LLM_BACKEND === "api") {
    const apiConfig: OpenAILLMConfig = {
      baseUrl: process.env.QMD_API_BASE_URL || "https://z.minhluc.info/",
      apiKey: process.env.QMD_API_KEY,
      embedModel: process.env.QMD_EMBED_MODEL,
      generateModel: process.env.QMD_GENERATE_MODEL,
      rerankModel: process.env.QMD_RERANK_MODEL,
    };
    store.llm = new OpenAILLM(apiConfig);
  }

  return store;
}

function cleanupStore(store: Store) {
  store.close();
  try { unlinkSync(store.dbPath); } catch {}
}

function addCollection(db: Database, name: string, path: string, pattern = "**/*.{md,txt}") {
  upsertStoreCollection(db, name, { path, pattern, includeByDefault: true });
}

function createFakeLlm() {
  return {
    async tokenize(text: string) {
      return new Array(Math.max(1, Math.ceil(text.length / 3))).fill(1);
    },
    async embed(text: string) {
      return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
    },
    async embedBatch(texts: string[]) {
      return texts.map((_t, i) => ({ embedding: [i + 1, i + 2, i + 3], model: "fake-embed" }));
    },
    embedModelName: "fake-embed",
  };
}

// =============================================================================
// 1. getInboxDir (paths.ts)
// =============================================================================

describe("getInboxDir", () => {
  test("returns ~/.cache/qmd/inbox/ by default", () => {
    const origXdg = process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CACHE_HOME;
    const dir = getInboxDir();
    expect(dir).toBe(resolve(qmdHomedir(), ".cache", "qmd", "inbox"));
    if (origXdg) process.env.XDG_CACHE_HOME = origXdg;
  });

  test("creates directory if missing", () => {
    const dir = getInboxDir();
    expect(existsSync(dir)).toBe(true);
  });

  test("respects XDG_CACHE_HOME", () => {
    const origXdg = process.env.XDG_CACHE_HOME;
    const tmpXdg = join(testDir, "xdg-cache");
    mkdirSync(tmpXdg, { recursive: true });
    process.env.XDG_CACHE_HOME = tmpXdg;
    const dir = getInboxDir();
    expect(dir).toBe(resolve(tmpXdg, "qmd", "inbox"));
    expect(existsSync(dir)).toBe(true);
    if (origXdg) process.env.XDG_CACHE_HOME = origXdg;
    else delete process.env.XDG_CACHE_HOME;
  });
});

// =============================================================================
// 2. ensureInboxCollection & listInboxFiles (store.ts)
// =============================================================================

describe("ensureInboxCollection", () => {
  test("creates inbox collection on first call", () => {
    const store = createTestStore();
    ensureInboxCollection(store.db);
    const row = store.db.prepare(`SELECT name, path FROM store_collections WHERE name = ?`).get("inbox") as { name: string; path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("inbox");
    expect(row!.path).toBe(getInboxDir());
    cleanupStore(store);
  });

  test("is idempotent — no duplicate on second call", () => {
    const store = createTestStore();
    ensureInboxCollection(store.db);
    ensureInboxCollection(store.db);
    const rows = store.db.prepare(`SELECT COUNT(*) as cnt FROM store_collections WHERE name = ?`).get("inbox") as { cnt: number };
    expect(rows.cnt).toBe(1);
    cleanupStore(store);
  });
});

describe("listInboxFiles", () => {
  test("returns empty array when inbox is empty", () => {
    const dir = getInboxDir();
    const files = readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    for (const f of files) unlinkSync(join(dir, f));
    expect(listInboxFiles()).toEqual([]);
  });

  test("returns .md and .txt files", () => {
    const dir = getInboxDir();
    writeFileSync(join(dir, "test-a.md"), "# A");
    writeFileSync(join(dir, "test-b.txt"), "B");
    writeFileSync(join(dir, "test-c.json"), "{}");
    const files = listInboxFiles();
    expect(files).toContain("test-a.md");
    expect(files).toContain("test-b.txt");
    expect(files).not.toContain("test-c.json");
    unlinkSync(join(dir, "test-a.md"));
    unlinkSync(join(dir, "test-b.txt"));
    unlinkSync(join(dir, "test-c.json"));
  });
});

// =============================================================================
// 3. ingestFile (store.ts)
// =============================================================================

describe("ingestFile", () => {
  test("uploads .md to inbox (no collection)", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const result = await ingestFile(store, "# Hello World", "hello.md");
    expect(result.collection).toBe("inbox");
    expect(result.file).toBe("hello.md");
    expect(result.docid).toMatch(/^#[0-9a-f]{6}$/);
    expect(existsSync(result.filepath)).toBe(true);
    unlinkSync(result.filepath);
    cleanupStore(store);
  });

  test("uploads .txt to inbox", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const result = await ingestFile(store, "Plain text note", "note.txt");
    expect(result.collection).toBe("inbox");
    expect(result.file).toBe("note.txt");
    expect(existsSync(result.filepath)).toBe(true);
    unlinkSync(result.filepath);
    cleanupStore(store);
  });

  test("uploads to a specific collection", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "mydocs");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "mydocs", collDir);
    const result = await ingestFile(store, "# Doc", "doc.md", { collection: "mydocs" });
    expect(result.collection).toBe("mydocs");
    expect(result.filepath).toContain(collDir);
    expect(existsSync(result.filepath)).toBe(true);
    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("uploads with subpath — creates subdirectory", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "journal");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "journal", collDir);
    const result = await ingestFile(store, "# Day 1", "day1.md", { collection: "journal", path: "2024/01" });
    expect(result.filepath).toContain(join("journal", "2024", "01"));
    expect(existsSync(result.filepath)).toBe(true);
    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("sanitizes filename with path separators", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const result = await ingestFile(store, "Content", "path/to/file.md");
    expect(result.file).toBe("path_to_file.md");
    unlinkSync(result.filepath);
    cleanupStore(store);
  });

  test("sanitizes filename with backslash", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const result = await ingestFile(store, "Content", "path\\to\\file.md");
    expect(result.file).toBe("path_to_file.md");
    unlinkSync(result.filepath);
    cleanupStore(store);
  });

  test("throws on unsupported extension", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    await expect(ingestFile(store, "data", "file.json")).rejects.toThrow("Unsupported file type");
    cleanupStore(store);
  });

  test("throws on collection not found", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    await expect(ingestFile(store, "doc", "doc.md", { collection: "nonexistent" })).rejects.toThrow("not found");
    cleanupStore(store);
  });

  test("deduplicates filename when file exists", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const r1 = await ingestFile(store, "first", "dup.md");
    const r2 = await ingestFile(store, "second", "dup.md");
    expect(r1.file).toBe("dup.md");
    expect(r2.file).not.toBe("dup.md");
    expect(r2.file).toMatch(/^dup-\d+\.md$/);
    unlinkSync(r1.filepath);
    unlinkSync(r2.filepath);
    cleanupStore(store);
  });

  test("returns correct IngestResult shape", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const result = await ingestFile(store, "# Shape", "shape.md");
    expect(result).toHaveProperty("docid");
    expect(result).toHaveProperty("file");
    expect(result).toHaveProperty("collection");
    expect(result).toHaveProperty("filepath");
    expect(typeof result.docid).toBe("string");
    expect(typeof result.file).toBe("string");
    expect(typeof result.collection).toBe("string");
    expect(typeof result.filepath).toBe("string");
    unlinkSync(result.filepath);
    cleanupStore(store);
  });

  test("file is FTS searchable after ingest", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    await ingestFile(store, "# UniqueZebraDocument\n\nThis is about zebras.", "zebra.md");
    const results = store.searchFTS("UniqueZebraDocument", 10, "inbox");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.displayPath).toContain("zebra.md");
    const inboxDir = getInboxDir();
    const files = readdirSync(inboxDir).filter(f => f.includes("zebra"));
    for (const f of files) unlinkSync(join(inboxDir, f));
    cleanupStore(store);
  });
});

// =============================================================================
// 4. moveInboxFile (store.ts)
// =============================================================================

describe("moveInboxFile", () => {
  test("moves file from inbox to collection", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "archive");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "archive", collDir);

    const ingested = await ingestFile(store, "# Movable", "movable.md");
    expect(existsSync(ingested.filepath)).toBe(true);

    const moved = await moveInboxFile(store, "movable.md", "archive");
    expect(moved.from).toBe("inbox");
    expect(moved.file).toBe("movable.md");
    expect(existsSync(join(collDir, "movable.md"))).toBe(true);
    expect(existsSync(ingested.filepath)).toBe(false);

    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("moves with targetPath subdirectory", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "target-sub");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "target-sub", collDir);

    await ingestFile(store, "Sub doc", "subdoc.md");
    const moved = await moveInboxFile(store, "subdoc.md", "target-sub", "nested/dir");
    const expectedFile = join(collDir, "nested", "dir", "subdoc.md");
    expect(existsSync(expectedFile)).toBe(true);

    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("throws when file not found in inbox", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "col-missing");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "col-missing", collDir);
    await expect(moveInboxFile(store, "nonexistent.md", "col-missing")).rejects.toThrow("not found");
    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("throws when target collection not found", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    await ingestFile(store, "Orphan", "orphan.md");
    await expect(moveInboxFile(store, "orphan.md", "no-such-collection")).rejects.toThrow("not found");
    const inboxDir = getInboxDir();
    const files = readdirSync(inboxDir).filter(f => f.includes("orphan"));
    for (const f of files) unlinkSync(join(inboxDir, f));
    cleanupStore(store);
  });

  test("deduplicates destination filename", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "dedup-target");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "dedup-target", collDir);

    writeFileSync(join(collDir, "dedup.md"), "# existing");

    await ingestFile(store, "# incoming", "dedup.md");
    const moved = await moveInboxFile(store, "dedup.md", "dedup-target");
    const collFiles = readdirSync(collDir).filter(f => f.startsWith("dedup"));
    expect(collFiles.length).toBe(2);
    expect(collFiles).toContain("dedup.md");
    expect(collFiles.find(f => f !== "dedup.md")).toMatch(/^dedup-\d+\.md$/);

    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("reindexes both inbox and target collection", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "reindex-col");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "reindex-col", collDir);

    await ingestFile(store, "# ReindexDoc\n\nAlpha beta gamma.", "reindexdoc.md");

    let inboxResults = store.searchFTS("ReindexDoc", 10, "inbox");
    expect(inboxResults.length).toBeGreaterThanOrEqual(1);

    await moveInboxFile(store, "reindexdoc.md", "reindex-col");

    inboxResults = store.searchFTS("ReindexDoc", 10, "inbox");
    expect(inboxResults.length).toBe(0);

    const collResults = store.searchFTS("ReindexDoc", 10, "reindex-col");
    expect(collResults.length).toBeGreaterThanOrEqual(1);

    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("returns correct result shape", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "shape-col");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "shape-col", collDir);

    await ingestFile(store, "Shape move", "shapemove.md");
    const result = await moveInboxFile(store, "shapemove.md", "shape-col");
    expect(result).toHaveProperty("from", "inbox");
    expect(result).toHaveProperty("to");
    expect(result).toHaveProperty("file", "shapemove.md");

    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });

  test("handles cross-device move via copy+delete fallback", async () => {
    const store = createTestStore();
    store.llm = createFakeLlm() as any;
    const collDir = join(testDir, "xdev-col");
    mkdirSync(collDir, { recursive: true });
    addCollection(store.db, "xdev-col", collDir);

    await ingestFile(store, "# CrossDevice", "xdev.md");

    const fsRename = vi.spyOn(require("node:fs"), "renameSync").mockImplementationOnce(() => {
      const err = new Error("EXDEV cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });

    const result = await moveInboxFile(store, "xdev.md", "xdev-col");
    expect(result.file).toBe("xdev.md");
    expect(existsSync(join(collDir, "xdev.md"))).toBe(true);

    fsRename.mockRestore();
    rmSync(collDir, { recursive: true, force: true });
    cleanupStore(store);
  });
});

// =============================================================================
// 5. MCP HTTP endpoint tests (upload, inbox, inbox/move)
// =============================================================================

describe.skipIf(!!process.env.CI)("Inbox REST endpoints", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let httpTestDbPath: string;
  let httpTestConfigDir: string;
  let httpTestCollDir: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  beforeAll(async () => {
    httpTestDbPath = join(testDir, `http-inbox-${Date.now()}.sqlite`);
    const store = createStore(httpTestDbPath);
    store.close();

    httpTestCollDir = join(testDir, `http-coll-${Date.now()}`);
    mkdirSync(httpTestCollDir, { recursive: true });

    const httpTestConfig: CollectionConfig = {
      collections: {
        testcol: {
          path: httpTestCollDir,
          pattern: "**/*.{md,txt}",
        },
      },
    };

    const configPrefix = join(tmpdir(), `qmd-inbox-http-config-${Date.now()}`);
    httpTestConfigDir = await mkdtemp(configPrefix);
    await writeFile(join(httpTestConfigDir, "index.yml"), YAML.stringify(httpTestConfig));

    process.env.INDEX_PATH = httpTestDbPath;
    process.env.QMD_CONFIG_DIR = httpTestConfigDir;

    handle = await startMcpHttpServer(0, { quiet: true });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.QMD_CONFIG_DIR = origConfigDir;
    else delete process.env.QMD_CONFIG_DIR;
    try { unlinkSync(httpTestDbPath); } catch {}
    try { rmSync(httpTestCollDir, { recursive: true, force: true }); } catch {}
    try {
      const files = await readdir(httpTestConfigDir);
      for (const f of files) await unlink(join(httpTestConfigDir, f));
      await rmdir(httpTestConfigDir);
    } catch {}
  });

  test("POST /upload — upload to inbox", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Uploaded via API", filename: "api-upload.md" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.collection).toBe("inbox");
    expect(body.file).toBe("api-upload.md");
    expect(body.docid).toMatch(/^#[0-9a-f]{6}$/);
  }, 30000);

  test("POST /upload — upload to specific collection", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# To collection", filename: "to-col.md", collection: "testcol" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.collection).toBe("testcol");
  }, 30000);

  test("POST /upload — missing content returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "no-content.md" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /upload — missing filename returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "text" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /upload — unsupported extension returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "data", filename: "file.json" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /upload — nonexistent collection returns error", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "text", filename: "doc.md", collection: "nope" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  }, 30000);

  test("GET /inbox — returns file list", async () => {
    const res = await fetch(`${baseUrl}/inbox`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.files)).toBe(true);
  });

  test("POST /inbox/move — moves file from inbox to collection", async () => {
    await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Move me", filename: "move-rest.md" }),
    });

    const res = await fetch(`${baseUrl}/inbox/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "move-rest.md", collection: "testcol" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.file).toBe("move-rest.md");
  }, 30000);

  test("POST /inbox/move — missing fields returns 400", async () => {
    const res = await fetch(`${baseUrl}/inbox/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "x.md" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /inbox/move — nonexistent file returns 404", async () => {
    const res = await fetch(`${baseUrl}/inbox/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "ghost.md", collection: "testcol" }),
    });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 6. MCP tool tests (via MCP protocol)
// =============================================================================

describe.skipIf(!!process.env.CI)("Inbox MCP tools", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let httpTestDbPath: string;
  let httpTestConfigDir: string;
  let httpTestCollDir: string;
  let sessionId: string | null = null;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  async function mcpRequest(body: object): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const json = await res.json();
    return { status: res.status, json };
  }

  beforeAll(async () => {
    httpTestDbPath = join(testDir, `mcp-inbox-${Date.now()}.sqlite`);
    const store = createStore(httpTestDbPath);
    store.close();

    httpTestCollDir = join(testDir, `mcp-coll-${Date.now()}`);
    mkdirSync(httpTestCollDir, { recursive: true });

    const httpTestConfig: CollectionConfig = {
      collections: {
        mcpcol: {
          path: httpTestCollDir,
          pattern: "**/*.{md,txt}",
        },
      },
    };

    const configPrefix = join(tmpdir(), `qmd-inbox-mcp-config-${Date.now()}`);
    httpTestConfigDir = await mkdtemp(configPrefix);
    await writeFile(join(httpTestConfigDir, "index.yml"), YAML.stringify(httpTestConfig));

    process.env.INDEX_PATH = httpTestDbPath;
    process.env.QMD_CONFIG_DIR = httpTestConfigDir;

    handle = await startMcpHttpServer(0, { quiet: true });
    baseUrl = `http://localhost:${handle.port}`;

    await mcpRequest({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
  });

  afterAll(async () => {
    await handle.stop();
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.QMD_CONFIG_DIR = origConfigDir;
    else delete process.env.QMD_CONFIG_DIR;
    try { unlinkSync(httpTestDbPath); } catch {}
    try { rmSync(httpTestCollDir, { recursive: true, force: true }); } catch {}
    try {
      const files = await readdir(httpTestConfigDir);
      for (const f of files) await unlink(join(httpTestConfigDir, f));
      await rmdir(httpTestConfigDir);
    } catch {}
  });

  test("upload tool — success to inbox", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "# MCP Upload", filename: "mcp-upload.md" },
      },
    });
    const text = json.result.content[0].text;
    expect(text).toContain("inbox");
    expect(text).toContain("mcp-upload.md");
    expect(json.result.structuredContent.collection).toBe("inbox");
  }, 30000);

  test("upload tool — success to collection", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "# To mcpcol", filename: "to-mcpcol.md", collection: "mcpcol" },
      },
    });
    const text = json.result.content[0].text;
    expect(text).toContain("mcpcol");
    expect(json.result.structuredContent.collection).toBe("mcpcol");
  }, 30000);

  test("upload tool — invalid extension returns error", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "data", filename: "file.py" },
      },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("Unsupported");
  });

  test("upload tool — nonexistent collection returns error", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "x", filename: "f.md", collection: "nope" },
      },
    });
    expect(json.result.isError).toBe(true);
  });

  test("upload tool — returns structuredContent", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "structured", filename: "struct.md" },
      },
    });
    const sc = json.result.structuredContent;
    expect(sc).toHaveProperty("docid");
    expect(sc).toHaveProperty("file");
    expect(sc).toHaveProperty("collection");
    expect(sc).toHaveProperty("filepath");
  }, 30000);

  test("inbox_list tool — returns files", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "inbox_list", arguments: {} },
    });
    const text = json.result.content[0].text;
    expect(text).toContain("Inbox");
    expect(json.result.structuredContent).toHaveProperty("files");
  });

  test("inbox_list tool — empty inbox", async () => {
    const inboxDir = getInboxDir();
    const files = readdirSync(inboxDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    for (const f of files) unlinkSync(join(inboxDir, f));

    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "inbox_list", arguments: {} },
    });
    expect(json.result.content[0].text).toBe("Inbox is empty.");
  });

  test("inbox_move tool — success", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "# Move me via MCP", filename: "mcp-move.md" },
      },
    });

    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: {
        name: "inbox_move",
        arguments: { file: "mcp-move.md", collection: "mcpcol" },
      },
    });
    const text = json.result.content[0].text;
    expect(text).toContain("Moved");
    expect(json.result.structuredContent.file).toBe("mcp-move.md");
  }, 30000);

  test("inbox_move tool — file not found returns error", async () => {
    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: {
        name: "inbox_move",
        arguments: { file: "phantom.md", collection: "mcpcol" },
      },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("Move failed");
  });

  test("inbox_move tool — collection not found returns error", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: {
        name: "upload",
        arguments: { content: "x", filename: "err.md" },
      },
    });

    const { json } = await mcpRequest({
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: {
        name: "inbox_move",
        arguments: { file: "err.md", collection: "nonexistent" },
      },
    });
    expect(json.result.isError).toBe(true);
  }, 30000);
});
