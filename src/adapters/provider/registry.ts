import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Resolve a setting that may be 'env:NAME' or 'env:NAME || literal-fallback'.
 *  A bare literal passes through. Returns undefined only when no env var is set
 *  and no fallback exists. */
export function resolveSetting(spec: string): string | undefined {
  if (!spec.startsWith('env:')) return spec;
  for (const part of spec.slice(4).split('||').map((p) => p.trim())) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      const v = process.env[part];
      if (v !== undefined && v !== '') return v;
    } else {
      return part; // literal fallback
    }
  }
  return undefined;
}

let cached: ProviderRegistry | null = null;

export function loadProviderRegistry(root: string = process.cwd()): ProviderRegistry {
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(join(root, 'rules', 'adapter', 'provider.json'), 'utf8');
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
