import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import type { Database } from "../src/db.js";
import type { CloudClient } from "../src/cloud/client.js";

// =============================================================================
// Mock remote DB that maintains state across pushes (simulates Turso)
// =============================================================================

class MockRemoteDB {
  private tables: Map<string, Map<string, Record<string, unknown>[]>> =
    new Map();
  private schema: Map<string, string> = new Map();
  public executedSql: { sql: string; args?: unknown[] }[] = [];

  constructor() {
    // Initialize with empty schema — push will create tables
  }

  getClient(): CloudClient {
    const self = this;
    return {
      async execute(sql: string, args?: unknown[]) {
        self.executedSql.push({ sql, args });
        const lc = sql.trim().toLowerCase();

        // CREATE TABLE IF NOT EXISTS
        if (
          lc.startsWith("create table") ||
          lc.startsWith("create virtual table")
        ) {
          const nameMatch = sql.match(
            /(?:table)\s+(?:if\s+not\s+exists\s+)?(\w+)/i,
          );
          if (nameMatch) {
            self.schema.set(nameMatch[1], sql);
            if (!self.tables.has(nameMatch[1])) {
              self.tables.set(nameMatch[1], new Map());
            }
          }
          return { rows: [] };
        }

        // CREATE VECTOR INDEX
        if (lc.startsWith("create vector index")) {
          return { rows: [] };
        }

        // CREATE INDEX
        if (lc.startsWith("create index")) {
          return { rows: [] };
        }

        // DELETE FROM table [WHERE ...]
        if (lc.startsWith("delete from")) {
          const tableMatch = sql.match(/delete\s+from\s+(\w+)/i);
          if (!tableMatch) return { rows: [] };
          const tableName = tableMatch[1];
          const tableMap = self.tables.get(tableName);

          // Check for WHERE clause
          const whereMatch = sql.match(/where\s+(.+)/i);
          if (whereMatch && tableMap && args && args.length > 0) {
            // Handle: DELETE FROM table WHERE column IN (?, ?, ...)
            const colMatch = whereMatch[1].match(/(\w+)\s+in\s+\(([^)]+)\)/i);
            if (colMatch) {
              const colName = colMatch[1];
              const valuesToDelete = new Set(args.map(String));
              for (const [key, row] of tableMap) {
                if (valuesToDelete.has(String(row[colName]))) {
                  tableMap.delete(key);
                }
              }
              return { rows: [] };
            }
            // Handle: DELETE FROM table WHERE column NOT IN (subquery)
            // This is complex — for mock, just skip
            return { rows: [] };
          }

          // DELETE FROM table (no WHERE) — delete all
          if (tableMap) {
            tableMap.clear();
          }
          return { rows: [] };
        }

        // INSERT OR REPLACE INTO table ...
        if (
          lc.startsWith("insert or replace into") ||
          lc.startsWith("insert or ignore into") ||
          lc.startsWith("insert into")
        ) {
          const tableMatch = sql.match(/into\s+(\w+)/i);
          if (!tableMatch || !args) return { rows: [] };
          const tableName = tableMatch[1];
          let tableMap = self.tables.get(tableName);
          if (!tableMap) {
            tableMap = new Map();
            self.tables.set(tableName, tableMap);
          }

          // Parse columns
          const colsMatch = sql.match(/\(([^)]+)\)\s*values/i);
          const cols = colsMatch
            ? colsMatch[1].split(",").map((c) => c.trim())
            : [];
          const row: Record<string, unknown> = {};
          cols.forEach((col, i) => {
            row[col] = args[i];
          });

          // Compute dedup key:
          // - documents: use collection|path (UNIQUE constraint)
          // - store_collections: use name (PK)
          // - content/content_vectors/llm_cache: use hash or hash+seq
          // - store_config: use key
          // - default: first column
          let pk: string;
          if (tableName === "documents") {
            pk = `${row.collection}|${row.path}`;
          } else if (tableName === "content_vectors") {
            pk = `${row.hash}|${row.seq}`;
          } else {
            const pkCol = cols[0];
            pk = String(row[pkCol]);
          }

          if (lc.startsWith("insert or ignore")) {
            if (!tableMap.has(pk)) {
              tableMap.set(pk, row);
            }
          } else {
            tableMap.set(pk, row);
          }
          return { rows: [] };
        }

        // SELECT count(*) FROM table
        if (lc.includes("count(*)")) {
          const tableMatch = sql.match(/from\s+(\w+)/i);
          if (tableMatch) {
            const cnt = self.getRowCount(tableMatch[1]);
            return { rows: [{ cnt }] };
          }
          return { rows: [{ cnt: 0 }] };
        }

        // SELECT ... FROM table
        if (lc.startsWith("select") && lc.includes("from")) {
          const tableMatch = sql.match(/from\s+(\w+)/i);
          if (!tableMatch) return { rows: [] };
          const tableName = tableMatch[1];
          const tableMap = self.tables.get(tableName);
          if (!tableMap) return { rows: [] };

          let rows = Array.from(tableMap.values());

          // Handle WHERE column IN (...)
          const whereMatch = sql.match(/where\s+(.+)/i);
          if (whereMatch && args && args.length > 0) {
            const colInMatch = whereMatch[1].match(/(\w+)\s+in\s+\(([^)]+)\)/i);
            if (colInMatch) {
              const colName = colInMatch[1];
              const filterValues = new Set(args.map(String));
              rows = rows.filter((r) => filterValues.has(String(r[colName])));
            }
            // NOT IN subquery — return all for mock
          }

          // Handle LIMIT/OFFSET
          const limitMatch = sql.match(/limit\s+(\d+)\s+offset\s+(\d+)/i);
          if (limitMatch) {
            const limit = parseInt(limitMatch[1]);
            const offset = parseInt(limitMatch[2]);
            // Parse columns from SELECT
            const colsMatch = sql.match(/select\s+(.+?)\s+from/i);
            const cols =
              colsMatch && colsMatch[1] !== "*"
                ? colsMatch[1].split(",").map((c) => c.trim())
                : Object.keys(rows[0] ?? {});
            return {
              rows: rows.slice(offset, offset + limit).map((r) => {
                const filtered: Record<string, unknown> = {};
                for (const c of cols) {
                  filtered[c] = r[c];
                }
                return filtered;
              }),
            };
          }

          return { rows };
        }

        return { rows: [] };
      },

      async batch(statements: { sql: string; args?: unknown[] }[]) {
        const results: { rows: Record<string, unknown>[] }[] = [];
        for (const stmt of statements) {
          await self.getClient().execute(stmt.sql, stmt.args);
          results.push({ rows: [] });
        }
        return results;
      },

      close() {},
    };
  }

  getRowCount(tableName: string): number {
    const tableMap = this.tables.get(tableName);
    return tableMap ? tableMap.size : 0;
  }

  getRows(tableName: string): Record<string, unknown>[] {
    const tableMap = this.tables.get(tableName);
    return tableMap ? Array.from(tableMap.values()) : [];
  }

  getCollections(): string[] {
    const rows = this.getRows("store_collections");
    return rows.map((r) => String(r.name));
  }

  getDocumentCollections(): string[] {
    const rows = this.getRows("documents");
    return [...new Set(rows.map((r) => String(r.collection)))];
  }
}

// =============================================================================
// Helper: create a local QMD DB with specified collections and documents
// =============================================================================

function createLocalDB(
  dbPath: string,
  collections: { name: string; path: string }[],
  documents: {
    collection: string;
    path: string;
    title: string;
    hash: string;
    content: string;
  }[],
): Database {
  const db = openDatabase(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    loadSqliteVec(db);
  } catch {}

  // Create tables (mirrors store.ts schema)
  db.exec(
    `CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(collection, path))`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS store_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, pattern TEXT NOT NULL DEFAULT '**/*.md', ignore_patterns TEXT, include_by_default INTEGER DEFAULT 1, update_command TEXT, context TEXT)`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, embed_fingerprint TEXT NOT NULL DEFAULT '', total_chunks INTEGER NOT NULL DEFAULT 1, embedded_at TEXT NOT NULL, PRIMARY KEY (hash, seq))`,
  );
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(filepath, title, body, tokenize='porter unicode61')`,
  );

  // Insert collections
  const insertColl = db.prepare(
    "INSERT OR REPLACE INTO store_collections (name, path, pattern) VALUES (?, ?, ?)",
  );
  for (const coll of collections) {
    insertColl.run(coll.name, coll.path, "**/*.md");
  }

  // Insert content + documents
  const insertContent = db.prepare(
    "INSERT OR REPLACE INTO content (hash, doc, created_at) VALUES (?, ?, ?)",
  );
  const insertDoc = db.prepare(
    "INSERT OR REPLACE INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const doc of documents) {
    insertContent.run(doc.hash, doc.content, "2026-01-01");
    insertDoc.run(
      doc.collection,
      doc.path,
      doc.title,
      doc.hash,
      "2026-01-01",
      "2026-01-01",
    );
  }

  // Insert store_config
  db.prepare(
    "INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)",
  ).run("config_hash", "test");

  return db;
}

// =============================================================================
// TEST SUITE: Merge-based push
// =============================================================================

describe("push merge — multi-instance shared remote", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-merge-push-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset mock remote state between test groups by creating a fresh one in each test
  });

  test("instance B push does not delete instance A data", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    // Instance A: collections alpha, beta
    const dbA = createLocalDB(
      join(testDir, "instanceA.sqlite"),
      [
        { name: "alpha", path: "/workspace/alpha" },
        { name: "beta", path: "/workspace/beta" },
      ],
      [
        {
          collection: "alpha",
          path: "a1.md",
          title: "A1",
          hash: "ha1",
          content: "alpha doc 1",
        },
        {
          collection: "alpha",
          path: "a2.md",
          title: "A2",
          hash: "ha2",
          content: "alpha doc 2",
        },
        {
          collection: "beta",
          path: "b1.md",
          title: "B1",
          hash: "hb1",
          content: "beta doc 1",
        },
      ],
    );

    // Instance B: collections gamma, delta
    const dbB = createLocalDB(
      join(testDir, "instanceB.sqlite"),
      [
        { name: "gamma", path: "/workspace/gamma" },
        { name: "delta", path: "/workspace/delta" },
      ],
      [
        {
          collection: "gamma",
          path: "g1.md",
          title: "G1",
          hash: "hg1",
          content: "gamma doc 1",
        },
        {
          collection: "delta",
          path: "d1.md",
          title: "D1",
          hash: "hd1",
          content: "delta doc 1",
        },
      ],
    );

    // A pushes first
    await pushToRemote(dbA, remote.getClient());
    expect(remote.getRowCount("documents")).toBe(3);
    expect(remote.getCollections().sort()).toEqual(["alpha", "beta"]);

    // B pushes second
    await pushToRemote(dbB, remote.getClient());

    // Both A's and B's data should exist on remote
    expect(remote.getRowCount("documents")).toBe(5); // 3 from A + 2 from B
    expect(remote.getCollections().sort()).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);

    // Verify A's documents are intact
    const remoteDocColls = remote.getDocumentCollections().sort();
    expect(remoteDocColls).toEqual(["alpha", "beta", "delta", "gamma"]);

    dbA.close();
    dbB.close();
  });

  test("same instance re-push updates only its own collections", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    // Instance A: initial state
    const dbA = createLocalDB(
      join(testDir, "repushA.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a1.md",
          title: "A1",
          hash: "ha1",
          content: "alpha doc 1",
        },
        {
          collection: "alpha",
          path: "a2.md",
          title: "A2",
          hash: "ha2",
          content: "alpha doc 2",
        },
      ],
    );

    // Instance B
    const dbB = createLocalDB(
      join(testDir, "repushB.sqlite"),
      [{ name: "beta", path: "/workspace/beta" }],
      [
        {
          collection: "beta",
          path: "b1.md",
          title: "B1",
          hash: "hb1",
          content: "beta doc 1",
        },
      ],
    );

    // Both push
    await pushToRemote(dbA, remote.getClient());
    await pushToRemote(dbB, remote.getClient());
    expect(remote.getRowCount("documents")).toBe(3);

    // A removes a2.md, adds a3.md
    dbA
      .prepare("DELETE FROM documents WHERE collection = ? AND path = ?")
      .run("alpha", "a2.md");
    dbA
      .prepare(
        "INSERT OR REPLACE INTO content (hash, doc, created_at) VALUES (?, ?, ?)",
      )
      .run("ha3", "alpha doc 3", "2026-01-01");
    dbA
      .prepare(
        "INSERT OR REPLACE INTO documents (collection, path, title, hash, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("alpha", "a3.md", "A3", "ha3", "2026-01-01", "2026-01-01");

    // A re-pushes
    await pushToRemote(dbA, remote.getClient());

    // alpha should have a1.md and a3.md (a2.md removed), beta should still have b1.md
    const remoteDocs = remote.getRows("documents");
    const alphaDocs = remoteDocs.filter((d) => d.collection === "alpha");
    const betaDocs = remoteDocs.filter((d) => d.collection === "beta");

    expect(alphaDocs.length).toBe(2);
    expect(alphaDocs.find((d) => d.path === "a1.md")).toBeTruthy();
    expect(alphaDocs.find((d) => d.path === "a3.md")).toBeTruthy();
    expect(alphaDocs.find((d) => d.path === "a2.md")).toBeUndefined();

    expect(betaDocs.length).toBe(1);
    expect(betaDocs[0].path).toBe("b1.md");

    dbA.close();
    dbB.close();
  });

  test("content table uses INSERT OR IGNORE (shared hashes preserved)", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    // Instance A has hash "shared_hash"
    const dbA = createLocalDB(
      join(testDir, "contentA.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a1.md",
          title: "A1",
          hash: "shared_hash",
          content: "shared content",
        },
      ],
    );

    // Instance B also has hash "shared_hash" (same file content)
    const dbB = createLocalDB(
      join(testDir, "contentB.sqlite"),
      [{ name: "beta", path: "/workspace/beta" }],
      [
        {
          collection: "beta",
          path: "b1.md",
          title: "B1",
          hash: "shared_hash",
          content: "shared content",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());
    await pushToRemote(dbB, remote.getClient());

    // Content table should have 1 row (shared hash deduplicated)
    expect(remote.getRowCount("content")).toBe(1);

    // Documents table should have 2 rows (different collections/paths)
    expect(remote.getRowCount("documents")).toBe(2);

    dbA.close();
    dbB.close();
  });

  test("store_collections — only own collections updated", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "collA.sqlite"),
      [
        { name: "alpha", path: "/workspace/alpha" },
        { name: "beta", path: "/workspace/beta" },
      ],
      [
        {
          collection: "alpha",
          path: "a.md",
          title: "A",
          hash: "ha",
          content: "a",
        },
      ],
    );

    const dbB = createLocalDB(
      join(testDir, "collB.sqlite"),
      [{ name: "gamma", path: "/workspace/gamma" }],
      [
        {
          collection: "gamma",
          path: "g.md",
          title: "G",
          hash: "hg",
          content: "g",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());
    await pushToRemote(dbB, remote.getClient());

    // All 3 collections should exist
    const remoteColls = remote.getCollections().sort();
    expect(remoteColls).toEqual(["alpha", "beta", "gamma"]);

    // Verify alpha path is from A, not overwritten by B
    const alphaColl = remote
      .getRows("store_collections")
      .find((c) => c.name === "alpha");
    expect(alphaColl?.path).toBe("/workspace/alpha");

    const gammaColl = remote
      .getRows("store_collections")
      .find((c) => c.name === "gamma");
    expect(gammaColl?.path).toBe("/workspace/gamma");

    dbA.close();
    dbB.close();
  });

  test("store_config — INSERT OR REPLACE, no DELETE ALL", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "configA.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a.md",
          title: "A",
          hash: "ha",
          content: "a",
        },
      ],
    );
    dbA
      .prepare("INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)")
      .run("alpha_setting", "value_a");

    const dbB = createLocalDB(
      join(testDir, "configB.sqlite"),
      [{ name: "beta", path: "/workspace/beta" }],
      [
        {
          collection: "beta",
          path: "b.md",
          title: "B",
          hash: "hb",
          content: "b",
        },
      ],
    );
    dbB
      .prepare("INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)")
      .run("beta_setting", "value_b");

    await pushToRemote(dbA, remote.getClient());
    await pushToRemote(dbB, remote.getClient());

    const remoteConfig = remote.getRows("store_config");
    // Both instances' config should exist
    expect(remoteConfig.find((c) => c.key === "alpha_setting")?.value).toBe(
      "value_a",
    );
    expect(remoteConfig.find((c) => c.key === "beta_setting")?.value).toBe(
      "value_b",
    );
    expect(remoteConfig.find((c) => c.key === "last_push")).toBeTruthy();

    dbA.close();
    dbB.close();
  });

  test("three instances push — all data coexists", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "threeA.sqlite"),
      [{ name: "knowledge", path: "/workspace/knowledge" }],
      [
        {
          collection: "knowledge",
          path: "k1.md",
          title: "K1",
          hash: "hk1",
          content: "knowledge 1",
        },
        {
          collection: "knowledge",
          path: "k2.md",
          title: "K2",
          hash: "hk2",
          content: "knowledge 2",
        },
      ],
    );

    const dbB = createLocalDB(
      join(testDir, "threeB.sqlite"),
      [{ name: "stacks", path: "/workspace/stacks" }],
      [
        {
          collection: "stacks",
          path: "s1.yaml",
          title: "S1",
          hash: "hs1",
          content: "stack 1",
        },
      ],
    );

    const dbC = createLocalDB(
      join(testDir, "threeC.sqlite"),
      [{ name: "notes", path: "/workspace/notes" }],
      [
        {
          collection: "notes",
          path: "n1.md",
          title: "N1",
          hash: "hn1",
          content: "note 1",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());
    await pushToRemote(dbB, remote.getClient());
    await pushToRemote(dbC, remote.getClient());

    expect(remote.getRowCount("documents")).toBe(4);
    expect(remote.getCollections().sort()).toEqual([
      "knowledge",
      "notes",
      "stacks",
    ]);
    expect(remote.getDocumentCollections().sort()).toEqual([
      "knowledge",
      "notes",
      "stacks",
    ]);

    dbA.close();
    dbB.close();
    dbC.close();
  });

  test("push uses DELETE WHERE collection IN (...) not DELETE ALL for documents", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "deleteWhereA.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a.md",
          title: "A",
          hash: "ha",
          content: "a",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());

    // Check that DELETE statements for documents use WHERE clause, not bare DELETE
    const deleteStmts = remote.executedSql.filter((e) =>
      e.sql.toLowerCase().startsWith("delete from documents"),
    );
    expect(deleteStmts.length).toBeGreaterThan(0);

    // At least one DELETE should have a WHERE clause
    const hasWhereClause = deleteStmts.some((e) =>
      e.sql.toLowerCase().includes("where"),
    );
    expect(hasWhereClause).toBe(true);

    // No bare "DELETE FROM documents" (without WHERE)
    const bareDelete = deleteStmts.find(
      (e) => !e.sql.toLowerCase().includes("where"),
    );
    expect(bareDelete).toBeUndefined();

    dbA.close();
  });

  test("push uses DELETE WHERE name IN (...) not DELETE ALL for store_collections", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "deleteWhereColl.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a.md",
          title: "A",
          hash: "ha",
          content: "a",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());

    const deleteStmts = remote.executedSql.filter((e) =>
      e.sql.toLowerCase().startsWith("delete from store_collections"),
    );
    // If there are delete statements, they must have WHERE
    for (const stmt of deleteStmts) {
      expect(stmt.sql.toLowerCase()).toContain("where");
    }

    dbA.close();
  });

  test("content table — no DELETE ALL (uses INSERT OR IGNORE)", async () => {
    const { pushToRemote } = await import("../src/cloud/push.js");
    const remote = new MockRemoteDB();

    const dbA = createLocalDB(
      join(testDir, "noDeleteContent.sqlite"),
      [{ name: "alpha", path: "/workspace/alpha" }],
      [
        {
          collection: "alpha",
          path: "a.md",
          title: "A",
          hash: "ha",
          content: "a",
        },
      ],
    );

    await pushToRemote(dbA, remote.getClient());

    // content table should NOT have any DELETE statements
    const contentDeletes = remote.executedSql.filter((e) =>
      e.sql.toLowerCase().startsWith("delete from content"),
    );
    expect(contentDeletes.length).toBe(0);

    // content inserts should use INSERT OR IGNORE
    const contentInserts = remote.executedSql.filter(
      (e) =>
        e.sql.toLowerCase().includes("insert") &&
        e.sql.toLowerCase().includes("content"),
    );
    const usesIgnore = contentInserts.some((e) =>
      e.sql.toLowerCase().includes("insert or ignore"),
    );
    expect(usesIgnore).toBe(true);

    dbA.close();
  });
});
