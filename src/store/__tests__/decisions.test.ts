import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, JourneyEvent } from '../store.js';
import { DECISION_KINDS, decisionPoints, type DecisionPoint } from '../decisions.js';
import { Commands } from '../../commands/index.js';
import { runValidators } from '../../flow/validators/index.js';

/**
 * THE DECISION RECORD, DERIVED ONCE (leg 12 task 11).
 *
 * Two halves, pinned together:
 *
 *   · the DERIVATION (decisions.ts) — one pass over the event tail yields the choice
 *     points, in order, across ALL FOUR kinds (a gate decision · a resolved openQuestion
 *     · revised gate terms · a superseded artifact), with WHAT · WHEN · BY WHOM · WHY
 *     (or its honest absence);
 *   · the READERS — the `decisions` read, the `brief` payload, the card render and the
 *     generalized high-impact rule — must AGREE, on a fixture set covering every kind.
 *     A disagreement is a FAILURE, never a nuance (the 12/08 reader-agreement shape).
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const TASK = '01-leg/01-a';

function makeStore(): string {
  root = mkdtempSync(join(tmpdir(), 'ann-dec-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}

const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'], targetAreas: ['src/store'] };

function writeNode(id: string, events: Array<Record<string, unknown>>, questions: unknown[] = [], contract: unknown = CONTRACT) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, openQuestions: questions, createdAt: '2026-08-27' }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeLeg(id = '01-leg') {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract: { intent: 'the leg', acceptanceCriteria: ['the leg is done'] }, createdAt: '2026-08-27' }));
}

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
const asEvents = (tail: Array<Record<string, unknown>>) => tail as unknown as JourneyEvent[];
const commands = () => new Commands(new Store(root), 'test');

/* ══ the derivation ═════════════════════════════════════════════════════════ */

describe('decisionPoints — the ONE derivation over the tail (AC-2)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('declares its four kinds as a literal a reader can enumerate', () => {
    expect([...DECISION_KINDS]).toEqual(['gate', 'open-question', 'gate-revised', 'artifact']);
  });

  it('reads all FOUR kinds off one tail, in event order, each with its own subject', () => {
    const tail = asEvents([
      ev('created'),                                                                    // 1
      ev('submitted', { gate: 'grill' }),                                               // 2
      ev('confirmed', { gate: 'grill', feedback: 'the contract mirrors the plan', note: 'accepted (ianluo)' }), // 3
      ev('evidence', { answers: [{ id: 'Q1', answer: 'use the store, not a cache', provenance: 'discussed' }] }), // 4
      ev('gate-revised', { gate: { old: 'confirm', new: 'grill' }, note: 'terms moved (ianluo)' }), // 5
      ev('superseded', { successor: { name: 'the-old-doc', path: 'docs/old.md' }, note: 'replaced (ianluo)' }), // 6
    ]);
    const points = decisionPoints(tail, [{ id: 'Q1', question: 'which way?', blocking: true }]);

    expect(points.map((p) => p.kind)).toEqual(['gate', 'open-question', 'gate-revised', 'artifact']);
    // the event's NUMBER (1-based — the same address `brief.latestNote.index` prints)
    expect(points.map((p) => p.event)).toEqual([3, 4, 5, 6]);
    // the gate decision: what · when · who · why · the event it lives in
    expect(points[0]).toMatchObject({
      kind: 'gate', gate: 'grill', subject: 'grill', decision: 'accepted', type: 'confirmed',
      at: '2026-08-27', what: 'accepted at the grill gate', why: 'the contract mirrors the plan', by: 'ianluo',
    });
    // the resolution carries the ANSWER as the why and the how: verbatim
    expect(points[1]).toMatchObject({
      kind: 'open-question', subject: 'Q1', type: 'evidence', how: 'discussed',
      what: 'Q1 resolved: which way?', why: 'use the store, not a cache', highImpact: true,
    });
    // the revised terms name the gate they moved FROM and TO
    expect(points[2]).toMatchObject({ kind: 'gate-revised', what: 'gate terms revised: confirm → grill', by: 'ianluo' });
    // a superseded artifact's subject is the artifact that was RETIRED (successor.name is
    // the artifact it supersedes — store.ts `supersededLocks`), not the replacement's
    expect(points[3]).toMatchObject({ kind: 'artifact', subject: 'the-old-doc', what: 'artifact superseded: the-old-doc' });
    // the choice points are ordered by the event they live in — the tail's order, never
    // a per-kind grouping
    expect([...points].map((p) => p.event)).toEqual([...points].sort((a, b) => a.event - b.event).map((p) => p.event));
  });

  it('a CONFIRM ACCEPT reads its BOUND SUCCESSOR (leg 12/12) — the half accept is ONE decision', () => {
    const tail = asEvents([
      ev('created'),                                                                        // 1
      ev('submitted', { gate: 'grill' }),                                                   // 2
      ev('confirmed', { gate: 'grill' }),                                                   // 3
      ev('submitted', { gate: 'confirm' }),                                                 // 4
      ev('confirmed', { gate: 'confirm', feedback: 'the first half landed', note: 'accepted (ianluo)' }), // 5
      ev('transferred', { target: '01-leg/02-b', scope: 'AC-2: the second is done', note: 'scope moved to 01-leg/02-b (ianluo)' }), // 6
      ev('completed'),                                                                      // 7
    ]);
    const points = decisionPoints(tail);
    expect(points.map((p) => p.kind)).toEqual(['gate', 'gate']); // a transfer is not a third
    // the transfer is NOT a choice point of its own: it has no why channel, so a kind of
    // its own would read NO WHY RECORDED on every half accept — while the reason is right
    // there, on the accept it belongs to. ONE decision, read as one.
    expect(points[1]).toMatchObject({
      kind: 'gate', gate: 'confirm', decision: 'accepted',
      why: 'the first half landed', by: 'ianluo', successor: '01-leg/02-b',
    });
    // the entry gate carries no successor: a transfer rides the EXIT gate
    expect(points[0].successor).toBeUndefined();
    // …and it is the transfer that FOLLOWS the accept: a transfer recorded before it
    // belongs to whatever preceded it, never attributed forward
    const earlier = decisionPoints(asEvents([
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }),
      ev('transferred', { target: '01-leg/02-b', scope: 'AC-2: the second is done' }), // written BEFORE the accept
      ev('confirmed', { gate: 'confirm', feedback: 'accepted after the fact', note: 'accepted (ianluo)' }),
    ]));
    expect(earlier[1].gate).toBe('confirm');
    expect(earlier[1].successor).toBeUndefined(); // a transfer AFTER an accept is not read backwards
  });

  it('records BOTH directions of a gate — an accept AND a reject, each with its own why', () => {
    const tail = asEvents([
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('rejected', { gate: 'grill', feedback: 'sharpen the ACs' }),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill', feedback: 'better' }),
    ]);
    const points = decisionPoints(tail);
    expect(points.map((p) => [p.kind, p.decision, p.why])).toEqual([
      ['gate', 'rejected', 'sharpen the ACs'],
      ['gate', 'accepted', 'better'],
    ]);
    expect(points.map((p) => p.type)).toEqual(['rejected', 'confirmed']);
  });

  it('is PURE — the same tail and questions answer the same, for every caller', () => {
    const tail = asEvents([ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill', feedback: 'yes' })]);
    expect(decisionPoints(tail)).toEqual(decisionPoints(tail));
    // no questions passed = no open-question points; the gate decision is unaffected
    expect(decisionPoints(tail).map((p) => p.kind)).toEqual(['gate']);
  });

  it('an UNANSWERED question is NOT a choice point — nothing was decided', () => {
    const tail = asEvents([ev('created'), ev('evidence', { answers: [{ id: 'Q2', answer: 'other' }] })]);
    const points = decisionPoints(tail, [{ id: 'Q1', question: 'which way?', blocking: true }]);
    expect(points).toEqual([]);
  });

  it('the LAST answer for an id wins — a re-answered question is the later record', () => {
    const tail = asEvents([
      ev('created'),
      ev('evidence', { answers: [{ id: 'Q1', answer: 'first', provenance: 'inferred' }] }),
      ev('evidence', { answers: [{ id: 'Q1', answer: 'second', provenance: 'discussed' }] }),
    ]);
    const points = decisionPoints(tail, [{ id: 'Q1', question: 'which way?', blocking: true }]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ why: 'second', how: 'discussed', event: 3 });
  });

  /* AC-4 — HONEST ABSENCE. The derivation never fills a why in, and never guesses a `by`
   * the record does not carry. The reader is the thing that NAMES the gap. */
  it('AC-4 — a decision with no recorded why has NO why field (absence is data, not "")', () => {
    const tail = asEvents([
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }),                       // legacy bare accept — no feedback
      ev('gate-revised', { gate: { old: 'confirm', new: 'grill' } }), // no note → no initiator
    ]);
    const points = decisionPoints(tail);
    for (const p of points) {
      expect('why' in p).toBe(false);
      expect(p.why).toBeUndefined();
    }
    // ...and the initiator is read from the record, never assumed from the reader's own
    // identity: a note without the trailing parenthetical yields NO `by`
    expect('by' in points[0]).toBe(false);
  });
});

/* ══ the readers AGREE (AC-2) ═══════════════════════════════════════════════ */

describe('the decision readers AGREE (AC-2) — one fixture set, every choice-point kind', () => {
  beforeEach(() => {
    makeStore();
    writeLeg();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** One fixture per kind — plus a legacy one carrying NO whys at all (AC-4/AC-5: the
   *  journey's already-recorded bare accepts must still read, with their gaps NAMED). */
  const CASES: Array<{ what: string; tail: Array<Record<string, unknown>>; questions?: unknown[] }> = [
    {
      what: 'a gate decision with its why recorded',
      tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill', feedback: 'looks right', note: 'accepted (ianluo)' })],
    },
    {
      what: 'a resolved openQuestion with its how:',
      tail: [ev('created'), ev('evidence', { answers: [{ id: 'Q1', answer: 'the store', provenance: 'discussed' }] })],
      questions: [{ id: 'Q1', question: 'which way?', blocking: true }],
    },
    {
      what: 'revised gate terms',
      tail: [ev('created'), ev('gate-revised', { gate: { old: 'grill', new: 'confirm' }, note: 'moved (ianluo)' })],
    },
    {
      what: 'a superseded artifact',
      tail: [ev('created'), ev('superseded', { successor: { name: 'the-old-doc', path: 'docs/old.md' }, note: 'replaced (ianluo)' })],
    },
    {
      what: 'a LEGACY tail whose whys were never recorded',
      tail: [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed')],
    },
  ];

  for (const c of CASES) {
    it(`every reader answers the same record: ${c.what}`, () => {
      writeNode(TASK, c.tail, c.questions ?? []);
      const store = new Store(root);
      const cmds = commands();

      // 1. the derivation itself — the ONE source every reader below consumes
      const points: DecisionPoint[] = decisionPoints(asEvents(c.tail), (c.questions ?? []) as never);

      // 2. the dedicated read (ann decisions <id> — the CLI and the served card alike)
      const read = cmds.decisions(TASK);
      expect(read.decisions).toEqual(points);

      // 3. the brief payload the GATE CARD renders from — the SAME array, not a second scan
      expect(cmds.brief(TASK).decisions).toEqual(points);

      // 4. the derivation is a pure function of (tail, questions): re-reading changes nothing
      expect(cmds.decisions(TASK).decisions).toEqual(read.decisions);
      expect(store.openQuestions(TASK).length).toBe((c.questions ?? []).length);

      // 5. the missing-why list is DERIVED from the same points — every point without a
      // why is named, and no point WITH one is (AC-4)
      expect(read.missingWhy).toEqual(points.filter((p) => !p.why).map((p) => `${p.at} ${p.what} — NO WHY RECORDED`));

      // 6. NO reader invents a why: every why in the read came off the tail
      for (const p of points) {
        if (p.why !== undefined) expect(c.tail.some((e) => JSON.stringify(e).includes(p.why as string))).toBe(true);
      }
    });
  }

  it('the generalized high-impact rule keys on the SAME derivation (AC-3)', () => {
    // a blocking openQuestion, answered but DEFAULTED — the tech-stack lesson
    writeNode(TASK, [
      ev('created'),
      ev('evidence', { answers: [{ id: 'Q1', answer: 'assumed postgres', provenance: 'defaulted' }] }),
    ], [{ id: 'Q1', question: 'which store?', blocking: true }]);
    const store = new Store(root);
    const bare = runValidators(store, TASK);
    // nothing has been DECIDED yet — no gate accept, no completion — so the rule is silent
    expect(bare.filter((f) => f.code === 'high-impact-defaulted')).toEqual([]);

    // ...now a gate ACCEPT lands (the generalized trigger: it used to require `completed`)
    writeNode(TASK, [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill', feedback: 'proceed' }),
      ev('evidence', { answers: [{ id: 'Q1', answer: 'assumed postgres', provenance: 'defaulted' }] }),
    ], [{ id: 'Q1', question: 'which store?', blocking: true }]);
    const after = runValidators(new Store(root), TASK);
    const f = after.find((x) => x.code === 'high-impact-defaulted');
    expect(f).toBeDefined();
    expect(f!.detail).toContain('gate-accepted');
    expect(f!.detail).toContain("Q1 resolved as 'defaulted'");
    // and the SAME points the read exposes are what the rule keyed on
    const q = decisionPoints(asEvents([ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill', feedback: 'proceed' })]), [{ id: 'Q1', blocking: true }]);
    expect(q.some((p) => p.kind === 'gate' && p.decision === 'accepted')).toBe(true);
  });
});
