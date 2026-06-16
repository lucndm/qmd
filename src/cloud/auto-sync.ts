/**
 * Auto-sync: periodic background pull + push for multi-instance Turso sync.
 *
 * Activated by QMD_SYNC_INTERVAL env var (seconds, 0 = disabled).
 * Uses QMD_SYNC_REMOTE env var for remote name (default: first remote in cloud.yml).
 */

import { getRemote, resolveRemoteName } from "./config.js";
import { createCloudClient, type CloudClient } from "./client.js";
import { pushToRemote } from "./push.js";
import { openDatabase } from "../db.js";
import { getDefaultDbPath } from "../store.js";

let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function isAutoSyncEnabled(): boolean {
  const raw = process.env.QMD_SYNC_INTERVAL;
  if (!raw) return false;
  const seconds = parseInt(raw, 10);
  return seconds > 0;
}

export function getSyncIntervalMs(): number {
  const raw = process.env.QMD_SYNC_INTERVAL;
  if (!raw) return 0;
  const seconds = parseInt(raw, 10);
  return seconds > 0 ? seconds * 1000 : 0;
}

function getSyncRemoteName(): string | null {
  const envName = process.env.QMD_SYNC_REMOTE;
  if (envName) return envName;

  try {
    const name = resolveRemoteName();
    const remote = getRemote(name);
    return remote ? name : null;
  } catch {
    return null;
  }
}

async function doSyncCycle(
  dbPath: string,
  remoteName: string,
  log: (msg: string) => void,
): Promise<void> {
  const remote = getRemote(remoteName);
  if (!remote) {
    log(`auto-sync: remote "${remoteName}" not found`);
    return;
  }

  const client: CloudClient = await createCloudClient(remote);
  try {
    // Push only — pull swaps the DB file which would break the live MCP
    // server's open connection. Pull should be done manually or at startup.
    const db = openDatabase(dbPath);
    try {
      const pushResult = await pushToRemote(db, client);
      const totalRows = Object.values(pushResult.tables).reduce(
        (sum, t) => sum + t.rows,
        0,
      );
      log(`auto-sync: push ${totalRows} rows (${pushResult.durationMs}ms)`);
    } finally {
      db.close();
    }
  } finally {
    client.close();
  }
}

/**
 * Start background auto-sync. Does an initial cycle immediately,
 * then repeats every QMD_SYNC_INTERVAL seconds.
 *
 * No-op if QMD_SYNC_INTERVAL is not set or <= 0.
 */
export function startAutoSync(dbPath?: string): void {
  const intervalMs = getSyncIntervalMs();
  if (intervalMs <= 0) return;

  const resolvedDbPath = dbPath ?? getDefaultDbPath();
  const remoteName = getSyncRemoteName();
  if (!remoteName) return;

  const log = (msg: string) => {
    // Stderr so it doesn't corrupt stdio MCP protocol
    process.stderr.write(`[qmd] ${new Date().toISOString()} ${msg}\n`);
  };

  log(
    `auto-sync: started (interval=${intervalMs / 1000}s, remote=${remoteName})`,
  );

  // Initial sync after a short delay (let MCP server finish startup)
  const runCycle = async () => {
    try {
      await doSyncCycle(resolvedDbPath, remoteName, log);
    } catch (err) {
      log(
        `auto-sync: error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Schedule next cycle
    syncTimer = setTimeout(runCycle, intervalMs);
  };

  syncTimer = setTimeout(runCycle, 5000);
}

/**
 * Stop background auto-sync timer.
 */
export function stopAutoSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}
