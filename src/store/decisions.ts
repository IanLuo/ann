import { GATE_DECISION_EVENTS, GATE_ORDER, gateView } from './workflow.js';
import type { JourneyEvent } from './store.js';

/**
 * THE DECISION RECORD (leg 12 task 11) — a node's CHOICE POINTS, DERIVED ONCE.
 *
 * The journey recorded what was DONE (the legs are a timeline of work) and, on the gate
 * path, what was DECIDED — but nothing presented a node's decisions AS decisions, and the
 * WHY was recorded only when the rework loop forced it. Measured, live: 49 gate accepts,
 * 31 with a why and 18 with nothing. The pieces were scattered across four event kinds
 * (`confirmed`/`rejected` · `evidence.answers[]` · `gate-revised` · `superseded`) and no
 * reader read them together.
 *
 * THIS MODULE IS THE ONE READING. Every consumer — the `ann decisions` read, the card's
 * DECISIONS section, the high-impact rule — consumes `decisionPoints`, never its own scan
 * of the tail (the 12/08 lesson: one gate derivation, not eleven — applied to decisions).
 *
 * WHAT IT DOES NOT DO: it does not WRITE, it does not add an event type or a stored
 * field, and it does not invent a why. A choice point whose reason was never recorded
 * carries NO `why` — absence is data (AC-4), named by the reader, never filled in from
 * the surrounding prose.
 *
 * THE FOUR KINDS, and the event each lives in:
 *
 *   · `gate`          — a grill/confirm accept or reject (`confirmed`/`rejected`), read
 *                       through `gateView` so the gate lifecycle keeps ONE derivation;
 *   · `open-question` — a declared openQuestion that WAS answered, with the answer's
 *                       `how:` (discussed|defaulted|inferred) from `evidence.answers[]`;
 *   · `gate-revised`  — the gate's terms changed (`{old, new}`);
 *   · `artifact`      — an artifact was SUPERSEDED (a revision, an amendment, a
 *                       replacement: the moment the journey retired one deliverable for
 *                       another). The one artifact choice point.
 *
 * AN UNANSWERED QUESTION IS NOT A CHOICE POINT. Nothing was decided, so there is nothing
 * to record — the open question stays `openQuestions`, where `blocking` already blocks.
 */

/** The choice-point kinds — declared once, as a literal a reader can enumerate. */
export const DECISION_KINDS = ['gate', 'open-question', 'gate-revised', 'artifact'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** ONE CHOICE POINT. */
export interface DecisionPoint {
  kind: DecisionKind;
  /** WHAT was decided — the substance, unbounded here (the renderer caps it). */
  what: string;
  /** WHAT THE CHOICE IS ABOUT, structurally: the gate (a gate decision or a terms
   *  revision) · the openQuestion's id (a resolution) · the successor's name (an
   *  artifact). A consumer matches on THIS, never on the prose in `what` — the
   *  generalized high-impact rule keys every question on its id because of this field. */
  subject?: string;
  /** The verb, for a gate decision — so a consumer asks "was this an ACCEPT?" without
   *  parsing `what`. */
  decision?: 'accepted' | 'rejected';
  /** WHEN — the event's own date, never the reader's clock. */
  at: string;
  /** WHO — the RECORDED initiator. Absent when the record does not carry one; never
   *  guessed from the reader's own identity. */
  by?: string;
  /** THE WHY — the recorded reason. ABSENT MEANS MISSING (AC-4). */
  why?: string;
  /** An openQuestion resolution's `how:` — discussed|defaulted|inferred, verbatim. */
  how?: string;
  /** Whether the decision decided a HIGH-IMPACT fork (a blocking openQuestion). The
   *  generalized high-impact rule reads this instead of re-deriving it (AC-3). */
  highImpact?: boolean;
  /** The event's NUMBER — 1-based, the same address `brief.latestNote.index` prints, so
   *  "the 3rd event" means one thing across every read. */
  event: number;
  /** The event's own type (`confirmed` · `rejected` · `evidence` · `gate-revised` ·
   *  `superseded`) — so a reader can say WHERE the choice sits without re-reading. */
  type: string;
  /** The gate, for a gate decision. */
  gate?: string;
}

/** The open questions the derivation is given — the shape `Store.openQuestions` returns,
 *  passed IN so this module never reaches back into the store (the derivation is a pure
 *  function of the tail plus the questions). */
export interface DeclaredQuestion {
  id?: string;
  question?: string;
  blocking?: boolean;
}

/**
 * THE RECORDED INITIATOR. The gate writer is the ONE place an actor is recorded, and it
 * records it in the note's trailing parenthetical — `accepted (ianluo)`. There is no `by`
 * field on the events, so this is a READ of the record as it was written, not a guess: a
 * note without the parenthetical (a legacy or hand-written record) yields NOTHING, and an
 * absent initiator reads as absent.
 */
function initiator(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const m = note.match(/\(([^()]+)\)\s*$/);
  return m && m[1].trim() ? m[1].trim() : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Every answer recorded in the tail, keyed by the question id it answers. The LAST
 *  answer for an id wins — an id answered twice is the later record's (append-only). */
function answersById(events: JourneyEvent[]): Map<string, { answer?: string; how?: string; event: number }> {
  const out = new Map<string, { answer?: string; how?: string; event: number }>();
  events.forEach((e, i) => {
    if (e.type !== 'evidence' || !Array.isArray(e.answers)) return;
    for (const raw of e.answers as Array<{ id?: unknown; answer?: unknown; provenance?: unknown }>) {
      const id = str(raw?.id);
      // 0-based here; the pushed DecisionPoint is 1-based (see `event` on the interface)
      if (id) out.set(id, { answer: str(raw.answer), how: str(raw.provenance), event: i });
    }
  });
  return out;
}

/**
 * THE ONE DERIVATION: every choice point on a node, in the order the events were written.
 * Pure — same tail and questions, same answer, for every consumer.
 */
export function decisionPoints(events: JourneyEvent[], questions: readonly DeclaredQuestion[] = []): DecisionPoint[] {
  const out: DecisionPoint[] = [];
  const push = (p: DecisionPoint): void => void out.push(p);

  // 1. GATE DECISIONS — through `gateView`, the ONE gate lifecycle, so a decision here and
  //    a gate state there can never be read off two different scans.
  for (const gate of GATE_ORDER) {
    const v = gateView(events, gate);
    for (const [indexes, decision] of [
      [v.accepted, 'accepted'],
      [v.rejected, 'rejected'],
    ] as const) {
      for (const i of indexes) {
        const e = events[i];
        push({
          kind: 'gate',
          gate,
          subject: gate,
          decision,
          type: e.type === GATE_DECISION_EVENTS.accept ? 'confirmed' : 'rejected',
          event: i + 1,
          at: String(e.at ?? ''),
          what: `${decision} at the ${gate} gate`,
          ...(str(e.feedback) ? { why: str(e.feedback)! } : {}),
          ...(initiator(e.note) ? { by: initiator(e.note)! } : {}),
        });
      }
    }
  }

  // 2. RESOLVED OPEN QUESTIONS — only a question that WAS answered is a choice point.
  const answers = answersById(events);
  for (const q of questions) {
    const id = str(q.id);
    if (!id) continue;
    const a = answers.get(id);
    if (!a) continue;
    push({
      kind: 'open-question',
      subject: id,
      type: 'evidence',
      event: a.event + 1,
      at: String(events[a.event]?.at ?? ''),
      what: `${id} resolved: ${str(q.question) ?? id}`,
      // the ANSWER is the reason a question was decided this way
      ...(a.answer ? { why: a.answer } : {}),
      ...(a.how ? { how: a.how } : {}),
      ...(q.blocking ? { highImpact: true } : {}),
    });
  }

  // 3. GATE-REVISED TERMS and 4. SUPERSEDED ARTIFACTS — written by their own single
  //    writers, each one a decision the journey made and never showed as one.
  //
  //    NEITHER CARRIES A WHY CHANNEL: their allowed keys are `at`/`type`/`note`/`gate` and
  //    `at`/`type`/`note`/`successor` (store.ts `validateEventShape`), and the `note` is the
  //    PROVENANCE channel — `append!` stamps `RECORDED_BY` there when the caller gives none.
  //    Reading that note's free text as a "reason" would manufacture a why out of an
  //    author's name, which is precisely what AC-4 forbids. So these two kinds read their
  //    initiator from the note and their WHY as honestly absent — and the gap is NAMED by
  //    the reader, which is the useful signal: a terms change the journey cannot explain.
  events.forEach((e, i) => {
    if (e.type === 'gate-revised') {
      const g = e.gate as { old?: unknown; new?: unknown } | undefined;
      push({
        kind: 'gate-revised',
        subject: str((e.gate as { new?: unknown } | undefined)?.new),
        type: 'gate-revised',
        event: i + 1,
        at: String(e.at ?? ''),
        what: `gate terms revised: ${str(g?.old) ?? '?'} → ${str(g?.new) ?? '?'}`,
        ...(initiator(e.note) ? { by: initiator(e.note)! } : {}),
      });
      return;
    }
    if (e.type === 'superseded') {
      // successor.name is THE ARTIFACT IT SUPERSEDES, not the replacement's name
      // (store.ts `supersededLocks`: resolution is per-name on exactly this field) — so
      // the subject is the artifact this choice retired, and the read says so.
      const name = str((e.successor as { name?: unknown } | undefined)?.name);
      push({
        kind: 'artifact',
        subject: name,
        type: 'superseded',
        event: i + 1,
        at: String(e.at ?? ''),
        what: name ? `artifact superseded: ${name}` : 'an artifact was superseded (legacy prose — no structured successor)',
        ...(initiator(e.note) ? { by: initiator(e.note)! } : {}),
      });
    }
  });

  return out.sort((a, b) => a.event - b.event);
}
