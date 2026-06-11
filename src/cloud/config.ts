import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { qmdHomedir } from "../paths.js";
import YAML from "yaml";

export interface RemoteConfig {
  url: string;
  token: string;
}

export interface CloudConfig {
  default_remote: string;
  remotes: Record<string, RemoteConfig>;
}

export function getCloudConfigDir(): string {
  if (process.env.QMD_CONFIG_DIR) {
    return process.env.QMD_CONFIG_DIR;
  }
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "qmd");
  }
  return join(qmdHomedir(), ".config", "qmd");
}

export function getCloudConfigPath(): string {
  return join(getCloudConfigDir(), "cloud.yml");
}

export function loadCloudConfig(): CloudConfig | null {
  try {
    const path = getCloudConfigPath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      default_remote: parsed.default_remote ?? "default",
      remotes: parsed.remotes ?? {},
    };
  } catch {
    return null;
  }
}

export function saveCloudConfig(config: CloudConfig): void {
  const path = getCloudConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const raw = YAML.stringify({
    default_remote: config.default_remote,
    remotes: config.remotes,
  });
  writeFileSync(path, raw, "utf-8");
}

export function getRemote(name?: string): RemoteConfig | null {
  const config = loadCloudConfig();
  if (!config) return null;
  const remoteName = name ?? config.default_remote;
  return config.remotes[remoteName] ?? null;
}

export function resolveRemoteName(name?: string): string {
  const config = loadCloudConfig();
  if (!config) return name ?? "default";
  return name ?? config.default_remote;
}
