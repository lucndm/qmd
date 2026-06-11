import { homedir as osHomedir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

export function qmdHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || osHomedir() || "/tmp";
}

/**
 * Return the inbox directory path (~/.cache/qmd/inbox/), creating it if missing.
 * Inbox is the default landing zone for uploaded documents without a target collection.
 */
export function getInboxDir(): string {
  const cacheDir = process.env.XDG_CACHE_HOME || resolve(qmdHomedir(), ".cache");
  const inboxDir = resolve(cacheDir, "qmd", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  return inboxDir;
}
