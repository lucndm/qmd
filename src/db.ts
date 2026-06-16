/**
 * db.ts - Cross-runtime SQLite compatibility layer
 *
 * Node.js: uses `libsql` — a better-sqlite3-compatible sync API with
 * native vector support (FLOAT32, vector_top_k) and embedded replica.
 * Bun: uses bun:sqlite + sqlite-vec extension.
 *
 * Both paths expose the same Database interface so the rest of QMD
 * does not care which driver is loaded.
 */

export const isBun = "Bun" in globalThis;

export type SQLiteValue =
  | string
  | number
  | bigint
  | Buffer
  | Uint8Array
  | Float32Array
  | null;
export type SQLiteParams = readonly SQLiteValue[];

type DatabaseConstructor = new (
  path: string,
  opts?: Record<string, unknown>,
) => Database;
type LoadableSqliteDatabase = Pick<Database, "loadExtension">;

let _Database: DatabaseConstructor;
let _sqliteVecLoad: ((db: LoadableSqliteDatabase) => void) | null;

if (isBun) {
  const bunSqlite = "bun:" + "sqlite";
  const BunDatabase = (await import(/* @vite-ignore */ bunSqlite)).Database;

  if (process.platform === "darwin") {
    const homebrewPaths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ];
    for (const p of homebrewPaths) {
      try {
        BunDatabase.setCustomSQLite(p);
        break;
      } catch {}
    }
  }

  _Database = BunDatabase;

  try {
    const { getLoadablePath } = await import("sqlite-vec");
    const vecPath = getLoadablePath();
    const testDb = new BunDatabase(":memory:");
    testDb.loadExtension(vecPath);
    testDb.close();
    _sqliteVecLoad = (db: LoadableSqliteDatabase) => db.loadExtension(vecPath);
  } catch {
    _sqliteVecLoad = null;
  }
} else {
  const LibsqlDatabase = (await import("libsql"))
    .default as unknown as DatabaseConstructor;
  _Database = LibsqlDatabase;
  // libSQL has native vector support — no sqlite-vec extension needed
  _sqliteVecLoad = null;
}

/**
 * Options for embedded replica mode (libsql only).
 * When syncUrl is set, the local DB file auto-replicates with the remote Turso DB.
 */
export interface ReplicaOptions {
  syncUrl?: string;
  authToken?: string;
  syncPeriod?: number;
}

/**
 * Open a SQLite database.
 * On Node.js: opens via libsql (supports native vectors + embedded replica).
 * On Bun: opens via bun:sqlite.
 *
 * When opts.syncUrl is provided, the database operates as an embedded replica
 * that automatically syncs with the remote Turso/libSQL server.
 */
export function openDatabase(path: string, opts?: ReplicaOptions): Database {
  if (!isBun && opts?.syncUrl) {
    // libsql embedded replica mode
    try {
      return new _Database(path, {
        syncUrl: opts.syncUrl,
        authToken: opts.authToken,
        syncPeriod: opts.syncPeriod ?? 60,
      }) as Database;
    } catch (err) {
      // Existing DB without replica metadata — fall back to standalone
      // This happens when upgrading an existing QMD installation
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("wal_index") || msg.includes("metadata")) {
        process.stderr.write(
          `[qmd] Embedded replica unavailable (existing DB needs reset). Using standalone mode.\n` +
            `[qmd] To enable replica: delete ${path} and restart.\n`,
        );
        return new _Database(path) as Database;
      }
      throw err;
    }
  }
  return new _Database(path) as Database;
}

/**
 * Common subset of the Database interface used throughout QMD.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  transaction<T extends (...args: SQLiteValue[]) => unknown>(fn: T): T;
  close(): void;
  /** Trigger manual replica sync (libsql embedded replica only). */
  sync?(): Promise<unknown>;
}

export interface Statement {
  run(...params: SQLiteValue[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  get<T = unknown>(...params: SQLiteValue[]): T | undefined;
  all<T = unknown>(...params: SQLiteValue[]): T[];
}

/**
 * Load the sqlite-vec extension into a database (Bun only).
 * On Node.js with libsql, vector operations are built-in — this is a no-op.
 */
export function loadSqliteVec(db: Database): void {
  if (!_sqliteVecLoad) {
    if (!isBun) return; // libsql has native vectors — no-op
    const hint =
      process.platform === "darwin"
        ? "On macOS with Bun, install Homebrew SQLite: brew install sqlite\n" +
          "Or install qmd with npm instead: npm install -g @tobilu/qmd"
        : "Ensure the sqlite-vec native module is installed correctly.";
    throw new Error(`sqlite-vec extension is unavailable. ${hint}`);
  }
  _sqliteVecLoad(db);
}
