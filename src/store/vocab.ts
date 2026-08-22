import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The vocab registry (resource-registry spec, instance #2): the single source of
 * truth for schema vocabulary — event types, statuses, gates, artifact types.
 * Consumers read; never hardcode. Missing = misconfigured (fail loudly).
 */
export interface Vocab {
  eventTypes: string[];
  statuses: string[];
  gates: string[];
  artifactTypes: string[];
}

export function loadVocab(root: string): Vocab {
  try {
    const raw = readFileSync(join(root, 'rules', 'schema', 'vocab.json'), 'utf8');
    return JSON.parse(raw) as Vocab;
  } catch {
    throw new Error(
      'vocab registry missing/invalid: rules/schema/vocab.json — the single source of truth for schema vocabulary (resource-registry spec)',
    );
  }
}

/** Module-level vocab, loaded from the repo root (process.cwd()). */
/** Lazy-load the vocab registry at first use — the CLI resolves the PROJECT ROOT and
 *  chdirs BEFORE any store/vocab access, so running `ann project …` from outside a
 *  project must not crash on load (process.cwd() is only valid once chdir'd). */
let cached: Vocab | undefined;
export const getVOCAB = (): Vocab => (cached ??= loadVocab(process.cwd()));
