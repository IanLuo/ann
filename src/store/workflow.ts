import type { JourneyEvent } from './store.js';

/**
 * THE GATE LIFECYCLE, DERIVED ONCE (leg 12 task 08).
 *
 * ONE question — "what is the state of this task's gates?" — used to be re-answered
 * INDEPENDENTLY off the raw event tail in ~11 places (the store's taskStatus and its
 * pending-gate predicate, gateProblems, detail()'s gates, Commands' gateState /
 * undecidedSubmission / pendingGates / rejections, lookBack, the frame's PRIVATE
 * gateState copy, the frame's pendingWait, the transcript's boundary/anchor, the
 * operator action's landing label, the UI's next-line table). Every copy was a chance
 * to disagree — and they did: the STATUS WORD was grown case-by-case and never
 * reconciled with the gate state, so a REJECTION at the entry gate derived `queued` —
 * identical to a freshly-accepted gate — the ready set {queued, active} matched,
 * `frontmostReady` offered the task, `advance()` proposed continue-leg, and `advance!`'s
 * integrity check reported clean. An operator (and the driver) drove past the rejection
 * and did the work twice (12/05).
 *
 * This module is the ONE reading of the submitted|confirmed|rejected TRIPLE, and the
 * ONE status-word projection:
 *
 *   · `gateLifecycle(events, gate)` — the gate's LAST decision: none | submitted |
 *     accepted | rejected (the lifecycle vocabulary; `accepted` is the derivation's word
 *     for the event `confirmed` — the two vocabularies are reconciled through
 *     `GATE_DECISION_EVENTS`, registered in rules/schema/vocab.json);
 *   · `gateView(events, gate)` — the same ONE scan, with the facts its readers ask for
 *     (the indices the transcript's attempt boundary needs, the rejection history the
 *     reject bound counts, the rework prompt's feedback);
 *   · `workflowState(events)` — the status WORD plus the DERIVED `rework` flag, the
 *     `waitingOn` / `pendingWait` wait facts, and the derived `next` verdict (the card's
 *     next line: the VERDICT is derived here, the WORDING stays in the renderer);
 *   · `workflowProblems(id, state)` — the RECONCILIATION rule (below).
 *
 * NOTHING here is state: no new event type, no new stored field, no write path. `rework`
 * is derived (a rejected bound gate with no later submission at that gate; a
 * re-submission clears it), the reject bound stays the `gate!` command's constant, and
 * the closure semantics (F-AC16) are untouched.
 */

/** The gate TRIPLE — the only event types this module reads, declared once. */
export const GATE_EVENT_TYPES = ['submitted', 'confirmed', 'rejected'] as const;
export type GateEventType = (typeof GATE_EVENT_TYPES)[number];

/** Is this event type part of the gate triple? (the single writer's whitelist reads it
 *  too — one declaration of the triple, not a literal per layer) */
export const isGateEventType = (t: string): t is GateEventType => (GATE_EVENT_TYPES as readonly string[]).includes(t);

/** THE TWO DECISION VOCABULARIES, reconciled (AC-5): the HUMAN input is
 *  `accept|reject`, the EVENT is `confirmed|rejected`. This is the code literal; the
 *  registry declares the same mapping (`rules/schema/vocab.json` → `gateDecisions`) and
 *  the duplicate is recorded in the reconciliation register (docs/resource-registry §5).
 *  A third form cannot appear silently: the total mapping is pinned by a table test. */
export const GATE_DECISION_EVENTS: Record<'accept' | 'reject', 'confirmed' | 'rejected'> = {
  accept: 'confirmed',
  reject: 'rejected',
};

/** A gate's lifecycle: the last of the triple. `accepted` names the state the event
 *  `confirmed` records — one word, everywhere a gate is read. */
export type GateLifecycle = 'none' | 'submitted' | 'accepted' | 'rejected';

export interface GateRejection {
  index: number;
  at: string;
  feedback?: string;
  note?: string;
}

/** ONE gate's derived facts — the single scan every gate reader consumes. Indices are
 *  tail indices (the transcript's attempt boundary and the work-order rules need the
 *  PLACE, not only the word). */
export interface GateView {
  gate: string;
  /** The gate's lifecycle: the LAST submitted|confirmed|rejected at this gate. */
  state: GateLifecycle;
  /** That event's tail index (-1 when the gate has no triple event at all). */
  index: number;
  at?: string;
  /** An UNDECIDED submission: someone submitted and no decision followed. Equivalent to
   *  `state === 'submitted'` by construction — never derive it a second way. */
  undecided: boolean;
  /** The undecided submission's index/at (only meaningful while `undecided`). */
  undecidedIndex: number;
  undecidedAt?: string;
  /** Tail indices of the submissions / accepts / rejections at this gate, in log order. */
  submitted: number[];
  accepted: number[];
  rejected: number[];
  /** The last DECISION (accepted|rejected): its tail index, -1 when none (a wait). */
  lastDecisionIndex: number;
  /** The last REJECTION — the rework prompt's source and the transcript's boundary. */
  lastRejection?: GateRejection;
}

const at = (e: JourneyEvent): string => (typeof e.at === 'string' ? e.at : '');
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const isGateEvent = (e: JourneyEvent, gate: string): e is JourneyEvent & { type: GateEventType } =>
  (GATE_EVENT_TYPES as readonly string[]).includes(e.type) && e.gate === gate;

/** The gate's LAST decision, as the event tail holds it — the ONE lifecycle reading. */
export function gateLifecycle(events: JourneyEvent[], gate: string): GateLifecycle {
  return gateView(events, gate).state;
}

/** ONE gate, derived from the tail in ONE pass. */
export function gateView(events: JourneyEvent[], gate: string): GateView {
  const view: GateView = {
    gate,
    state: 'none',
    index: -1,
    undecided: false,
    undecidedIndex: -1,
    submitted: [],
    accepted: [],
    rejected: [],
    lastDecisionIndex: -1,
  };
  events.forEach((e, i) => {
    if (!isGateEvent(e, gate)) return;
    if (e.type === 'submitted') view.submitted.push(i);
    else if (e.type === 'confirmed') view.accepted.push(i);
    else {
      view.rejected.push(i);
      view.lastRejection = { index: i, at: at(e), ...(text(e.feedback) ? { feedback: text(e.feedback) } : {}), ...(text(e.note) ? { note: text(e.note) } : {}) };
    }
    view.index = i;
    view.at = at(e);
    view.state = e.type === 'confirmed' ? 'accepted' : e.type;
    if (e.type === 'submitted') {
      view.undecidedIndex = i;
      view.undecidedAt = at(e);
    } else {
      view.lastDecisionIndex = i;
    }
  });
  // the wait is decided by the LAST event: a decision ends it (a re-submission after a
  // decision is a wait again — that is what an undecided submission IS)
  view.undecided = view.state === 'submitted';
  if (!view.undecided) {
    view.undecidedIndex = -1;
    view.undecidedAt = undefined;
  }
  return view;
}

/** The tail's two gates, each read once. */
export interface GateViews {
  grill: GateView;
  confirm: GateView;
}

export const gateViews = (events: JourneyEvent[]): GateViews => ({
  grill: gateView(events, 'grill'),
  confirm: gateView(events, 'confirm'),
});

/** The card's next line, DERIVED: what this task waits for. The WORDING belongs to the
 *  renderer — this is the verdict, and a renderer that words it differently is a
 *  renderer defect, never a second derivation. */
export type NextVerdictKind =
  | 'decide-now' // the gate IN HAND is submitted — the renderer's overlay, never derived here
  | 'waiting-on-decision' // an undecided submission is the next human move (`gate`)
  | 'waiting-on-runner' // the two-phase wait: the runner owes the evidence commit
  | 'conclusion-missing' // the exit gate is accepted; the conclusion evidence is not recorded
  | 'rework' // a rejected gate owes a re-submission (`gate`)
  | 'work-in-progress' // active
  | 'closed' // done
  | 'terminal' // failed | deferred | cancelled | superseded (`status`)
  | 'entry-accepted' // the entry gate is accepted; the work has not started
  | 'queued'; // nothing submitted yet

export interface NextVerdict {
  verdict: NextVerdictKind;
  gate?: 'grill' | 'confirm';
  status?: string;
}

/** THE WORKFLOW-STATE PROJECTION — the status word, `rework` included. */
export interface WorkflowState {
  /** The status WORD (queued · active · blocked · done · failed · superseded · cancelled ·
   *  accepted · deferred) — the same range `vocab.statuses` declares. */
  status: string;
  /** REWORK OWED, derived: a bound gate whose LAST decision is a rejection, with no
   *  later submission at that gate (a re-submission clears it). */
  rework: boolean;
  gates: GateViews;
  /** An undecided submission's gate — the human's next decision (the most recent wait). */
  waitingOn?: 'grill' | 'confirm';
  /** A `waiting` record with no later commit evidence (the two-phase verify-wait). */
  pendingWait: boolean;
  next: NextVerdict;
}

/** The wait re-derivations' guard: a terminal word is never overridden by a wait. The
 *  long-standing range (leg 08/09) — `superseded` is deliberately NOT in it, preserving
 *  the derivation exactly as it was. */
const WAIT_EXEMPT = ['done', 'failed', 'cancelled', 'deferred'];
/** The status range that claims the task is READY to run (the ready set) — the words a
 *  reconciliation rule must never see beside an owed rework. */
export const READY_STATUSES = ['queued', 'active'];

/** A `waiting` record with NO subsequent commit evidence still stands (the empty-chain
 *  verify-wait; format v14 §3, resume tail-state 4). */
export function undischargedWait(events: JourneyEvent[]): boolean {
  const last = events.map((e) => e.type).lastIndexOf('waiting');
  if (last < 0) return false;
  return !events.slice(last + 1).some((e) => e.type === 'evidence' && Array.isArray(e.commits) && e.commits.length > 0);
}

/** THE STATUS WORD + the wait facts, derived from the tail. The word's case table reads
 *  the task's OWN lifecycle events (created/activated/completed/failed/cancelled/
 *  deferred); the GATE half of it comes from the gate views — an accept at the confirm
 *  gate sets the `accepted` word exactly where the event sits in the tail, so the word's
 *  order semantics are unchanged while nothing re-reads the triple. */
export function workflowState(events: JourneyEvent[]): WorkflowState {
  const gates = gateViews(events);
  const acceptedAt = new Set(gates.confirm.accepted);
  let status = 'queued';
  events.forEach((e, i) => {
    // the CONFIRM-gate accept, applied in tail order (its guard is the old case's)
    if (acceptedAt.has(i) && status !== 'done' && status !== 'failed') status = 'accepted';
    switch (e.type) {
      case 'created':
        status = 'queued';
        break;
      case 'activated':
        status = 'active';
        break;
      case 'completed':
        status = 'done';
        break;
      case 'failed':
        status = 'failed';
        break;
      case 'superseded':
        if (status !== 'done' && status !== 'failed') status = 'superseded';
        break;
      // the `cancelled` terminal (leg 08 task 01) and its `deferred` counterpart: append-
      // style bookkeeping records, terminal in BOTH directions — they never un-close
      // delivered/exhausted/abandoned work, and the wait re-derivations below join their
      // guard (a cancelled task stays cancelled whatever submission it carries).
      case 'cancelled':
        if (status !== 'done' && status !== 'failed') status = 'cancelled';
        break;
      case 'deferred':
        if (status !== 'done' && status !== 'failed' && status !== 'cancelled') status = 'deferred';
        break;
      // `goal-met` is deliberately absent: a goal verdict is STATUS-INERT (goal-session
      // design §2) — only the seed's created+completed makes the goal leg done.
    }
  });
  // the wait re-derivations: an undecided submission, or an undischarged `waiting`
  const waits = (['grill', 'confirm'] as const).filter((g) => gates[g].undecided);
  const waitingOn = waits.length ? waits.reduce((best, g) => (gates[g].undecidedIndex > gates[best].undecidedIndex ? g : best)) : undefined;
  const pendingWait = undischargedWait(events);
  if (!WAIT_EXEMPT.includes(status)) {
    if (waitingOn) status = 'blocked';
    if (pendingWait) status = 'blocked';
  }
  // REWORK: the last decision at a bound gate is a rejection and no submission followed
  // it (a re-submission makes the gate `submitted` again — the rework is cleared).
  const rejectedGate = (['grill', 'confirm'] as const).find((g) => gates[g].state === 'rejected');
  return {
    status,
    rework: rejectedGate !== undefined,
    gates,
    ...(waitingOn ? { waitingOn } : {}),
    pendingWait,
    next: nextVerdict(status, gates, rejectedGate, waitingOn),
  };
}

/** The card's next line, derived — status first (the terminal words keep their own
 *  answer), then the rework, then the wait. */
function nextVerdict(
  status: string,
  gates: GateViews,
  rejectedGate: 'grill' | 'confirm' | undefined,
  waitingOn: 'grill' | 'confirm' | undefined,
): NextVerdict {
  if (status === 'done') return { verdict: 'closed' };
  if (['failed', 'deferred', 'cancelled', 'superseded'].includes(status)) return { verdict: 'terminal', status };
  if (status === 'accepted') return { verdict: 'conclusion-missing' };
  if (rejectedGate) return { verdict: 'rework', gate: rejectedGate };
  if (status === 'blocked') {
    return waitingOn ? { verdict: 'waiting-on-decision', gate: waitingOn } : { verdict: 'waiting-on-runner' };
  }
  if (status === 'active') return { verdict: 'work-in-progress' };
  if (gates.grill.undecided) return { verdict: 'waiting-on-decision', gate: 'grill' };
  if (gates.grill.state === 'accepted') return { verdict: 'entry-accepted' };
  return { verdict: 'queued' };
}

/**
 * THE RECONCILIATION RULE (AC-3) — the status word must never contradict the derived
 * gate lifecycle. Scripted, never convention: `check()` reports these, so `advance!`'s
 * integrity re-check and the WHAT'S NEXT card read them and can no longer call a
 * contradiction clean.
 *
 *   (a) `queued`/`active` (the READY words) while a bound gate's last decision is a
 *       REJECTION — the mis-dispatch: the rework is owed and nothing may drive it;
 *   (b) `accepted` with no confirm accept — the exit gate's word, unsupported;
 *   (c) `blocked` with neither an undecided submission nor an undischarged `waiting` —
 *       a wait that nothing in the tail justifies.
 *
 * (b) and (c) cannot be produced by the projection above (that is the point of the
 * projection); they are the rule's other two directions, so a status word added later —
 * or a branch that drifts — fails here instead of shipping.
 */
export function workflowProblems(id: string, wf: WorkflowState): string[] {
  const out: string[] = [];
  if (READY_STATUSES.includes(wf.status)) {
    const gate = (['grill', 'confirm'] as const).find((g) => wf.gates[g].state === 'rejected');
    if (gate) {
      out.push(
        `GATE-REWORK: ${id} — the status word '${wf.status}' claims READY while the last decision at gate '${gate}' is a REJECTION with no re-submission (rework owed — the task must be reworked and re-submitted before anything drives it)`,
      );
    }
  }
  if (wf.status === 'accepted' && wf.gates.confirm.state !== 'accepted') {
    out.push(`GATE-STATUS: ${id} — the status word 'accepted' but the confirm gate's last decision is '${wf.gates.confirm.state}' (no confirm accept)`);
  }
  if (wf.status === 'blocked' && !wf.waitingOn && !wf.pendingWait) {
    out.push(`GATE-STATUS: ${id} — the status word 'blocked' but nothing is pending: no undecided submission and no undischarged 'waiting'`);
  }
  return out;
}
