import type { Database } from "../db.js";
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

export async function pushToRemote(db: Database, client: CloudClient): Promise<PushResult> {
  const start = Date.now();
  const tables = getLocalSchema(db);
  const result: PushResult = { tables: {}, durationMs: 0 };

  await createRemoteSchema(client, tables);

  const orderedTables = tables.filter(t => t.name !== "documents_fts" && t.type !== "vec0");
  for (const table of orderedTables) {
    const rows = await pushTable(db, client, table.name, table.columns);
    result.tables[table.name] = { rows };
  }

  const vecTable = tables.find(t => t.type === "vec0");
  if (vecTable) {
    const rows = await pushVecTable(db, client, vecTable);
    result.tables[vecTable.name] = { rows };
  }

  const ftsTable = tables.find(t => t.name === "documents_fts");
  if (ftsTable) {
    const rows = await pushTable(db, client, ftsTable.name, ftsTable.columns);
    result.tables[ftsTable.name] = { rows };
  }

  await client.execute(
    "INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)",
    ["last_push", new Date().toISOString()]
  );

  result.durationMs = Date.now() - start;
  return result;
}

function getLocalSchema(db: Database): TableInfo[] {
  const tables: TableInfo[] = [];

  const regularTables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'documents\\_fts\\_%' ESCAPE '\\' ORDER BY name"
  ).all() as { name: string; sql: string }[];

  for (const t of regularTables) {
    if (t.name.startsWith("documents_fts_")) continue;
    if (t.name.startsWith("vectors_vec_") && t.name !== "vectors_vec") continue;
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "regular", ddl: t.sql, columns: cols });
  }

  const virtualTables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING vec0%'"
  ).all() as { name: string; sql: string }[];

  for (const t of virtualTables) {
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "vec0", ddl: t.sql, columns: cols });
  }

  const ftsTables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%USING fts5%'"
  ).all() as { name: string; sql: string }[];

  for (const t of ftsTables) {
    const cols = getColumns(db, t.name);
    tables.push({ name: t.name, type: "virtual", ddl: t.sql, columns: cols });
  }

  return tables;
}

function getColumns(db: Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[];
  return rows.map(r => r.name);
}

async function createRemoteSchema(client: CloudClient, tables: TableInfo[]): Promise<void> {
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
  return ddl.replace(/CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/i, "CREATE TABLE IF NOT EXISTS");
}

async function createVecTableRemote(client: CloudClient, table: TableInfo): Promise<void> {
  const dimMatch = table.ddl.match(/float\[(\d+)\]/);
  const dimensions = dimMatch?.[1] ? parseInt(dimMatch[1], 10) : 1024;

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${table.name} (hash_seq TEXT PRIMARY KEY, embedding FLOAT32(${dimensions}))`
  );

  try {
    await client.execute(
      `CREATE VECTOR INDEX IF NOT EXISTS ${table.name}_idx ON ${table.name} (embedding DISTANCE cosine)`
    );
  } catch {
    // vector index may not be supported or already exists
  }
}

async function pushTable(db: Database, client: CloudClient, tableName: string, columns: string[]): Promise<number> {
  const totalRow = db.prepare(`SELECT count(*) as cnt FROM ${tableName}`).get() as { cnt: number };
  const total = totalRow.cnt;

  if (total === 0) return 0;

  await client.execute(`DELETE FROM ${tableName}`);

  const batchSize = 50;
  const colList = columns.join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const insertSql = `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`;

  let offset = 0;
  while (offset < total) {
    const rows = db.prepare(`SELECT ${colList} FROM ${tableName} LIMIT ? OFFSET ?`).all(batchSize, offset) as Record<string, unknown>[];
    if (rows.length === 0) break;

    const stmts = rows.map(row => ({
      sql: insertSql,
      args: columns.map(c => row[c]),
    }));

    await client.batch(stmts);
    offset += rows.length;
  }

  return total;
}

async function pushVecTable(db: Database, client: CloudClient, table: TableInfo): Promise<number> {
  const totalRow = db.prepare(`SELECT count(*) as cnt FROM ${table.name}`).get() as { cnt: number };
  const total = totalRow.cnt;

  if (total === 0) return 0;

  await client.execute(`DELETE FROM ${table.name}`);

  const batchSize = 25;
  let offset = 0;

  while (offset < total) {
    const rows = db.prepare(`SELECT hash_seq, embedding FROM ${table.name} LIMIT ? OFFSET ?`).all(batchSize, offset) as { hash_seq: string; embedding: Buffer }[];

    if (rows.length === 0) break;

    const stmts = rows.map(row => {
      const float32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const embeddingStr = `[${Array.from(float32).join(",")}]`;
      return {
        sql: `INSERT INTO ${table.name} (hash_seq, embedding) VALUES (?, vector32(?))`,
        args: [row.hash_seq, embeddingStr],
      };
    });

    await client.batch(stmts);
    offset += rows.length;
  }

  return total;
}
