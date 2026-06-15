import { createClient, type Client, type InValue } from "@libsql/client";
import type { RemoteConfig } from "./config.js";

export interface CloudClient {
  execute(
    sql: string,
    args?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  batch(
    statements: { sql: string; args?: unknown[] }[],
  ): Promise<{ rows: Record<string, unknown>[] }[]>;
  close(): void;
}

interface TokenCache {
  token: string;
  expires: number;
}

let tokenCache: TokenCache | null = null;

export async function resolveDbToken(
  apiToken: string,
  hostname: string,
): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now()) {
    return tokenCache.token;
  }
  const dbName = await resolveDbName(apiToken, hostname);
  const apiUrl = `https://api.turso.tech/v1/databases/${dbName}/auth/tokens`;
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to get DB token (${resp.status}): ${body}`);
  }
  const data = (await resp.json()) as { jwt: string };
  tokenCache = { token: data.jwt, expires: Date.now() + 23 * 60 * 60 * 1000 };
  return data.jwt;
}

async function resolveDbName(
  apiToken: string,
  hostname: string,
): Promise<string> {
  const resp = await fetch("https://api.turso.tech/v1/databases", {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to list databases (${resp.status})`);
  }
  const data = (await resp.json()) as {
    databases: { Name: string; Hostname: string }[];
  };
  const match = data.databases.find((db) => db.Hostname === hostname);
  if (!match) {
    throw new Error(`No database found matching hostname ${hostname}`);
  }
  return match.Name;
}

export async function createCloudClient(
  remote: RemoteConfig,
): Promise<CloudClient> {
  const url = normalizeUrl(remote.url);
  // Token works directly for both self-hosted libSQL and Turso cloud.
  // @libsql/client handles Turso auth tokens natively — no API resolution needed.
  const authToken = remote.token;

  const client: Client = createClient({ url, authToken });
  return {
    async execute(sql: string, args?: unknown[]) {
      const result = await client.execute({
        sql,
        args: (args as InValue[]) ?? [],
      });
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async batch(statements: { sql: string; args?: unknown[] }[]) {
      const results = await client.batch(
        statements.map((s) => ({
          sql: s.sql,
          args: (s.args as InValue[]) ?? [],
        })),
      );
      return results.map((r) => ({
        rows: r.rows as Record<string, unknown>[],
      }));
    },
    close() {
      client.close();
    },
  };
}

export async function validateConnection(
  remote: RemoteConfig,
): Promise<{ ok: boolean; error?: string; serverInfo?: string }> {
  try {
    const client = await createCloudClient(remote);
    const result = await client.execute("SELECT sqlite_version() as version");
    client.close();
    const version = result.rows[0]?.version ?? "unknown";
    return { ok: true, serverInfo: `SQLite ${version}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function normalizeUrl(url: string): string {
  if (url.startsWith("libsql://")) {
    return url.replace("libsql://", "https://");
  }
  return url;
}
