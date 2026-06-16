import type { Database } from "../db.js";
import { openDatabase, loadSqliteVec } from "../db.js";
import { DEFAULT_EMBEDDING_DIM } from "../store.js";
import type { CloudClient } from "./client.js";
import {
  copyFileSync,
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

export interface PullResult {
  tables: Record<string, { rows: number }>;
  durationMs: number;
  swapped: boolean;
}

interface RemoteTable {
  name: string;
  type: "regular" | "virtual_fts" | "virtual_vec";
  ddl: string;
  columns: string[];
}

export async function pullFromRemote(
  client: CloudClient,
  localDbPath: string,
  options?: { force?: boolean },
): Promise<PullResult> {
  const start = Date.now();
  const result: PullResult = { tables: {}, durationMs: 0, swapped: false };

  const remoteTables = await getRemoteSchema(client);

  if (!options?.force) {
    const needsPull = await checkTimestamps(client, localDbPath);
    if (!needsPull) {
      result.durationMs = Date.now() - start;
      return result;
    }
  }

  const tempPath = localDbPath + ".pull.tmp";
  const bakPath = localDbPath + ".bak";

  let tempDb: Database;
  try {
    tempDb = openDatabase(tempPath);
  } catch {
    throw new Error(`Cannot create temp DB at ${tempPath}`);
  }

  tempDb.exec("PRAGMA journal_mode = WAL");
  tempDb.exec("PRAGMA foreign_keys = ON");
  try {
    loadSqliteVec(tempDb);
  } catch {}

  await createLocalSchema(tempDb, remoteTables);

  const vecTable = remoteTables.find((t) => t.type === "virtual_vec");

  const orderedTables = remoteTables.filter(
    (t) => t.type === "regular" && t.name !== "store_config",
  );
  for (const table of orderedTables) {
    const rows = await downloadTable(client, tempDb, table);
    result.tables[table.name] = { rows };
  }

  if (vecTable) {
    const rows = await downloadVecTable(client, tempDb, vecTable);
    result.tables[vecTable.name] = { rows };
  }

  const storeConfigRows = await downloadTable(client, tempDb, {
    name: "store_config",
    type: "regular",
    ddl: "CREATE TABLE IF NOT EXISTS store_config (key TEXT PRIMARY KEY, value TEXT)",
    columns: ["key", "value"],
  });
  result.tables["store_config"] = { rows: storeConfigRows };

  tempDb
    .prepare("INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)")
    .run("last_pull", new Date().toISOString());

  rebuildFts(tempDb);

  const validated = validatePull(tempDb, result.tables);
  if (!validated) {
    tempDb.close();
    throw new Error("Pull validation failed. Temp DB kept at " + tempPath);
  }

  tempDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  tempDb.close();

  if (existsSync(bakPath)) unlinkSync(bakPath);
  if (existsSync(localDbPath)) {
    copyFileSync(localDbPath, bakPath);
  }

  const tmpContent = readFileSync(tempPath);
  writeFileSync(localDbPath, tmpContent);
  try {
    unlinkSync(tempPath);
  } catch {}

  for (const p of [localDbPath + "-wal", localDbPath + "-shm"]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }

  if (existsSync(bakPath)) {
    try {
      unlinkSync(bakPath);
    } catch {}
  }

  result.swapped = true;
  result.durationMs = Date.now() - start;
  return result;
}

async function checkTimestamps(
  client: CloudClient,
  localDbPath: string,
): Promise<boolean> {
  let remotePush: string | null = null;
  let localPull: string | null = null;

  try {
    const rows = await client.execute(
      "SELECT value FROM store_config WHERE key = 'last_push'",
    );
    remotePush = (rows.rows[0]?.value as string) ?? null;
  } catch {}

  if (existsSync(localDbPath)) {
    try {
      const db = openDatabase(localDbPath);
      const row = db
        .prepare(
          "SELECT key, value FROM store_config WHERE key IN ('last_push', 'last_pull')",
        )
        .all() as { key: string; value: string }[];
      const lastPush = row.find((r) => r.key === "last_push")?.value;
      const lastPull = row.find((r) => r.key === "last_pull")?.value;
      localPull = lastPull ?? lastPush ?? null;
      db.close();
    } catch {}
  }

  if (!remotePush) return true;
  if (!localPull) return true;
  return new Date(remotePush) > new Date(localPull);
}

async function getRemoteSchema(client: CloudClient): Promise<RemoteTable[]> {
  const tables: RemoteTable[] = [];
  const rows = await client.execute(
    "SELECT name, type, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'documents_fts_%' ORDER BY name",
  );

  for (const row of rows.rows) {
    const name = row.name as string;
    const ddl = row.sql as string;
    if (!ddl) continue;

    if (name.startsWith("documents_fts_")) continue;

    if (ddl.includes("USING fts5")) {
      const cols = await getRemoteColumns(client, name);
      tables.push({ name, type: "virtual_fts", ddl, columns: cols });
    } else if (ddl.toLowerCase().includes("float32")) {
      const cols = await getRemoteColumns(client, name);
      tables.push({ name, type: "virtual_vec", ddl, columns: cols });
    } else {
      const cols = await getRemoteColumns(client, name);
      tables.push({ name, type: "regular", ddl, columns: cols });
    }
  }

  return tables;
}

async function getRemoteColumns(
  client: CloudClient,
  tableName: string,
): Promise<string[]> {
  try {
    const rows = await client.execute(`PRAGMA table_info("${tableName}")`);
    return rows.rows.map((r: Record<string, unknown>) => r.name as string);
  } catch {
    return [];
  }
}

async function createLocalSchema(
  db: Database,
  tables: RemoteTable[],
): Promise<void> {
  for (const table of tables) {
    if (table.type === "virtual_vec") {
      const dimMatch = table.ddl.match(/FLOAT32\((\d+)\)/i);
      const dimensions = dimMatch?.[1]
        ? parseInt(dimMatch[1], 10)
        : DEFAULT_EMBEDDING_DIM;
      try {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${table.name} USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`,
        );
      } catch {
        db.exec(
          `CREATE TABLE IF NOT EXISTS ${table.name} (hash_seq TEXT PRIMARY KEY, embedding BLOB)`,
        );
      }
    } else if (table.type === "virtual_fts") {
      const ftsMatch = table.ddl.match(/USING fts5\(([^)]+)\)/);
      if (ftsMatch) {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${table.name} USING fts5(${ftsMatch[1]})`,
        );
      }
    } else {
      // Ensure IF NOT EXISTS to avoid errors when table already exists locally
      const ddl = table.ddl.replace(
        /CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/i,
        "CREATE TABLE IF NOT EXISTS",
      );
      db.exec(ddl);
    }
  }
}

async function downloadTable(
  client: CloudClient,
  localDb: Database,
  table: RemoteTable,
): Promise<number> {
  const totalRow = await client.execute(
    `SELECT count(*) as cnt FROM ${table.name}`,
  );
  const total = (totalRow.rows[0]?.cnt as number) ?? 0;
  if (total === 0) return 0;

  const cols =
    table.columns.length > 0
      ? table.columns
      : await getRemoteColumns(client, table.name);
  if (cols.length === 0) return 0;

  const colList = cols.join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const insertSql = `INSERT OR REPLACE INTO ${table.name} (${colList}) VALUES (${placeholders})`;
  const insertStmt = localDb.prepare(insertSql);

  const batchSize = 100;
  let offset = 0;
  let totalInserted = 0;

  localDb.exec("PRAGMA foreign_keys = OFF");

  while (offset < total) {
    const rows = await client.execute(
      `SELECT ${colList} FROM ${table.name} LIMIT ${batchSize} OFFSET ${offset}`,
    );
    if (rows.rows.length === 0) break;

    const insertMany = localDb.transaction(() => {
      for (const row of rows.rows) {
        insertStmt.run(
          ...cols.map((c) => row[c] as string | number | null | Buffer),
        );
      }
    });
    insertMany();
    totalInserted += rows.rows.length;
    offset += rows.rows.length;
  }

  localDb.exec("PRAGMA foreign_keys = ON");
  return totalInserted;
}

async function downloadVecTable(
  client: CloudClient,
  localDb: Database,
  table: RemoteTable,
): Promise<number> {
  const totalRow = await client.execute(
    `SELECT count(*) as cnt FROM ${table.name}`,
  );
  const total = (totalRow.rows[0]?.cnt as number) ?? 0;
  if (total === 0) return 0;

  const batchSize = 50;
  let offset = 0;

  while (offset < total) {
    const rows = await client.execute(
      `SELECT hash_seq, embedding FROM ${table.name} LIMIT ${batchSize} OFFSET ${offset}`,
    );
    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      const hashSeq = row.hash_seq as string;
      const embedding = row.embedding;
      let embeddingBuffer: Buffer;

      if (typeof embedding === "string") {
        const nums = JSON.parse(embedding);
        embeddingBuffer = Buffer.from(new Float32Array(nums).buffer);
      } else if (embedding instanceof ArrayBuffer) {
        embeddingBuffer = Buffer.from(embedding);
      } else if (Buffer.isBuffer(embedding)) {
        embeddingBuffer = embedding;
      } else if (Array.isArray(embedding)) {
        embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
      } else if (
        embedding &&
        typeof embedding === "object" &&
        "buffer" in embedding &&
        embedding.buffer instanceof ArrayBuffer
      ) {
        const typedEmb = embedding as {
          buffer: ArrayBuffer;
          byteOffset: number;
          byteLength: number;
        };
        embeddingBuffer = Buffer.from(
          typedEmb.buffer,
          typedEmb.byteOffset,
          typedEmb.byteLength,
        );
      } else {
        continue;
      }

      try {
        localDb
          .prepare("DELETE FROM vectors_vec WHERE hash_seq = ?")
          .run(hashSeq);
        localDb
          .prepare(
            "INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)",
          )
          .run(hashSeq, embeddingBuffer);
      } catch {
        // vec0 insert may fail if dimensions mismatch
      }
    }

    offset += rows.rows.length;
  }

  return total;
}

function rebuildFts(db: Database): void {
  try {
    const count = (
      db
        .prepare("SELECT count(*) as cnt FROM documents WHERE active = 1")
        .get() as { cnt: number }
    ).cnt;
    if (count === 0) return;

    db.exec("DELETE FROM documents_fts");

    const rows = db
      .prepare(
        `
      SELECT d.id, d.collection, d.path, d.title, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.active = 1
    `,
      )
      .all() as {
      id: number;
      collection: string;
      path: string;
      title: string;
      body: string;
    }[];

    const insert = db.prepare(
      "INSERT INTO documents_fts(rowid, filepath, title, body) VALUES (?, ?, ?, ?)",
    );
    const rebuild = db.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.id,
          `${row.collection}/${row.path}`,
          row.title,
          row.body,
        );
      }
    });
    rebuild();
  } catch {}
}

function validatePull(
  db: Database,
  tableResults: Record<string, { rows: number }>,
): boolean {
  for (const [name, info] of Object.entries(tableResults)) {
    if (info.rows === 0) continue;
    if (name === "documents_fts" || name === "store_config") continue;
    try {
      const localCount = (
        db.prepare(`SELECT count(*) as cnt FROM ${name}`).get() as {
          cnt: number;
        }
      ).cnt;
      if (localCount !== info.rows) {
        console.error(
          `Validation failed: ${name} expected ${info.rows}, got ${localCount}`,
        );
        return false;
      }
    } catch {}
  }
  return true;
}
