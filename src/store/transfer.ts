import type { JourneyEvent } from './store.js';

/**
 * THE TRANSFER'S SCOPE — the internal shape of `transferred.scope`, in ONE place
 * (leg 12 task 12).
 *
 * The FORMAT declares `scope` as VERBATIM free text and the writer checks only that it is
 * a string (store.ts `validateEventShape`). That is the right shape for a RECORD — nothing
 * may paraphrase what was moved — but it is not a shape anything can be CREDITED against:
 * a concatenated verbatim blob is not parseable, so 12/12's close rule (an AC moved to a
 * successor is satisfied-by-transfer) has nothing to match on.
 *
 * SO THE CONVENTION IS THE SHAPE, and it lives here, read by the ONE writer that validates
 * it (`Commands.gate`) and the ONE reader that credits it (`Commands.conclusion`):
 *
 *     AC-1: <the acceptance criterion, verbatim>
 *     AC-3: <the acceptance criterion, verbatim>
 *
 * — ONE AC PER LINE, the id first. The TEXT stays verbatim (it is the record); the ID is
 * what credit is matched on, the same `AC-n` id `conclusion()` already addresses ACs by
 * (positional, 1-based). A line that names no AC credits nothing and is not an error: a
 * transfer of residual scope that maps to no criterion is a real, honest record — it just
 * cannot satisfy one, and the close then names the ACs that are neither claimed nor
 * transferred.
 */

/** The AC id at the head of a scope line — `AC-2: …`, `ac-2 : …`, `AC-2 …`. */
const AC_LINE = /^\s*ac[-\s]?(\d+)\s*[:\-–]?/i;

/** THE ACs A SCOPE NAMES, normalised to `AC-n`, deduped, in first-appearance order.
 *  Nothing else about the line is read — the text after the id is the record's. */
export function scopeAcs(scope: string): string[] {
  const out: string[] = [];
  for (const line of scope.split('\n')) {
    const m = line.match(AC_LINE);
    if (!m) continue;
    const id = `AC-${Number(m[1])}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * EVERY AC MOVED OFF THIS NODE, and where it went: `AC-n` → the transfer target. The LAST
 * transfer naming an AC wins — an append-only log's rework reading, the same one claims
 * take (a later record supersedes an earlier one for the same subject). Derived from the
 * event tail, never stored: the credit is a READ of what the record already holds.
 */
export function transferCredit(events: JourneyEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'transferred') continue;
    if (typeof e.target !== 'string' || !e.target.trim()) continue;
    if (typeof e.scope !== 'string') continue;
    for (const ac of scopeAcs(e.scope)) out.set(ac, e.target);
  }
  return out;
}
