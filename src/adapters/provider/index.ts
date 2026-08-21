import { OpenAICompatibleAdapter } from './http.js';
import { loadProviderRegistry } from './registry.js';
import { ProviderAdapter } from './types.js';

export * from './types.js';
export { loadProviderRegistry, resolveSetting, resetProviderRegistryCache } from './registry.js';
export type { ProviderDefaults, ProviderEntry, ProviderRegistry } from './registry.js';
export { writeOpLog } from './oplog.js';
export type { OpLogEntry } from './oplog.js';

/** Resolve the adapter for a provider id (default = the registry default, F17).
 *  Unknown provider → fail-closed with the unknown id NAMED — never a silent
 *  fallback (resource-registry: consumers read, never hardcode). */
export function getAdapter(provider?: string, logRoot: string = process.cwd()): ProviderAdapter {
  const reg = loadProviderRegistry(logRoot);
  const id = provider ?? reg.defaultProvider;
  const entry = reg.providers.find((p) => p.id === id);
  if (!entry) {
    throw new Error(
      `provider '${id}' is not in rules/adapter/provider.json (fail-closed: unknown provider named — add it to the registry or pass a known id)`,
    );
  }
  return new OpenAICompatibleAdapter(entry, reg.defaults, logRoot);
}
