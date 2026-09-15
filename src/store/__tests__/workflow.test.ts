import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Store, JourneyEvent, TaskDetail, CLOSED_TASK_STATUSES } from '../store.js';
import { getVOCAB } from '../vocab.js';
import {
  GATE_DECISION_EVENTS,
  GATE_EVENT_TYPES,
  READY_STATUSES,
  REWORK_EXEMPT,
  gateLifecycle,
  gateView,
  undischargedWait,
  workflowProblems,
  workflowState,
  type GateLifecycle,
  type WorkflowState,
} from '../workflow.js';
import { Commands } from '../../commands/index.js';
import { runValidators } from '../../flow/validators/index.js';

/**
 * THE GATE LIFECYCLE, DERIVED ONCE (leg 12 task 08).
 *
 * Two halves, pinned together:
 *
 *   · the DERIVATION (workflow.ts) — one lifecycle over the triple, one status-word
 *     projection (`rework` included), one rework flag, one reconciliation rule; exercised
 *     across the WHOLE lifecycle (created-only · submit · accept · reject · re-submit ·
 *     accept-after-rework · the other gate · a double decision · a legacy/inert record);
 *   · the READERS — every surface that used to answer "what is the state of this task's
 *     gates?" off the raw tail (the store's status/detail/check, the command layer's
 *     gateState/undecidedSubmission/pendingGates/rejections/lookBack, the card payload)
 *     must AGREE, on a fixture set covering all four states. A disagreement is a
 *     FAILURE, never a nuance.
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
function makeStore(): string {
  root = mkdtempSync(join(tmpdir(), 'ann-wf-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}
function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = CONTRACT, createdAt = '2026-08-27') {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
/** A leg root — node.json only: leg roots carry NO events (v8 §3). */
function writeLeg(id = '01-leg') {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract: { intent: 'the leg', acceptanceCriteria: ['the leg is done'] }, createdAt: '2026-08-27' }));
}
/** A contract that passes F-AC19 (contract self-sufficiency) — so check() reports only
 *  what the test is about. */
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'], targetAreas: ['src/store'] };
const asEvents = (tail: Array<Record<string, unknown>>) => tail as unknown as JourneyEvent[];
const commands = () => new Commands(new Store(root), 'test');
const TASK = '01-leg/01-a';

/** The lifecycle table: a tail → the gate's state, the status word, the rework flag and
 *  the card's verdict. ONE row per shape the lifecycle can take. */
const LIFECYCLE: Array<{
  what: string;
  tail: Array<Record<string, unknown>>;
  state: GateLifecycle;
  status: string;
  rework: boolean;
  verdict: string;
}> = [
  { what: 'created only — nothing submitted', tail: [ev('created')], state: 'none', status: 'queued', rework: false, verdict: 'queued' },
  {
    what: 'the first submission — undecided, the task waits on the human',
    tail: [ev('created'), ev('submitted', { gate: 'grill' })],
    state: 'submitted',
    status: 'blocked',
    rework: false,
    verdict: 'waiting-on-decision',
  },
  {
    what: 'accept — the healthy entry gate (the task stays READY)',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })],
    state: 'accepted',
    status: 'queued',
    rework: false,
    verdict: 'entry-accepted',
  },
  {
    what: 'reject — the rework is owed and the WORD says so (`rework`: outside the ready set, so nothing proposes it)',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill', feedback: 'rework it' })],
    state: 'rejected',
    status: 'rework',
    rework: true,
    verdict: 'rework',
  },
  {
    what: 'a RE-submission after a reject — the rework is cleared, the gate waits again',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev('submitted', { gate: 'grill' })],
    state: 'submitted',
    status: 'blocked',
    rework: false,
    verdict: 'waiting-on-decision',
  },
  {
    what: 'accept after the rework — the gate is decided and no rework stands',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })],
    state: 'accepted',
    status: 'queued',
    rework: false,
    verdict: 'entry-accepted',
  },
  {
    what: 'the OTHER gate decided — this gate is untouched',
    tail: [ev('created'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })],
    state: 'none',
    status: 'accepted',
    rework: false,
    verdict: 'conclusion-missing',
  },
  {
    what: 'a double decision at one gate — the LAST one is the state (accept then reject)',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('rejected', { gate: 'grill' })],
    state: 'rejected',
    status: 'rework',
    rework: true,
    verdict: 'rework',
  },
  {
    what: 'a double decision at one gate — reject then accept → accepted',
    tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })],
    state: 'accepted',
    status: 'queued',
    rework: false,
    verdict: 'entry-accepted',
  },
  {
    what: 'a LEGACY/INERT record in the tail — an unknown type, a gateless submission, a status-inert verdict, a bookkeeping `extended`',
    tail: [
      ev('created'),
      ev('legacy-prose-event', { note: 'a pre-v9 record' }),
      ev('submitted'),
      ev('extended', { note: 'bookkeeping' }),
      ev('goal-met', { decision: 'met' }),
    ],
    state: 'none',
    status: 'queued',
    rework: false,
    verdict: 'queued',
  },
];

describe('the ONE gate lifecycle (AC-1) — gateLifecycle across the whole lifecycle', () => {
  for (const c of LIFECYCLE) {
    it(`${c.what} → ${c.state}`, () => {
      expect(gateLifecycle(asEvents(c.tail), 'grill')).toBe(c.state);
    });
  }

  it('reads the gate it was asked about, and only it', () => {
    const tail = asEvents([ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })]);
    expect(gateLifecycle(tail, 'grill')).toBe('rejected');
    expect(gateLifecycle(tail, 'confirm')).toBe('accepted');
    expect(gateLifecycle(tail, 'some-other-gate')).toBe('none');
  });

  it('an empty tail is `none` on every gate', () => {
    expect(gateLifecycle([], 'grill')).toBe('none');
    expect(gateLifecycle([], 'confirm')).toBe('none');
  });

  it('the view carries the facts its readers ask for (indices, counts, the rejection)', () => {
    const tail = asEvents([
      ev('created'), //            0
      ev('submitted', { gate: 'grill' }), //   1
      ev('rejected', { gate: 'grill', feedback: 'not yet', note: 'rejected (ianluo)' }), // 2
      ev('submitted', { gate: 'grill' }), //   3
      ev('rejected', { gate: 'grill', feedback: 'still not' }), // 4
      ev('submitted', { gate: 'grill' }), //   5 — undecided
    ]);
    const v = gateView(tail, 'grill');
    expect(v.state).toBe('submitted');
    expect(v.undecided).toBe(true);
    expect(v.index).toBe(5);
    expect(v.undecidedIndex).toBe(5);
    expect(v.submitted).toEqual([1, 3, 5]);
    expect(v.accepted).toEqual([]);
    expect(v.rejected).toEqual([2, 4]);
    expect(v.lastDecisionIndex).toBe(4);
    expect(v.lastRejection).toMatchObject({ index: 4, feedback: 'still not' });
  });

  it('a decided gate reports no undecided submission (the wait ends at the decision)', () => {
    const v = gateView(asEvents([ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]), 'grill');
    expect(v.undecided).toBe(false);
    expect(v.undecidedIndex).toBe(-1);
    expect(v.undecidedAt).toBeUndefined();
    expect(v.lastDecisionIndex).toBe(1);
  });
});

describe('the ONE workflow projection (AC-1/AC-4) — the status word, rework included', () => {
  for (const c of LIFECYCLE) {
    it(`${c.what} → ${c.status}${c.rework ? ' (REWORK OWED)' : ''}`, () => {
      const wf = workflowState(asEvents(c.tail));
      expect(wf.status).toBe(c.status);
      expect(wf.rework).toBe(c.rework);
      expect(wf.next.verdict).toBe(c.verdict);
    });
  }

  it('THE CONTRAST (the review\'s call): a freshly ACCEPTED entry gate derives the READY word, a REJECTED one derives `rework` — the WORD now keeps the rejected task out of the ready set', () => {
    const accepted = workflowState(asEvents([ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]));
    const rejected = workflowState(asEvents([ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill', feedback: 'rework it' })]));
    // the words DIFFER — PREVENTION: a rejected task cannot be proposed as fresh work
    expect(accepted.status).toBe('queued');
    expect(rejected.status).toBe('rework');
    expect(READY_STATUSES).toContain(accepted.status);
    expect(READY_STATUSES).not.toContain(rejected.status);
    // the flag and the verdict stay, because they carry what a bare word cannot: WHICH
    // gate, and the human's own feedback (through the view)
    expect(accepted.rework).toBe(false);
    expect(rejected.rework).toBe(true);
    expect(accepted.next).toEqual({ verdict: 'entry-accepted' });
    expect(rejected.next).toEqual({ verdict: 'rework', gate: 'grill' });
    expect(rejected.gates.grill.lastRejection?.feedback).toBe('rework it');
  });

  it('the `rework` word is DERIVED and bounded: not a CLOSED word, not a READY word, and it never overrides a closed one', () => {
    expect(REWORK_EXEMPT).toEqual([...CLOSED_TASK_STATUSES, 'failed']); // the knowing duplicate, pinned
    expect(CLOSED_TASK_STATUSES).not.toContain('rework'); // the leg aggregate / distance reads still count it
    expect(READY_STATUSES).not.toContain('rework'); // no reader proposes it
    // closed or exhausted work keeps its word even with a rejection in the tail — the
    // rework FACT stays derived (the flag), but it cannot re-open closed work
    const closed: Array<[string, string, Record<string, unknown>]> = [
      ['completed', 'done', {}],
      ['superseded', 'superseded', { successor: { name: 'x', path: 'docs/x.md' } }],
      ['cancelled', 'cancelled', { reason: 'no longer needed' }],
      ['deferred', 'deferred', { reason: 'later' }],
      ['failed', 'failed', {}],
    ];
    for (const [type, word, extra] of closed) {
      const wf = workflowState(asEvents([ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev(type, extra)]));
      expect(wf.status, `${type} → ${word}`).toBe(word);
      expect(wf.rework, `${type} keeps the derived fact`).toBe(true);
    }
  });

  it('the reject bound and the rework are consequences of the SAME counter — 3 rejections, still one open rework', () => {
    const tail = asEvents([
      ev('created'),
      ...[1, 2, 3].flatMap(() => [ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })]),
    ]);
    const wf = workflowState(tail);
    expect(wf.gates.grill.rejected).toHaveLength(3);
    expect(wf.rework).toBe(true);
    expect(wf.status).toBe('rework'); // the bound's counter and the word read the SAME state
  });

  it('the two-phase wait is unchanged: a confirm accept with an undischarged `waiting` is blocked, not accepted', () => {
    const tail = asEvents([ev('created'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('waiting', { note: 'commit the doc' })]);
    const wf = workflowState(tail);
    expect(wf.status).toBe('blocked');
    expect(wf.pendingWait).toBe(true);
    expect(wf.waitingOn).toBeUndefined();
    expect(wf.next).toEqual({ verdict: 'waiting-on-runner' });
    // …and the commit evidence RELEASES it into the honest `accepted`
    const released = workflowState([...tail, ev('evidence', { commits: [{ sha: 'abc1234' }] })]);
    expect(released.status).toBe('accepted');
    expect(released.pendingWait).toBe(false);
    expect(released.next).toEqual({ verdict: 'conclusion-missing' });
  });

  it('undischargedWait reads the LAST `waiting` and the commit evidence after it', () => {
    expect(undischargedWait(asEvents([]))).toBe(false);
    expect(undischargedWait(asEvents([ev('evidence', { commits: [{ sha: 'abc1234' }] })]))).toBe(false);
    expect(undischargedWait(asEvents([ev('waiting')]))).toBe(true);
    expect(undischargedWait(asEvents([ev('waiting'), ev('evidence', { refs: ['docs/x.md'] })]))).toBe(true); // no commits = no release
    expect(undischargedWait(asEvents([ev('waiting'), ev('evidence', { commits: [{ sha: 'abc1234' }] })]))).toBe(false);
  });

  it('the terminals are unchanged (done · failed · cancelled · deferred never yield to a wait)', () => {
    for (const [type, word] of [['completed', 'done'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['deferred', 'deferred']] as const) {
      const wf = workflowState(asEvents([ev('created'), ev(type), ev('submitted', { gate: 'confirm' }), ev('waiting')]));
      expect(wf.status, `${type} → ${word}`).toBe(word);
    }
    const superseded = workflowState(asEvents([ev('created'), ev('superseded', { successor: { name: 'x', path: 'docs/x.md' } })]));
    expect(superseded.status).toBe('superseded');
  });

  it('`goal-met` is STATUS-INERT (goal-session-design §2)', () => {
    expect(workflowState(asEvents([ev('created'), ev('completed'), ev('goal-met', { decision: 'met' })])).status).toBe('done');
    expect(workflowState(asEvents([ev('created'), ev('goal-met', { decision: 'met' })])).status).toBe('queued');
  });
});

describe('the reconciliation rule (AC-3) — the status word vs the derived lifecycle', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** THE MIS-DISPATCH FIXTURE — the exact state 12/05 hit live: the entry gate REJECTED
   *  with feedback and never re-submitted. Before this task it reported `integrity: clean`,
   *  `queued`, continue-leg, and the operator drove past the rejection. The FIX is
   *  PREVENTION (the review's call): the task derives the `rework` WORD, which is outside
   *  the ready set, so no reader proposes it — and check() stays CLEAN, so one human
   *  rejection can no longer wedge every read in the journey. */
  it('the rework WORD prevents the mis-dispatch: the rejected task is out of the ready set and check() is CLEAN (no journey-wide wedge)', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill', feedback: 'the contract is not right yet — rework it' })]);
    const s = new Store(root);
    const cmds = commands();

    // the word is the honest one, and it is NOT ready
    expect(s.status(TASK)).toBe('rework');
    expect(READY_STATUSES).not.toContain(s.status(TASK));
    // …so nothing proposes it: not the frontmost-ready derivation, not advance()
    expect(cmds.frontmostReady()).toBeUndefined();
    expect(cmds.advance().action).not.toBe('continue-leg');
    expect(cmds.lookBack().frontmostReady).toBeUndefined();
    // the flag and the verdict still carry the gate + the feedback
    const wf = workflowState(asEvents(s.events(TASK)));
    expect(wf.rework).toBe(true);
    expect(wf.next).toEqual({ verdict: 'rework', gate: 'grill' });
    expect(wf.gates.grill.lastRejection?.feedback).toContain('rework it');

    // PREVENTION BEATS DETECTION: the old READY-word finding (GATE-REWORK) is RETIRED with
    // the rule (a), so this state is NOT a journey-wide integrity failure any more — the
    // pre-existing rules and the reconciliation both stay silent
    expect(s.gateProblems(TASK)).toEqual([]);
    expect(s.check()).toEqual([]);
    expect(workflowProblems(TASK, wf)).toEqual([]);
    // the contrast at the same word-level: an ACCEPTED entry gate is READY and clean too
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    expect(new Store(root).status('01-leg/02-b')).toBe('queued');
    expect(new Store(root).check()).toEqual([]);
  });

  it('the rework WORD holds at the CONFIRM gate too, and a re-submission clears it (back to the wait)', () => {
    writeNode(TASK, [ev('created'), ev('activated'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('rejected', { gate: 'confirm' })]);
    const s = new Store(root);
    expect(s.status(TASK)).toBe('rework');
    expect(s.check()).toEqual([]);
    // the rework gesture: re-submit at the rejected gate — the word yields to the wait
    s.appendEvent(s.resolveNode(TASK), ev('submitted', { gate: 'confirm' }) as unknown as JourneyEvent);
    expect(s.status(TASK)).toBe('blocked');
    expect(s.check()).toEqual([]);
  });

  it('a terminal word is never overridden by the rework — a cancelled task owes no dispatch', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' }), ev('cancelled', { reason: 'no longer needed' })]);
    const s = new Store(root);
    expect(s.status(TASK)).toBe('cancelled');
    expect(s.check()).toEqual([]);
    expect(workflowState(asEvents(s.events(TASK))).rework).toBe(true); // derived, but not a dispatch risk
  });

  it('(b) `accepted` with the exit gate not LAST-accepted is a NAMED finding — and its message names no false cause', () => {
    const wf = workflowState(asEvents([ev('created'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })]));
    expect(workflowProblems(TASK, wf)).toEqual([]); // the honest accepted
    // the crafted contradiction: the word says accepted, the exit gate's LAST decision does
    // not. The word derivation covers the shapes that used to reach this (below), so this
    // is the GUARD direction — pinned against the crafted word so a future branch that
    // drifts FAILS here instead of shipping.
    const lying: WorkflowState = { ...wf, status: 'accepted', gates: { ...wf.gates, confirm: gateView(asEvents([ev('submitted', { gate: 'confirm' })]), 'confirm') } };
    expect(workflowProblems(TASK, lying)).toEqual([expect.stringContaining('GATE-STATUS')]);
    expect(workflowProblems(TASK, lying)[0]).toContain("last decision is 'submitted'");
    // F1: the message must NOT assert a cause that can be false. The old wording said "no
    // confirm accept" — false for the reachable accept → re-submit → reject shape.
    expect(workflowProblems(TASK, lying)[0]).not.toContain('no confirm accept');
  });

  it('F1 — the reachable accept → re-submit → reject shape at confirm derives `rework` (the old rule (b) message lied about it)', () => {
    writeNode(TASK, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), // the exit gate ACCEPTED
      ev('submitted', { gate: 'confirm' }), // …then RE-SUBMITTED
      ev('rejected', { gate: 'confirm', feedback: 'the evidence does not hold up' }), // …then REJECTED
    ]);
    const s = new Store(root);
    const wf = workflowState(asEvents(s.events(TASK)));
    // there IS a confirm accept in the tail — that is the point: the word is `rework`, never
    // a bare `accepted` beside a rejected gate, and no false-cause message can be reached
    expect(wf.gates.confirm.accepted).toHaveLength(1);
    expect(wf.status).toBe('rework');
    expect(wf.rework).toBe(true);
    expect(wf.next).toEqual({ verdict: 'rework', gate: 'confirm' });
    expect(workflowProblems(TASK, wf)).toEqual([]);
    expect(s.check()).toEqual([]);
  });

  it('(c) `blocked` with nothing pending is a NAMED finding', () => {
    const wf = workflowState(asEvents([ev('created'), ev('submitted', { gate: 'grill' })]));
    expect(wf.status).toBe('blocked');
    expect(workflowProblems(TASK, wf)).toEqual([]); // the honest blocked
    const lying: WorkflowState = { ...wf, status: 'blocked', gates: { grill: gateView([], 'grill'), confirm: gateView([], 'confirm') }, waitingOn: undefined, pendingWait: false };
    expect(workflowProblems(TASK, lying)).toEqual([expect.stringContaining('GATE-STATUS')]);
    expect(workflowProblems(TASK, lying)[0]).toContain('nothing is pending');
  });

  it('the retired (a): check() no longer has a GATE-REWORK direction — and rule (b)/(c) still fire through the SAME read advance! and the card use', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })]);
    const s = new Store(root);
    // the rework state is NOT a finding any more (prevention replaced detection)
    expect(s.check().filter((p) => p.includes('GATE-REWORK'))).toEqual([]);
    // while the two guard directions ARE scripted and reported by check() when they appear
    const lyingAccepted: WorkflowState = { ...workflowState(asEvents([ev('created'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })])), status: 'accepted', gates: { grill: gateView([], 'grill'), confirm: gateView([], 'confirm') } };
    expect(workflowProblems(TASK, lyingAccepted)).toEqual([expect.stringContaining('GATE-STATUS')]);
  });
});

describe('the readers AGREE (AC-2) — one fixture set, all four gate states', () => {
  beforeEach(() => {
    makeStore();
    writeLeg();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** One fixture per gate state, each a post-cutoff task (nothing grandfathered). */
  const CASES: Array<{ what: string; tail: Array<Record<string, unknown>>; state: GateLifecycle }> = [
    { what: 'none — nothing submitted', tail: [ev('created')], state: 'none' },
    { what: 'submitted — undecided', tail: [ev('created'), ev('submitted', { gate: 'grill' })], state: 'submitted' },
    { what: 'accepted', tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })], state: 'accepted' },
    { what: 'rejected (rework owed)', tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })], state: 'rejected' },
  ];

  for (const c of CASES) {
    it(`every reader answers the same state: ${c.what}`, () => {
      writeNode(TASK, c.tail);
      const store = new Store(root);
      const cmds = commands();
      const detail: TaskDetail = store.detail(TASK);
      const wf = workflowState(asEvents(c.tail));

      // 1. the derivation itself
      expect(gateLifecycle(asEvents(c.tail), 'grill')).toBe(c.state);
      // 2. the status WORD is the projection's (one word, one source)
      expect(store.status(TASK)).toBe(wf.status);
      // 3. the card's gates
      expect(detail.gates.grill.state).toBe(c.state);
      expect(detail.gates.confirm.state).toBe(gateLifecycle(asEvents(c.tail), 'confirm'));
      // 4. the card's derived rework + next verdict (the payload the UI renders)
      expect(detail.rework).toBe(wf.rework);
      expect(detail.next).toEqual(wf.next);
      // 5. the command layer's gate state (the driver's pre-flight, complete!'s read)
      expect(cmds.gateState(TASK, 'grill')).toBe(c.state);
      // 6. the undecided predicate == the lifecycle's own wait
      expect(cmds.undecidedSubmission(TASK, 'grill')).toBe(c.state === 'submitted');
      // 7. the card's blockers == the same wait
      expect(detail.blockers.length > 0).toBe(c.state === 'submitted');
      // 8. the rejections counter
      expect(cmds.rejections(TASK, 'grill')).toBe(c.state === 'rejected' ? 1 : 0);
      // 9. the whole-journey gate queue
      expect(cmds.pendingGates().some((p) => p.task === TASK && p.gate === 'grill')).toBe(c.state === 'submitted');
      // 10. the active-leg observer view
      expect(cmds.lookBack().pendingGates.some((p) => p.task === TASK && p.gate === 'grill')).toBe(c.state === 'submitted');
      // 11. the reconciliation: EVERY honest fixture is silent — the rejected case included,
      // because the projection now derives the `rework` WORD for it (the retired (a) made
      // this state a finding; the word makes it impossible instead)
      expect(workflowProblems(TASK, wf)).toEqual([]);
    });
  }

  it('the rework state AGREES across the readers too (the fifth status word, all readers)', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })]);
    const store = new Store(root);
    const cmds = commands();
    const d = store.detail(TASK);
    const wf = workflowState(asEvents(store.events(TASK)));
    expect(store.status(TASK)).toBe('rework');
    expect(d.status).toBe('rework');
    expect(d.gates.grill.state).toBe('rejected');
    expect(d.rework).toBe(true);
    expect(d.next).toEqual({ verdict: 'rework', gate: 'grill' });
    expect(cmds.gateState(TASK, 'grill')).toBe('rejected');
    expect(cmds.rejections(TASK, 'grill')).toBe(1);
    expect(cmds.undecidedSubmission(TASK, 'grill')).toBe(false);
    expect(d.blockers).toEqual([]);
    expect(cmds.pendingGates()).toEqual([]);
    expect(cmds.lookBack().pendingGates).toEqual([]);
    expect(workflowProblems(TASK, wf)).toEqual([]);
  });

  it('a rework-owed task is NOT proposed, while the LEG aggregate, the leg gate and the distance-to-goal read still count it as OPEN work', () => {
    writeLeg('02-next');
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })]);
    const store = new Store(root);
    const cmds = commands();
    // NOT proposed: the ready set excludes it, so the frontmost-ready/advance/look-back reads skip it
    expect(cmds.frontmostReady()).toBeUndefined();
    expect(cmds.lookBack().frontmostReady).toBeUndefined();
    expect(cmds.advance().action).not.toBe('continue-leg');
    expect(cmds.advance().detail).not.toContain('next task:');
    // …but the WORK is still open: the leg derives the child's word (never `done`), so the
    // leg gate stays shut and the distance-to-goal set still lists the leg AND the task
    expect(store.status('01-leg')).toBe('rework');
    expect(CLOSED_TASK_STATUSES).not.toContain('rework');
    const findings = runValidators(store).filter((f) => f.code === 'distance-to-goal');
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('01-leg');
    expect(findings[0].detail).toContain(TASK);
    expect(store.legGateMet('02-next')).toMatchObject({ met: false });
  });

  it('the readers agree on a task whose CONFIRM gate is the one in flight', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' })]);
    const store = new Store(root);
    const cmds = commands();
    const d = store.detail(TASK);
    expect(cmds.gateState(TASK, 'confirm')).toBe('submitted');
    expect(d.gates).toMatchObject({ grill: { state: 'accepted' }, confirm: { state: 'submitted' } });
    expect(cmds.pendingGates().map((p) => `${p.task}@${p.gate}`)).toEqual([`${TASK}@confirm`]);
    expect(d.blockers).toEqual(['submitted (gate=confirm) awaiting decision']);
    expect(d.status).toBe('blocked');
    expect(d.next).toEqual({ verdict: 'waiting-on-decision', gate: 'confirm' });
  });

  it('NO reader re-scans the triple: the idiom is gone from every file but the derivation', () => {
    const dir = join(process.cwd(), 'src');
    const files = (function walk(d: string, acc: string[] = []): string[] {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue; // fixtures build tails, they do not derive
          walk(p, acc);
        } else if (entry.name.endsWith('.ts')) acc.push(p);
      }
      return acc;
    })(dir);
    // the two shapes a second reading of the triple always took: the type-ARRAY, and a
    // tail SCAN over the decided pair. Both are only legal in workflow.ts.
    const ARRAYS = [/\[\s*'submitted'\s*,\s*'confirmed'\s*,\s*'rejected'\s*\]/, /[\['"]confirmed['"]\s*,\s*['"]rejected['"]/];
    const SCAN = /(slice|some|filter|find|indexOf|includes|lastIndexOf)\(/;
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join('src', 'store', 'workflow.ts'))) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const idiom of ARRAYS) if (idiom.test(line)) offenders.push(`${relative(process.cwd(), f)}:${i + 1} — ${idiom}`);
        if (SCAN.test(line) && line.includes(".type === 'confirmed'") && line.includes(".type === 'rejected'")) {
          offenders.push(`${relative(process.cwd(), f)}:${i + 1} — a tail scan over the decided pair`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the gate-decision vocabularies, REGISTERED (AC-5)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('the schema registry and the code literal declare the SAME total mapping', () => {
    const registry = getVOCAB().gateDecisions as Record<string, string>;
    expect(registry).toEqual({ accept: 'confirmed', reject: 'rejected' });
    expect(registry).toEqual(GATE_DECISION_EVENTS); // the recorded duplicate (resource-registry §5)
    // TOTAL: every human decision maps to exactly one event type, and every mapped
    // event type is part of the triple — no third form can appear silently
    expect(Object.keys(GATE_DECISION_EVENTS).sort()).toEqual(['accept', 'reject']);
    for (const eventType of Object.values(GATE_DECISION_EVENTS)) expect(GATE_EVENT_TYPES).toContain(eventType);
    expect(new Set(Object.values(GATE_DECISION_EVENTS)).size).toBe(2); // injective
  });

  it('per gate event type: the allowed fields and the CLOSED gate set (through the single writer)', () => {
    writeNode(TASK, [ev('created')]);
    const s = new Store(root);
    // the closed gate set — the registry's, enforced by the writer
    expect(getVOCAB().gates).toEqual(['grill', 'confirm']);
    const allowed: Record<string, string[]> = {
      submitted: ['at', 'type', 'note', 'gate', 'confirmedSha'],
      confirmed: ['at', 'type', 'note', 'gate', 'feedback'],
      rejected: ['at', 'type', 'note', 'gate', 'feedback'],
    };
    for (const type of GATE_EVENT_TYPES) {
      // the whitelist's fields are accepted…
      for (const k of allowed[type]) {
        const extra: Record<string, unknown> = { gate: 'grill' };
        if (k === 'confirmedSha') extra.confirmedSha = 'abc1234';
        else if (k === 'note' || k === 'feedback') extra[k] = 'x';
        expect(() => s.appendEvent(s.resolveNode(TASK), { at: '2026-08-27', type, ...extra } as unknown as JourneyEvent), `${type}.${k} must be allowed`).not.toThrow();
      }
      // …and an unknown field is refused, per type
      expect(() => s.appendEvent(s.resolveNode(TASK), { at: '2026-08-27', type, gate: 'grill', bogus: 1 } as unknown as JourneyEvent)).toThrow(/unknown field/);
      // …and a gate OUTSIDE the closed set is refused, per type
      expect(() => s.appendEvent(s.resolveNode(TASK), { at: '2026-08-27', type, gate: 'approval' } as unknown as JourneyEvent)).toThrow(/must be one of grill\|confirm/);
    }
  });

  it('the derivation derives the registry\'s own range (a status word outside vocab.statuses cannot be produced)', () => {
    const words = new Set(getVOCAB().statuses);
    expect(words).toContain('rework'); // the word this change registered (vocab v5)
    for (const c of LIFECYCLE) expect(words).toContain(workflowState(asEvents(c.tail)).status);
  });
});
