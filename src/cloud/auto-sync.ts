/**
 * Auto-sync: periodic background push for multi-instance Turso sync.
 *
 * Activated by QMD_SYNC_INTERVAL env var (seconds, 0 = disabled).
 * Uses QMD_SYNC_REMOTE env var for remote name (default: first remote in cloud.yml).
 *
 * Push-only: pull swaps the DB file which would break the live MCP server's
 * connection. Pull should be done manually or at container startup.
 */

import { getRemote, resolveRemoteName } from "./config.js";
import { createCloudClient, type CloudClient } from "./client.js";
import { pushToRemote } from "./push.js";
import type { Database } from "../db.js";

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let dbGetter: (() => Database) | null = null;

export function isAutoSyncEnabled(): boolean {
  const raw = process.env.QMD_SYNC_INTERVAL;
  if (!raw) return false;
  return parseInt(raw, 10) > 0;
}

function getSyncIntervalMs(): number {
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
    return getRemote(name) ? name : null;
  } catch {
    return null;
  }
}

async function doSyncCycle(
  remoteName: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!dbGetter) return;
  const remote = getRemote(remoteName);
  if (!remote) return;

  const client: CloudClient = await createCloudClient(remote);
  try {
    const db = dbGetter();
    const pushResult = await pushToRemote(db, client);
    const totalRows = Object.values(pushResult.tables).reduce(
      (sum, t) => sum + t.rows,
      0,
    );
    log(`auto-sync: push ${totalRows} rows (${pushResult.durationMs}ms)`);
  } finally {
    client.close();
  }
}

export function startAutoSync(getDb: () => Database): void {
  const intervalMs = getSyncIntervalMs();
  if (intervalMs <= 0) return;

  const remoteName = getSyncRemoteName();
  if (!remoteName) return;

  dbGetter = getDb;

  const log = (msg: string) => {
    process.stderr.write(`[qmd] ${new Date().toISOString()} ${msg}\n`);
  };

  log(
    `auto-sync: started (interval=${intervalMs / 1000}s, remote=${remoteName})`,
  );

  const runCycle = async () => {
    try {
      await doSyncCycle(remoteName, log);
    } catch (err) {
      log(
        `auto-sync: error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    syncTimer = setTimeout(runCycle, intervalMs);
  };

  syncTimer = setTimeout(runCycle, 5000);
}

export function stopAutoSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}
