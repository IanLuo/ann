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
export declare function loadVocab(root: string): Vocab;
/** Module-level vocab, loaded from the repo root (process.cwd()). */
export declare const VOCAB: Vocab;
