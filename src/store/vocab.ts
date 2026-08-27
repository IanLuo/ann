import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The vocab registry (resource-registry spec, instance #2): the single source of
 * truth for schema vocabulary — event types, statuses, gates, artifact types.
 * Consumers read; never hardcode. Missing = misconfigured (fail loudly).
 *
 * DATA-OR-CODE IS PER KEY (resource-registry v3 §5): `artifactTypes` is ADJUSTABLE
 * DATA — each entry carries the `docs/` CATEGORY it places into and whether it takes
 * a `-v<N>` filename (format v14 §14/§15), which is what makes artifact placement
 * derivable from the TYPE. `eventTypes` / `statuses` / the gate set and positions are
 * PROTECTED — the store enforces them as code literals (a knowing duplicate of this
 * registry, recorded as a reconciliation).
 */

/** An artifact type's placement rule. No `category` = TASK-LOCAL (a real file in the
 *  task's `artifacts/`, never versioned, never in the shared contract stack). */
export interface ArtifactTypeEntry {
  category?: string;
  versioned: boolean;
}

export interface Vocab {
  eventTypes: string[];
  statuses: string[];
  gates: string[];
  artifactTypes: Record<string, ArtifactTypeEntry>;
}

export function loadVocab(root: string): Vocab {
  const rel = join(root, '.ann', 'rules', 'schema', 'vocab.json');
  const legacy = join(root, 'rules', 'schema', 'vocab.json');
  const file = readFileSync(existsSync(rel) ? rel : legacy, 'utf8'); // v12: .ann/rules (legacy rules/ accepted)
  const raw = JSON.parse(file) as Omit<Vocab, 'artifactTypes'> & { artifactTypes: unknown };
  // A pre-v3 registry lists artifactTypes as bare strings — read as task-local entries
  // (no category, unversioned): the type stays known, placement simply has no rule.
  const types = Array.isArray(raw.artifactTypes)
    ? Object.fromEntries((raw.artifactTypes as string[]).map((t) => [t, { versioned: false }]))
    : (raw.artifactTypes as Record<string, ArtifactTypeEntry>);
  return { ...raw, artifactTypes: types };
}

/** Module-level vocab, loaded from the repo root (process.cwd()). */
/** Lazy-load the vocab registry at first use — the CLI resolves the PROJECT ROOT and
 *  chdirs BEFORE any store/vocab access, so running `ann project …` from outside a
 *  project must not crash on load (process.cwd() is only valid once chdir'd). */
let cached: Vocab | undefined;
export const getVOCAB = (): Vocab => (cached ??= loadVocab(process.cwd()));

