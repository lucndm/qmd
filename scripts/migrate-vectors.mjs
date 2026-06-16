#!/usr/bin/env node
/**
 * Migrate vectors_vec from vec0 virtual table to libSQL native FLOAT32 column.
 *
 * Two-phase: better-sqlite3 reads vec0 → close → libsql creates FLOAT32 + inserts
 */

import { createRequire } from "module";
import Database from "libsql";

const require = createRequire(import.meta.url);
const BETTER_SQLITE3 = require("better-sqlite3");
const SQLITE_VEC = require("sqlite-vec");

const DEFAULT_EMBEDDING_DIM = 1024;
const dbPath = process.env.HOME + "/.cache/qmd/index.sqlite";

console.log(`Migrating vectors in ${dbPath}...`);

// Phase 1: Read vec0 data with better-sqlite3
const bs3 = new BETTER_SQLITE3(dbPath);
SQLITE_VEC.load(bs3);

const tableInfo = bs3.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'",
).get();

if (!tableInfo) {
  console.log("No vectors_vec table found. Nothing to migrate.");
  process.exit(0);
}

if (!tableInfo.sql.includes("USING vec0")) {
  console.log("vectors_vec already migrated (not vec0 format).");
  process.exit(0);
}

const dimMatch = tableInfo.sql.match(/float\[(\d+)\]/);
const dimensions = dimMatch?.[1] ? parseInt(dimMatch[1], 10) : DEFAULT_EMBEDDING_DIM;
console.log(`vec0 table found (${dimensions}d)`);

// Read all vectors into memory
const rows = bs3.prepare("SELECT hash_seq, embedding FROM vectors_vec").all();
console.log(`Read ${rows.length} vectors into memory`);

// Drop vec0 table using better-sqlite3
bs3.exec("DROP TABLE vectors_vec");
console.log("Dropped vec0 virtual table");
bs3.close();

// Phase 2: Create FLOAT32 table + insert with libsql
const db = new Database(dbPath);

db.exec(
  `CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding FLOAT32(${dimensions}))`,
);
db.exec(
  `CREATE INDEX vectors_vec_idx ON vectors_vec (libsql_vector_idx(embedding))`,
);
console.log(`Created FLOAT32(${dimensions}) table + vector index`);

// Insert vectors
const insert = db.prepare(
  "INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)",
);

const insertMany = db.transaction((vecs) => {
  for (const row of vecs) {
    // Pass Float32Array directly — libsql accepts it natively
    const float32 = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    insert.run(row.hash_seq, float32);
  }
});

insertMany(rows);
console.log(`Inserted ${rows.length} vectors into FLOAT32 table`);

// Verify
const count = db.prepare("SELECT count(*) as c FROM vectors_vec").get();
console.log(`Verification: ${count.c} vectors in new table`);

if (count.c !== rows.length) {
  console.error(`ERROR: Expected ${rows.length} rows, got ${count.c}`);
  process.exit(1);
}

db.close();
console.log("Migration complete!");
