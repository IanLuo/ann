import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime operational log (design §4 — TWO distinct logs): the dynamic process —
 * requests sent (provider/model), errors, timing, retries. NOT project state,
 * never in the tree. The forest holds project state, not request noise.
 */

export interface OpLogEntry {
  at: string;
  /** THE CORRELATION (leg 12/05 + its rework): the SAME `traceId` (the causal chain) and
   *  `runId` (the run within it) the operational log (abilities/obs/log.ts) records, so
   *  `ann log --trace <id>` and this file join into ONE timeline — the provider calls are
   *  the model-call leaf of the chain. Absent when the caller had no run (a library use). */
  traceId?: string;
  runId?: string;
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
