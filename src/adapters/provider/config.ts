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

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface UserConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** The API key — masked in every display; never logged. */
  apiKey?: string;
  maxTokens?: number;
  /** Known projects — each has its OWN journey (ann is a multi-project tool). */
  projects?: ProjectEntry[];
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
export function setConfig(key: keyof UserConfig, value: string | number | ProjectEntry[]): UserConfig {
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

/* ---------------- project management (each project has its own journey) ---------------- */

export function listProjects(): ProjectEntry[] {
  return loadConfig().projects ?? [];
}

export function findProject(name: string): ProjectEntry | undefined {
  return listProjects().find((p) => p.name === name);
}

export function getCurrentProject(): ProjectEntry | undefined {
  const name = loadConfig().currentProject;
  return name ? findProject(name) : undefined;
}

/** Register (or update) a known project. */
export function setProject(name: string, path: string): UserConfig {
  const projects = [...listProjects().filter((p) => p.name !== name), { name, path }];
  return setConfig('projects', projects);
}

export function useProject(name: string): UserConfig {
  if (!findProject(name)) throw new Error(`project '${name}' not found — add it first (ann project! add ${name} <path>)`);
  return setConfig('currentProject', name);
}

export function removeProject(name: string): UserConfig {
  const projects = listProjects().filter((p) => p.name !== name);
  setConfig('projects', projects);
  if (loadConfig().currentProject === name) return setConfig('currentProject', '');
  return loadConfig();
}
