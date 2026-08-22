import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * The USER CONFIG FILE — the local app's settings, including (optionally) the secret.
 *
 * Location: `~/.config/ann/config.json` (override with `ANN_CONFIG` — used by tests
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
}

export const configPath = (): string => process.env.ANN_CONFIG || join(homedir(), '.config', 'ann', 'config.json');

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
export function setConfig(key: keyof UserConfig, value: string | number): UserConfig {
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
