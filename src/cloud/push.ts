import type { Database } from "../db.js";
import { DEFAULT_EMBEDDING_DIM } from "../store.js";
import type { CloudClient } from "./client.js";

interface TableInfo {
  name: string;
  type: "regular" | "virtual" | "vec0";
  ddl: string;
  columns: string[];
}

export interface PushResult {
  tables: Record<string, { rows: number }>;
  durationMs: number;
}

export async function pushToRemote(
  db: Database,
  client: CloudClient,
): Promise<PushResult> {
  const start = Date.now();
  const tables = getLocalSchema(db);
  const result: PushResult = { tables: {}, durationMs: 0 };

  await createRemoteSchema(client, tables);

  // Categorize tables for merge-based push
  const localCollections = getLocalCollectionNames(db);

  for (const table of tables) {
    if (table.name === "documents_fts") continue;
    if (table.type === "vec0") continue;

    const rows = await pushTableMerge(db, client, table, localCollections);
    result.tables[table.name] = { rows };
  }

  const vecTable = tables.find((t) => t.type === "vec0");
  if (vecTable) {
    const rows = await pushVecTableMerge(db, client, vecTable);
    result.tables[vecTable.name] = { rows };
  }

  const ftsTable = tables.find((t) => t.name === "documents_fts");
  if (ftsTable) {
    const rows = await pushFtsTable(db, client, localCollections);
    result.tables[ftsTable.name] = { rows };
  }

  await client.execute(
    "INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)",
    ["last_push", new Date().toISOString()],
  );

  result.durationMs = Date.now() - start;
  return result;
}

function getLocalSchema(db: Database): TableInfo[] {
  const tables: TableInfo[] = [];

  const regularTables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'documents\\_fts\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];

  for (const t of regularTables) {
    if (t.name.startsWith("documents_fts_")) continue;
    if (t.name.startsWith("vectors_vec_") && t.name !== "vectors_vec") continue;
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "regular", ddl: t.sql, columns: cols });
  }

  const virtualTables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'",
    )
    .all() as { name: string; sql: string }[];

  for (const t of virtualTables) {
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "vec0", ddl: t.sql, columns: cols });
  }

  const ftsTables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'",
    )
    .all() as { name: string; sql: string }[];

  for (const t of ftsTables) {
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "virtual", ddl: t.sql, columns: cols });
  }

  return tables;
}

function getColumns(db: Database, tableName: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as {
      name: string;
    }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

function getLocalCollectionNames(db: Database): string[] {
  try {
    const rows = db.prepare("SELECT name FROM store_collections").all() as {
      name: string;
    }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

async function createRemoteSchema(
  client: CloudClient,
  tables: TableInfo[],
): Promise<void> {
  for (const table of tables) {
    if (table.type === "vec0") {
      await createVecTableRemote(client, table);
    } else if (table.type === "virtual" && table.name === "documents_fts") {
      try {
        await client.execute(table.ddl);
      } catch {
        // FTS5 virtual table may already exist
      }
    } else {
      const ddl = ensureIfNotExists(table.ddl);
      try {
        await client.execute(ddl);
      } catch {
        // table may already exist from a previous push
      }
    }
  }

  for (const table of tables) {
    if (table.type === "regular") {
      const indexes = getIndexesForTable(table.ddl);
      for (const idx of indexes) {
        try {
          await client.execute(idx);
        } catch {
          // index may already exist
        }
      }
    }
  }
}

function getIndexesForTable(ddl: string): string[] {
  const indexes: string[] = [];
  const idxRegex = /CREATE INDEX[^;]+;/gi;
  const matches = ddl.match(idxRegex);
  if (matches) indexes.push(...matches);
  return indexes;
}

export function ensureIfNotExists(ddl: string): string {
  return ddl.replace(
    /CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/i,
    "CREATE TABLE IF NOT EXISTS",
  );
}

async function createVecTableRemote(
  client: CloudClient,
  table: TableInfo,
): Promise<void> {
  const dimMatch = table.ddl.match(/float\[(\d+)\]/);
  const dimensions = dimMatch?.[1]
    ? parseInt(dimMatch[1], 10)
    : DEFAULT_EMBEDDING_DIM;

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${table.name} (hash_seq TEXT PRIMARY KEY, embedding FLOAT32(${dimensions}))`,
  );

  try {
    await client.execute(
      `CREATE VECTOR INDEX IF NOT EXISTS ${table.name}_idx ON ${table.name} (embedding DISTANCE cosine)`,
    );
  } catch {
    // vector index may not be supported or already exists
  }
}

// =============================================================================
// Merge-based push functions
// =============================================================================

/**
 * Push a table using merge strategy:
 * - Collection-aware tables (documents, store_collections): DELETE WHERE collection/name IN (local),
 *   then INSERT OR REPLACE
 * - Hash-keyed tables (content, content_vectors, llm_cache): INSERT OR IGNORE (no delete)
 * - Key-value tables (store_config): INSERT OR REPLACE (no delete)
 */
async function pushTableMerge(
  db: Database,
  client: CloudClient,
  table: TableInfo,
  localCollections: string[],
): Promise<number> {
  const tableName = table.name;
  const totalRow = db
    .prepare(`SELECT count(*) as cnt FROM ${tableName}`)
    .get() as { cnt: number };
  const total = totalRow.cnt;

  if (total === 0) return 0;

  // Determine merge strategy based on table type
  if (tableName === "documents" && localCollections.length > 0) {
    // Collection-aware: delete only our collections' documents
    const placeholders = localCollections.map(() => "?").join(", ");
    await client.execute(
      `DELETE FROM ${tableName} WHERE collection IN (${placeholders})`,
      localCollections,
    );
  } else if (tableName === "store_collections" && localCollections.length > 0) {
    // Collection-aware: delete only our collections
    const placeholders = localCollections.map(() => "?").join(", ");
    await client.execute(
      `DELETE FROM ${tableName} WHERE name IN (${placeholders})`,
      localCollections,
    );
  }
  // Other tables (content, content_vectors, llm_cache, store_config):
  // No DELETE — use INSERT OR IGNORE / INSERT OR REPLACE below

  // For documents table, exclude autoincrement id — let remote generate its own.
  // The UNIQUE(collection, path) constraint handles dedup on INSERT OR REPLACE.
  const insertCols =
    tableName === "documents"
      ? table.columns.filter((c) => c !== "id")
      : table.columns;

  const batchSize = 50;
  const colList = insertCols.join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");

  // Use INSERT OR IGNORE for hash-keyed tables, INSERT OR REPLACE for others
  const useIgnore = ["content", "content_vectors", "llm_cache"].includes(
    tableName,
  );
  const insertVerb = useIgnore ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
  const insertSql = `${insertVerb} INTO ${tableName} (${colList}) VALUES (${placeholders})`;

  let offset = 0;
  let pushed = 0;
  while (offset < total) {
    const selectCols = table.columns.join(", ");
    const rows = db
      .prepare(`SELECT ${selectCols} FROM ${tableName} LIMIT ? OFFSET ?`)
      .all(batchSize, offset) as Record<string, unknown>[];
    if (rows.length === 0) break;

    const stmts = rows.map((row) => ({
      sql: insertSql,
      args: insertCols.map((c) => row[c]),
    }));

    await client.batch(stmts);
    pushed += rows.length;
    offset += rows.length;
  }

  return total;
}

/**
 * Push vec0 table using INSERT OR IGNORE (no DELETE).
 * Vectors are identified by hash_seq which is globally unique.
 */
async function pushVecTableMerge(
  db: Database,
  client: CloudClient,
  table: TableInfo,
): Promise<number> {
  const totalRow = db
    .prepare(`SELECT count(*) as cnt FROM ${table.name}`)
    .get() as { cnt: number };
  const total = totalRow.cnt;

  if (total === 0) return 0;

  // No DELETE — use INSERT OR REPLACE for vec0
  const batchSize = 25;
  let offset = 0;
  let pushed = 0;

  while (offset < total) {
    const rows = db
      .prepare(`SELECT hash_seq, embedding FROM ${table.name} LIMIT ? OFFSET ?`)
      .all(batchSize, offset) as { hash_seq: string; embedding: Buffer }[];

    if (rows.length === 0) break;

    const stmts = rows.map((row) => {
      const float32 = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const embeddingStr = `[${Array.from(float32).join(",")}]`;
      return {
        sql: `INSERT OR REPLACE INTO ${table.name} (hash_seq, embedding) VALUES (?, vector32(?))`,
        args: [row.hash_seq, embeddingStr],
      };
    });

    await client.batch(stmts);
    pushed += rows.length;
    offset += rows.length;
  }

  return total;
}

/**
 * Push FTS table: delete entries for local collections' documents, then re-insert.
 * FTS5 rowid maps to documents.id, so we need to delete by rowids that belong to our collections.
 */
async function pushFtsTable(
  db: Database,
  client: CloudClient,
  localCollections: string[],
): Promise<number> {
  if (localCollections.length === 0) return 0;

  // Get document IDs from local DB for our collections
  const docIds = db
    .prepare(
      `SELECT id FROM documents WHERE collection IN (${localCollections.map(() => "?").join(", ")})`,
    )
    .all(...localCollections) as { id: number }[];

  if (docIds.length === 0) return 0;

  // Delete FTS entries for our document IDs on remote
  // Process in batches to avoid SQL too long
  const deleteBatchSize = 500;
  for (let i = 0; i < docIds.length; i += deleteBatchSize) {
    const batch = docIds.slice(i, i + deleteBatchSize);
    const placeholders = batch.map(() => "?").join(", ");
    await client.execute(
      `DELETE FROM documents_fts WHERE rowid IN (${placeholders})`,
      batch.map((b) => b.id),
    );
  }

  // Re-insert FTS entries from local DB
  const ftsRows = db
    .prepare(
      `
    SELECT d.id as rowid, d.collection || '/' || d.path as filepath, d.title, c.doc as body
    FROM documents d
    JOIN content c ON c.hash = d.hash
    WHERE d.active = 1 AND d.collection IN (${localCollections.map(() => "?").join(", ")})
  `,
    )
    .all(...localCollections) as {
    rowid: number;
    filepath: string;
    title: string;
    body: string;
  }[];

  const insertBatchSize = 50;
  for (let i = 0; i < ftsRows.length; i += insertBatchSize) {
    const batch = ftsRows.slice(i, i + insertBatchSize);
    const stmts = batch.map((row) => ({
      sql: `INSERT INTO documents_fts (rowid, filepath, title, body) VALUES (?, ?, ?, ?)`,
      args: [row.rowid, row.filepath, row.title, row.body],
    }));
    await client.batch(stmts);
  }

  return ftsRows.length;
}
