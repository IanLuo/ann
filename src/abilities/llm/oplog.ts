import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime operational log (design §4 — TWO distinct logs): the dynamic process —
 * requests sent (provider/model), errors, timing, retries. NOT project state,
 * never in the tree. The forest holds project state, not request noise.
 */

export interface OpLogEntry {
  at: string;
  provider: string;
  model: string;
  promptChars: number;
  maxTokens: number;
  ok: boolean;
  latencyMs: number;
  /** Retries consumed before this outcome (0 = first attempt). */
  retries: number;
  error?: { code: string; blocker: string };
}

export function writeOpLog(root: string, entry: OpLogEntry): void {
  const dir = join(root, 'logs');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'provider.jsonl'), JSON.stringify(entry) + '\n');
}
