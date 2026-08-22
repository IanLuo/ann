import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import type { UserConfig } from './config.js';

/**
 * The provider registry (resource-registry spec, category `adapter`): the single
 * source of truth for LLM providers/models + defaults (F17). Consumers read;
 * never hardcode. Missing/misconfigured = fail loudly at load — the registry is
 * configuration, and a silent default would be a fabricated decision.
 */

export interface ProviderDefaults {
  maxTokens: number;
  temperature: number;
  retries: number;
  backoffMs: number;
  backoffMaxMs: number;
  timeoutMs: number;
}

export interface ProviderEntry {
  id: string;
  kind: 'http';
  protocol: string;
  /** Literal URL or 'env:NAME || literal-fallback'. */
  baseUrl: string;
  /** Literal or 'env:NAME' — omitted providers send no auth header (their server decides). */
  apiKey?: string;
  /** Literal or 'env:NAME || literal-fallback'; overridable per call (task grain). */
  defaultModel: string;
}

export interface ProviderRegistry {
  registry: string;
  defaultProvider: string;
  providers: ProviderEntry[];
  defaults: ProviderDefaults;
}

/** Resolve a setting that may be 'env:NAME || literal-fallback'. Resolution:
 *  env (the NAME, deployment override) → user config (configKey, the local app's
 *  settings file) → the literal fallback. Returns undefined only when none exist. */
export function resolveSetting(spec: string, configKey?: keyof UserConfig): string | undefined {
  if (!spec.startsWith('env:')) return spec;
  const fallbacks: string[] = [];
  for (const part of spec.slice(4).split('||').map((p) => p.trim())) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      const v = process.env[part];
      if (v !== undefined && v !== '') return v; // env wins (deployment override)
    } else {
      fallbacks.push(part);
    }
  }
  if (configKey) {
    const v = loadConfig()[configKey];
    if (v !== undefined && v !== '') return String(v); // user config file
  }
  return fallbacks[0];
}

let cached: ProviderRegistry | null = null;

export function loadProviderRegistry(root: string = process.cwd()): ProviderRegistry {
  if (cached) return cached;
  let raw: string;
  const rel = join(root, '.ann', 'rules', 'adapter', 'provider.json');
  const legacy = join(root, 'rules', 'adapter', 'provider.json');
  try {
    raw = readFileSync(existsSync(rel) ? rel : legacy, 'utf8'); // v12: .ann/rules (legacy rules/ accepted)
  } catch {
    throw new Error(
      'provider registry missing: rules/adapter/provider.json — the single source of truth for LLM providers (resource-registry spec, category adapter)',
    );
  }
  const reg = JSON.parse(raw) as ProviderRegistry;
  if (!Array.isArray(reg.providers) || reg.providers.length === 0) {
    throw new Error('provider registry misconfigured: providers[] must be non-empty (resource-registry spec — fail loudly, never hardcode)');
  }
  for (const p of reg.providers) {
    if (!p.id || !p.baseUrl || !p.defaultModel) {
      throw new Error(`provider registry misconfigured: entry '${p?.id ?? '(no id)'}' needs id, baseUrl, defaultModel`);
    }
    // v1 transport = the OpenAI-compatible client (design TS-6). A registry entry
    // for another kind would silently run through the wrong transport — refuse it.
    if (p.kind !== 'http') {
      throw new Error(`provider registry misconfigured: entry '${p.id}' kind '${p.kind}' is not supported in v1 (only 'http' — OpenAI-compatible, design TS-6). Refusing silently wrong transport.`);
    }
  }
  if (!reg.defaultProvider || !reg.providers.some((p) => p.id === reg.defaultProvider)) {
    throw new Error(`provider registry misconfigured: defaultProvider '${reg.defaultProvider}' is not in providers[]`);
  }
  const d = reg.defaults;
  if (!d || typeof d !== 'object') {
    throw new Error('provider registry misconfigured: defaults (maxTokens/temperature/retries/backoffMs/backoffMaxMs/timeoutMs) are required');
  }
  for (const k of ['maxTokens', 'temperature', 'retries', 'backoffMs', 'backoffMaxMs', 'timeoutMs']) {
    const v = (d as unknown as Record<string, unknown>)[k];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(`provider registry misconfigured: defaults.${k} must be a number — a silent NaN would corrupt retry/backoff`);
    }
  }
  cached = reg;
  return reg;
}

/** Test seam: drop the module cache so a fresh registry (or a modified file) reloads. */
export function resetProviderRegistryCache(): void {
  cached = null;
}
