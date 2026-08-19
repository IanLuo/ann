import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function loadVocab(root) {
    try {
        const raw = readFileSync(join(root, 'rules', 'schema', 'vocab.json'), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        throw new Error('vocab registry missing/invalid: rules/schema/vocab.json — the single source of truth for schema vocabulary (resource-registry spec)');
    }
}
/** Module-level vocab, loaded from the repo root (process.cwd()). */
export const VOCAB = loadVocab(process.cwd());
