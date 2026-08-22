import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * The USER CONFIG FILE — the local app's settings, including (optionally) the secret.
 *
 * Location: `~/.ann/config.json` (override with `ANN_CONFIG` — used by tests
 * and packaging). It is OUTSIDE the repo (never committed) and chmod 600 (user-only).
 *
 * Trust model (local-first): the same as ~/.aws/credentials / ~/.env — plaintext at
 * rest, acceptable for a LOCAL app; the OS keychain remains the more-secure option
 * for the secret. The apiKey is MASKED in every display; env (deployment override)
 * beats config; config beats registry fallbacks.
 *
 * Resolution order per setting: env → user config → keychain (secrets only) → registry fallback.
 */

export interface UserConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** The API key — masked in every display; never logged. */
  apiKey?: string;
  maxTokens?: number;
  /** Known project PATHS — each has its OWN journey. Paths only, no names (a path is unambiguous). */
  projects?: string[];
  /** The last-used project path (fallback when cwd discovery finds none). */
  currentProject?: string;
}

export const configPath = (): string => process.env.ANN_CONFIG || join(homedir(), '.ann', 'config.json');

let cached: UserConfig | undefined;

export function loadConfig(): UserConfig {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(configPath(), 'utf8');
    cached = JSON.parse(raw) as UserConfig;
  } catch {
    cached = {}; // absent or unparseable → empty config (env/fallbacks still apply)
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

/** Save one config value — creates the file, chmod 600 (user-only), never echoed. */
export function setConfig(key: keyof UserConfig, value: string | number | string[]): UserConfig {
  const cfg = { ...loadConfig(), [key]: value };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  cached = cfg;
  return cfg;
}

/** Masked view for display — the apiKey never appears. */
export function maskedConfig(): Record<string, string | number> {
  const cfg = loadConfig();
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined) continue;
    out[k] = k === 'apiKey' ? 'SET (masked)' : v;
  }
  return out;
}

export const configExists = (): boolean => existsSync(configPath());

/* ---------------- project management (each project has its own journey) ----------------
 * Projects are identified by PATH only — no names (a path is unambiguous). */

/** Known project paths. Legacy shape ({name, path}[]) is normalized on read. */
export function listProjects(): string[] {
  const p = loadConfig().projects ?? [];
  return p.map((x) => (typeof x === 'string' ? x : (x as { path?: string }).path ?? '')).filter(Boolean);
}

export function getCurrentProject(): string | undefined {
  return loadConfig().currentProject || undefined;
}

/** Register (or update) a project path. */
export function setProject(path: string): UserConfig {
  const projects = [...listProjects().filter((p) => p !== path), path];
  return setConfig('projects', projects);
}

export function useProject(path: string): UserConfig {
  return setConfig('currentProject', path);
}

export function removeProject(path: string): UserConfig {
  const projects = listProjects().filter((p) => p !== path);
  setConfig('projects', projects);
  if (loadConfig().currentProject === path) return setConfig('currentProject', '');
  return loadConfig();
}
