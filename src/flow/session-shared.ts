import { AdapterError } from '../abilities/llm/index.js';
import { InteractAbort } from './types.js';

/**
 * SHARED MECHANICS of the interactive grilling SESSIONS — the byte-level machinery
 * both session loops genuinely duplicate, extracted so a fix lands ONCE:
 *
 *   - the portable core session (src/flow/grill-session.ts — the GrillSession loop that
 *     the goal/design areas run on), and
 *   - the task idea-validate session (src/flow/steps/idea-validate/session.ts).
 *
 * The loops' SEMANTICS stay deliberately separate (see goal-grill.ts on why the goal
 * loop is NOT the idea-validate loop); this module carries only what both need IDENTICAL:
 * the unresolved-answer markers, counter-deduped provenance labeling, and the fail-closed
 * human-channel wrapper. Nothing here knows about 'goal', 'design', or any area.
 */

/** Answers that do not resolve anything (a skip, a pass, an empty reply). */
export const UNRESOLVED_MARKERS = [
  'unknown',
  'skip',
  'not sure',
  'unsure',
  'n/a',
  'na',
  'dont know',
  "don't know",
  '',
] as const;

/** An answer that RESOLVES nothing (a skip/pass/empty) — the question stays open. */
export const isUnresolved = (a: string): boolean =>
  (UNRESOLVED_MARKERS as readonly string[]).includes(a.trim().toLowerCase());

/** COUNTER-DEDUPED provenance labels — every grounding label is unique, so a later
 *  model citation can never silently bind to an EARLIER duplicate. `base` (e.g.
 *  `answer:q1`) is used as-is the first time; a repeat becomes `base-2`, `base-3`, ….
 *  Seed with the labels that already exist (prior context) so a new label never
 *  collides with an old one. This is the fix for the idea-validate answer:qN collision
 *  (the grilling engine restarts question ids at q1 on EVERY engine call — without
 *  dedupe, round N's fresh `answer:q1` would shadow round 1's in the grounding map). */
export type GroundingLabeler = (base: string) => string;
export const makeDedupeLabeler = (existing: Iterable<string>): GroundingLabeler => {
  const used = new Set(existing);
  return (base: string): string => {
    let label = base;
    for (let i = 2; used.has(label); i++) label = `${base}-${i}`;
    used.add(label);
    return label;
  };
};

/** The human-channel outcome — every channel call is wrapped so a failure is a VALUE
 *  (fail-closed), never a throw: an {@link InteractAbort} (the human walked away) is
 *  distinguished from a real channel failure. Each loop maps the two arms to its OWN
 *  end semantics (the idea-validate session records a reject with a full doc; the
 *  portable core returns a reject/ok:false result). */
export type ChannelOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'abort' }
  | { kind: 'error'; error: AdapterError };

/** Wrap ONE interact-channel call. `what` names the channel for the fail-closed blocker
 *  (e.g. `'goal grill: the human channel failed'` — the caller's phrasing, since each
 *  session names its own subject). Provider/interactor failures fail CLOSED. */
export const humanChannel = async <T>(what: string, run: () => Promise<T>): Promise<ChannelOutcome<T>> => {
  try {
    return { kind: 'value', value: await run() };
  } catch (e) {
    if (e instanceof InteractAbort) return { kind: 'abort' };
    return { kind: 'error', error: { code: 'provider-unavailable', blocker: `${what} — ${(e as Error).message}` } };
  }
};
