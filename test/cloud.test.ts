import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import type { Database } from "../src/db.js";
import {
  loadCloudConfig,
  saveCloudConfig,
  getRemote,
  resolveRemoteName,
  getCloudConfigPath,
  type CloudConfig,
} from "../src/cloud/config.js";

let testDir: string;
let originalConfigDir: string | undefined;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-cloud-test-"));
  originalConfigDir = process.env.QMD_CONFIG_DIR;
  process.env.QMD_CONFIG_DIR = testDir;
});

afterAll(async () => {
  process.env.QMD_CONFIG_DIR = originalConfigDir;
  await rm(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  const configPath = join(testDir, "cloud.yml");
  if (existsSync(configPath)) {
    const { unlinkSync } = require("node:fs");
    unlinkSync(configPath);
  }
});

describe("cloud config", () => {
  test("loadCloudConfig returns null when no config file", () => {
    expect(loadCloudConfig()).toBeNull();
  });

  test("saveCloudConfig creates config file", () => {
    const config: CloudConfig = {
      default_remote: "default",
      remotes: {
        default: {
          url: "libsql://test.turso.io",
          token: "test-token-123",
        },
      },
    };
    saveCloudConfig(config);

    const loaded = loadCloudConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.default_remote).toBe("default");
    expect(loaded!.remotes.default.url).toBe("libsql://test.turso.io");
    expect(loaded!.remotes.default.token).toBe("test-token-123");
  });

  test("saveCloudConfig creates parent directory if missing", () => {
    const nestedDir = join(testDir, "nested", "deep");
    process.env.QMD_CONFIG_DIR = nestedDir;

    const config: CloudConfig = {
      default_remote: "myremote",
      remotes: {
        myremote: { url: "libsql://x.turso.io", token: "tok" },
      },
    };
    saveCloudConfig(config);
    expect(existsSync(join(nestedDir, "cloud.yml"))).toBe(true);

    process.env.QMD_CONFIG_DIR = testDir;
  });

  test("loadCloudConfig handles malformed YAML", async () => {
    await writeFile(join(testDir, "cloud.yml"), "not: valid: yaml: [[[");
    expect(loadCloudConfig()).toBeNull();
  });

  test("loadCloudConfig handles empty file", async () => {
    await writeFile(join(testDir, "cloud.yml"), "");
    expect(loadCloudConfig()).toBeNull();
  });

  test("saveCloudConfig overwrites existing config", () => {
    const config1: CloudConfig = {
      default_remote: "a",
      remotes: { a: { url: "libsql://a.turso.io", token: "t1" } },
    };
    saveCloudConfig(config1);

    const config2: CloudConfig = {
      default_remote: "b",
      remotes: {
        b: { url: "libsql://b.turso.io", token: "t2" },
        c: { url: "libsql://c.turso.io", token: "t3" },
      },
    };
    saveCloudConfig(config2);

    const loaded = loadCloudConfig();
    expect(Object.keys(loaded!.remotes)).toEqual(["b", "c"]);
    expect(loaded!.default_remote).toBe("b");
  });

  test("multiple remotes preserved in YAML round-trip", () => {
    const config: CloudConfig = {
      default_remote: "personal",
      remotes: {
        personal: { url: "libsql://personal.turso.io", token: "p-token" },
        team: { url: "libsql://team.turso.io", token: "t-token" },
      },
    };
    saveCloudConfig(config);

    const raw = YAML.parse(require("node:fs").readFileSync(join(testDir, "cloud.yml"), "utf-8"));
    expect(Object.keys(raw.remotes)).toEqual(["personal", "team"]);
  });
});

describe("getRemote", () => {
  test("returns null when no config", () => {
    expect(getRemote()).toBeNull();
    expect(getRemote("default")).toBeNull();
  });

  test("returns default remote", () => {
    saveCloudConfig({
      default_remote: "default",
      remotes: { default: { url: "libsql://a.turso.io", token: "tok" } },
    });
    const remote = getRemote();
    expect(remote).not.toBeNull();
    expect(remote!.url).toBe("libsql://a.turso.io");
  });

  test("returns named remote", () => {
    saveCloudConfig({
      default_remote: "a",
      remotes: {
        a: { url: "libsql://a.turso.io", token: "t1" },
        b: { url: "libsql://b.turso.io", token: "t2" },
      },
    });
    const remote = getRemote("b");
    expect(remote).not.toBeNull();
    expect(remote!.url).toBe("libsql://b.turso.io");
  });

  test("returns null for non-existent remote", () => {
    saveCloudConfig({
      default_remote: "default",
      remotes: { default: { url: "libsql://a.turso.io", token: "tok" } },
    });
    expect(getRemote("nonexistent")).toBeNull();
  });
});

describe("resolveRemoteName", () => {
  test("returns provided name when given", () => {
    saveCloudConfig({
      default_remote: "default",
      remotes: { default: { url: "libsql://a.turso.io", token: "tok" } },
    });
    expect(resolveRemoteName("myremote")).toBe("myremote");
  });

  test("returns default remote name when no name given", () => {
    saveCloudConfig({
      default_remote: "personal",
      remotes: { personal: { url: "libsql://a.turso.io", token: "tok" } },
    });
    expect(resolveRemoteName()).toBe("personal");
  });

  test("returns 'default' when no config", () => {
    expect(resolveRemoteName()).toBe("default");
  });
});

describe("validateConnection (mocked)", () => {
  test("returns ok with server info on success", async () => {
    const { validateConnection } = await import("../src/cloud/client.js");
    const result = await validateConnection({
      url: "libsql://qmd-minhlucnd.aws-ap-northeast-1.turso.io",
      token: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJnWFFiY21WYUVmR2c3SElfblp6TUV3Iiwib3JnX2lkIjoxMDAwMTgwMzkwfQ.ZdjtcXdfeNygeKHs_yNX47D_pEkjDBvTuIZMHo3SjrB9QXi_VBGpmNB_oc51lGupzxPzmcgT4ZfY43vP-EyMCQ",
    });

    if (process.env.CI) {
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(true);
      expect(result.serverInfo).toContain("SQLite");
    }
  });

  test("returns error on bad token", async () => {
    const { validateConnection } = await import("../src/cloud/client.js");
    const result = await validateConnection({
      url: "libsql://nonexistent.turso.io",
      token: "bad-token",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// =============================================================================
// Push tests (mocked Turso client)
// =============================================================================

describe("push — schema detection", () => {
  let testDir: string;
  let db: Database;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-push-schema-"));
    db = openDatabase(join(testDir, "test.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    try { loadSqliteVec(db); } catch { /* vec may not load in test */ }
    db.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61')`);
  });

  afterAll(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  test("detects regular tables", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'documents_fts_%'").all()) as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("content");
    expect(names).toContain("documents");
    expect(names).toContain("store_config");
    expect(names).toContain("documents_fts");
  });

  test("FTS internal tables excluded", () => {
    const allTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) as { name: string }[];
    const internalFts = allTables.filter(t => t.name.startsWith("documents_fts_"));
    expect(internalFts.length).toBeGreaterThan(0);
    const filtered = allTables.filter(t => !t.name.startsWith("documents_fts_"));
    expect(filtered.find(t => t.name === "documents_fts")).toBeTruthy();
  });
});

describe("push — ensureIfNotExists", () => {
  test("adds IF NOT EXISTS to CREATE TABLE", async () => {
    const mod = await import("../src/cloud/push.js");
    const fn = (mod as any).ensureIfNotExists as (ddl: string) => string;
    expect(fn("CREATE TABLE content (hash TEXT PRIMARY KEY)")).toBe(
      "CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY)"
    );
  });

  test("preserves existing IF NOT EXISTS", async () => {
    const mod = await import("../src/cloud/push.js");
    const fn = (mod as any).ensureIfNotExists as (ddl: string) => string;
    expect(fn("CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY)")).toBe(
      "CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY)"
    );
  });
});

describe("push — pushToRemote with mock client", () => {
  let testDir: string;
  let db: Database;
  let executed: { sql: string; args?: unknown[] }[];
  let batched: { sql: string; args?: unknown[] }[][];

  function createMockClient() {
    executed = [];
    batched = [];
    return {
      async execute(sql: string, args?: unknown[]) {
        executed.push({ sql, args });
        return { rows: [] };
      },
      async batch(stmts: { sql: string; args?: unknown[] }[]) {
        batched.push(stmts);
        return stmts.map(() => ({ rows: [] }));
      },
      close() {},
    };
  }

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-push-mock-"));
    db = openDatabase(join(testDir, "test.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    try { loadSqliteVec(db); } catch {}

    db.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS store_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL DEFAULT '**/*.md')`);
    db.exec(`CREATE TABLE IF NOT EXISTS content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, PRIMARY KEY (hash, seq))`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61')`);

    const insert = db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)");
    const insertDoc = db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 5; i++) {
      const hash = `hash${i}`;
      insert.run(hash, `document content ${i}`, "2026-01-01");
      insertDoc.run("test", `doc${i}.md`, `Doc ${i}`, hash, "2026-01-01", "2026-01-01");
    }
    db.prepare("INSERT INTO store_config (key, value) VALUES (?, ?)").run("config_hash", "abc");
  });

  afterAll(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  test("push creates remote schema", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client = createMockClient();
    await pushToRemote(db, client as any);

    const createStmts = executed.map(e => e.sql).filter(s => s.startsWith("CREATE"));
    expect(createStmts.length).toBeGreaterThan(0);
    expect(createStmts.some(s => s.includes("content"))).toBe(true);
    expect(createStmts.some(s => s.includes("documents"))).toBe(true);
  });

  test("push uploads data via batch", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client = createMockClient();
    const result = await pushToRemote(db, client as any);

    expect(result.tables.content.rows).toBe(5);
    expect(result.tables.documents.rows).toBe(5);
    expect(result.tables.store_config.rows).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("push records last_push timestamp", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client = createMockClient();
    await pushToRemote(db, client as any);

    const pushStmt = executed.find(e => e.sql.includes("store_config") && e.sql.includes("INSERT"));
    expect(pushStmt).toBeTruthy();
    expect(pushStmt!.args?.[0]).toBe("last_push");
    expect(typeof pushStmt!.args?.[1]).toBe("string");
  });

  test("push deletes remote data before inserting", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client = createMockClient();
    await pushToRemote(db, client as any);

    const deleteStmts = executed.filter(e => e.sql.startsWith("DELETE"));
    expect(deleteStmts.length).toBeGreaterThan(0);
    expect(deleteStmts.some(e => e.sql.includes("content"))).toBe(true);
  });

  test("push is idempotent", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client1 = createMockClient();
    const client2 = createMockClient();
    const r1 = await pushToRemote(db, client1 as any);
    const r2 = await pushToRemote(db, client2 as any);

    expect(r1.tables.content.rows).toBe(r2.tables.content.rows);
    expect(r1.tables.documents.rows).toBe(r2.tables.documents.rows);
  });

  test("batch contains correct column values", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const client = createMockClient();
    await pushToRemote(db, client as any);

    const contentBatch = batched.find(b => b[0]?.sql.includes("content"));
    expect(contentBatch).toBeTruthy();
    expect(contentBatch!.length).toBe(5);
    const firstRow = contentBatch![0];
    expect(firstRow.args?.[0]).toBe("hash0");
    expect(firstRow.args?.[1]).toBe("document content 0");
  });
});

describe("push — vec0 table with mock", () => {
  let testDir: string;
  let db: Database;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-push-vec-"));
    db = openDatabase(join(testDir, "test.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    try { loadSqliteVec(db); } catch {}

    db.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61')`);

    db.exec(`CREATE TABLE IF NOT EXISTS content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, PRIMARY KEY (hash, seq))`);
    try {
      db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[8] distance_metric=cosine)`);
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      const hash = "testhash";
      db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)").run(hash, "test", "2026-01-01");
      db.prepare("INSERT INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)").run("test", "t.md", "T", hash, "2026-01-01", "2026-01-01");
      db.prepare("INSERT INTO content_vectors (hash, seq, model) VALUES (?, ?, ?)").run(hash, 0, "test-model");
      db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(`${hash}_0`, embedding);
    } catch {
      // vec0 not available, skip vec tests
    }
  });

  afterAll(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  test("vec0 table detected in schema", () => {
    const vecTables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'").all() as { name: string; sql: string }[];
    if (vecTables.length === 0) return;
    expect(vecTables[0].name).toBe("vectors_vec");
    expect(vecTables[0].sql).toContain("float[8]");
  });

  test("vec0 data pushed as FLOAT32 with vector32()", async () => {
    const vecCheck = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'").get() as { cnt: number };
    if (vecCheck.cnt === 0) return;

    const { pushToRemote } = await import("../src/cloud/push.js");
    const batched: { sql: string; args?: unknown[] }[][] = [];
    const executed: { sql: string; args?: unknown[] }[] = [];
    const client = {
      async execute(sql: string, args?: unknown[]) {
        executed.push({ sql, args });
        return { rows: [] };
      },
      async batch(stmts: { sql: string; args?: unknown[] }[]) {
        batched.push(stmts);
        return stmts.map(() => ({ rows: [] }));
      },
      close() {},
    };

    await pushToRemote(db, client as any);

    const vecCreate = executed.find(e => e.sql.includes("FLOAT32"));
    expect(vecCreate).toBeTruthy();
    expect(vecCreate!.sql).toContain("FLOAT32(8)");

    const vecBatch = batched.find(b => b[0]?.sql.includes("vector32"));
    expect(vecBatch).toBeTruthy();
    expect(vecBatch![0].args?.[0]).toBe("testhash_0");
    const embeddingArg = vecBatch![0].args?.[1] as string;
    expect(embeddingArg).toContain("0.1");
    expect(embeddingArg).toContain("0.8");
    expect(embeddingArg.startsWith("[")).toBe(true);
    expect(embeddingArg.endsWith("]")).toBe(true);
  });
});

describe("push — empty database", () => {
  let testDir: string;
  let db: Database;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-push-empty-"));
    db = openDatabase(join(testDir, "test.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(filepath, title, body)`);
  });

  afterAll(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  test("push handles empty tables", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const executed: { sql: string; args?: unknown[] }[] = [];
    const client = {
      async execute(sql: string, args?: unknown[]) {
        executed.push({ sql, args });
        return { rows: [] };
      },
      async batch(stmts: { sql: string; args?: unknown[] }[]) {
        return stmts.map(() => ({ rows: [] }));
      },
      close() {},
    };

    const result = await pushToRemote(db, client as any);
    expect(result.tables.content.rows).toBe(0);
    expect(result.tables.documents.rows).toBe(0);

    const deleteStmts = executed.filter(e => e.sql.startsWith("DELETE"));
    expect(deleteStmts.length).toBe(0);
  });
});

// =============================================================================
// Pull tests (mocked Turso client simulating remote data)
// =============================================================================

function createMockPullClient(remoteData: {
  schema: { name: string; type: string; sql: string }[];
  tables: Record<string, Record<string, unknown>[]>;
  storeConfig?: Record<string, string>;
}) {
  return {
    async execute(sql: string, args?: unknown[]) {
      const lc = sql.trim().toLowerCase();

      if (lc.startsWith("select name, type, sql from sqlite_master")) {
        return { rows: remoteData.schema.map(s => ({ name: s.name, type: s.type, sql: s.sql })) };
      }
      if (lc.startsWith("pragma table_info")) {
        const match = sql.match(/table_info\("([^"]+)"\)/);
        const tableName = match?.[1];
        const sampleRow = tableName && remoteData.tables[tableName]?.[0];
        if (sampleRow) {
          return { rows: Object.keys(sampleRow).map(k => ({ name: k })) };
        }
        return { rows: [] };
      }
      if (lc.includes("count(*)")) {
        const match = sql.match(/from\s+(\w+)/i);
        const tableName = match?.[1];
        const cnt = tableName ? (remoteData.tables[tableName]?.length ?? 0) : 0;
        return { rows: [{ cnt }] };
      }
      if (lc.includes("select") && lc.includes("from") && !lc.includes("sqlite_master")) {
        const match = sql.match(/from\s+(\w+)/i);
        const tableName = match?.[1];
        const rows = tableName ? (remoteData.tables[tableName] ?? []) : [];
        const limitMatch = sql.match(/limit\s+(\d+)\s+offset\s+(\d+)/i);
        if (limitMatch) {
          const limit = parseInt(limitMatch[1]);
          const offset = parseInt(limitMatch[2]);
          const colsMatch = sql.match(/select\s+(.+?)\s+from/i);
          const cols = colsMatch?.[1]?.split(",").map(c => c.trim()) ?? Object.keys(rows[0] ?? {});
          return { rows: rows.slice(offset, offset + limit).map(r => {
            const filtered: Record<string, unknown> = {};
            for (const c of cols) { filtered[c] = r[c]; }
            return filtered;
          })};
        }
        return { rows };
      }
      return { rows: [] };
    },
    async batch(stmts: { sql: string; args?: unknown[] }[]) {
      return stmts.map(() => ({ rows: [] }));
    },
    close() {},
  };
}

describe("pull — basic pull with mock client", () => {
  let testDir: string;
  let localDbPath: string;

  const remoteSchema = [
    { name: "content", type: "table", sql: "CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)" },
    { name: "documents", type: "table", sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT, path TEXT, title TEXT, hash TEXT, created_at TEXT, modified_at TEXT, active INTEGER DEFAULT 1)" },
    { name: "store_config", type: "table", sql: "CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT)" },
    { name: "documents_fts", type: "table", sql: "CREATE VIRTUAL TABLE documents_fts USING fts5(filepath, title, body)" },
  ];

  const remoteTables: Record<string, Record<string, unknown>[]> = {
    content: [
      { hash: "h1", doc: "doc one", created_at: "2026-01-01" },
      { hash: "h2", doc: "doc two", created_at: "2026-01-02" },
    ],
    documents: [
      { id: 1, collection: "test", path: "a.md", title: "A", hash: "h1", created_at: "2026-01-01", modified_at: "2026-01-01", active: 1 },
      { id: 2, collection: "test", path: "b.md", title: "B", hash: "h2", created_at: "2026-01-02", modified_at: "2026-01-02", active: 1 },
    ],
    store_config: [
      { key: "last_push", value: "2026-06-11T10:00:00Z" },
    ],
    documents_fts: [],
  };

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-pull-"));
    localDbPath = join(testDir, "local.sqlite");
    const db = openDatabase(localDbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`INSERT INTO store_config (key, value) VALUES ('last_pull', '2026-01-01T00:00:00Z')`);
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("pull downloads data and DB is valid", async () => {
    const { pullFromRemote } = await import("../src/cloud/pull.js");
    const client = createMockPullClient({ schema: remoteSchema, tables: remoteTables });
    const result = await pullFromRemote(client as any, localDbPath, { force: true });

    expect(result.swapped).toBe(true);
    expect(result.tables.content.rows).toBe(2);
    expect(result.tables.documents.rows).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const db = openDatabase(localDbPath);
    const contentCount = (db.prepare("SELECT count(*) as cnt FROM content").get() as { cnt: number }).cnt;
    const docCount = (db.prepare("SELECT count(*) as cnt FROM documents").get() as { cnt: number }).cnt;
    expect(contentCount).toBe(2);
    expect(docCount).toBe(2);

    const docs = db.prepare("SELECT title FROM documents ORDER BY id").all() as { title: string }[];
    expect(docs[0].title).toBe("A");
    expect(docs[1].title).toBe("B");

    const row = db.prepare("SELECT value FROM store_config WHERE key = 'last_pull'").get() as { value: string } | undefined;
    expect(row).toBeTruthy();
    expect(new Date(row!.value).getTime()).toBeGreaterThan(0);
    db.close();
  });
});

describe("pull — already up to date", () => {
  let testDir: string;
  let localDbPath: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-pull-uptodate-"));
    localDbPath = join(testDir, "local.sqlite");
    const db = openDatabase(localDbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`INSERT INTO store_config (key, value) VALUES ('last_pull', '2026-06-11T12:00:00Z')`);
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("skips pull when remote is older", async () => {
    const { pullFromRemote } = await import("../src/cloud/pull.js");
    const client = createMockPullClient({
      schema: [
        { name: "store_config", type: "table", sql: "CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT)" },
      ],
      tables: { store_config: [{ key: "last_push", value: "2026-06-11T10:00:00Z" }] },
    });

    const result = await pullFromRemote(client as any, localDbPath);
    expect(result.swapped).toBe(false);
  });
});

describe("pull — empty remote", () => {
  let testDir: string;
  let localDbPath: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-pull-empty-"));
    localDbPath = join(testDir, "local.sqlite");
    const db = openDatabase(localDbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("pull handles empty remote tables", async () => {
    const { pullFromRemote } = await import("../src/cloud/pull.js");
    const client = createMockPullClient({
      schema: [
        { name: "content", type: "table", sql: "CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)" },
        { name: "store_config", type: "table", sql: "CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT)" },
      ],
      tables: { content: [], store_config: [] },
    });

    const result = await pullFromRemote(client as any, localDbPath, { force: true });
    expect(result.swapped).toBe(true);
    expect(result.tables.content.rows).toBe(0);
  });
});

describe("pull — idempotent", () => {
  let testDir: string;
  let localDbPath: string;

  const remoteSchema = [
    { name: "content", type: "table", sql: "CREATE TABLE content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)" },
    { name: "documents", type: "table", sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT, path TEXT, title TEXT, hash TEXT, created_at TEXT, modified_at TEXT, active INTEGER DEFAULT 1)" },
    { name: "store_config", type: "table", sql: "CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT)" },
    { name: "documents_fts", type: "table", sql: "CREATE VIRTUAL TABLE documents_fts USING fts5(filepath, title, body)" },
  ];

  const remoteTables: Record<string, Record<string, unknown>[]> = {
    content: [{ hash: "h1", doc: "hello", created_at: "2026-01-01" }],
    documents: [{ id: 1, collection: "x", path: "x.md", title: "X", hash: "h1", created_at: "2026-01-01", modified_at: "2026-01-01", active: 1 }],
    store_config: [{ key: "last_push", value: "2026-06-11T10:00:00Z" }],
    documents_fts: [],
  };

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-pull-idem-"));
    localDbPath = join(testDir, "local.sqlite");
    const db = openDatabase(localDbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("pull twice produces same result", async () => {
    const { pullFromRemote } = await import("../src/cloud/pull.js");

    const client1 = createMockPullClient({ schema: remoteSchema, tables: remoteTables });
    const r1 = await pullFromRemote(client1 as any, localDbPath, { force: true });

    const client2 = createMockPullClient({ schema: remoteSchema, tables: remoteTables });
    const r2 = await pullFromRemote(client2 as any, localDbPath, { force: true });

    expect(r1.tables.content.rows).toBe(r2.tables.content.rows);
    expect(r1.tables.documents.rows).toBe(r2.tables.documents.rows);
    expect(r1.swapped).toBe(true);
    expect(r2.swapped).toBe(true);
  });
});
