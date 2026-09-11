import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, JourneyEvent } from '../../store/store.js';
import { Commands, CommandResult } from '../index.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';

/**
 * L1 — the command surface. These tests pin the INVARIANTS the composites encode:
 * anything that can be reached around a composite is a hole in the invariant it owns.
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);

/** store.spawn writes node.json INTO a node folder that must already exist on disk — the
 *  docs-as-git refactor stopped pre-creating node folders (only fixture writeNode makes
 *  them). A test that SPAWNS a live node pre-creates its folder first, exactly the way a
 *  fixture node's folder exists before its files are written. */
const mkNodeDir = (id: string) => {
  mkdirSync(nodeDir(id), { recursive: true });
  return id;
};

function makeStore(): string {
  root = mkdtempSync(join(tmpdir(), 'ann-cmd-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}

function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>> = [], createdAt = '2026-08-27') {
  mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt }));
  if (events.length) writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };

/** Narrow a CommandResult to its error (a failed assertion here means it succeeded). */
const errorOf = <T>(r: CommandResult<T>): { code: string; blocker: string } => {
  if (r.ok) throw new Error('expected the command to fail, but it succeeded');
  return r.error;
};
const valueOf = <T>(r: CommandResult<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.blocker}`);
  return r.value;
};

const cmds = () => new Commands(new Store(root), 'test');

/** A sha that RESOLVES in the ann repo — required for evidence.commits[] that check()
 *  traces (`git cat-file -t`, run against process.cwd()). */
const realSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim().slice(0, 7);

describe('spawn! — the contract schema gate (core-design §1, §8:289)', () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', {}); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('enforces the v14 §2 REQUIRED set', () => {
    expect(errorOf(cmds().spawn('01-leg/01-a', { acceptanceCriteria: ['x'] })).code).toBe('contract-schema');
    expect(errorOf(cmds().spawn('01-leg/01-a', { intent: 'x', acceptanceCriteria: [] })).code).toBe('contract-schema');
    expect(errorOf(cmds().spawn('01-leg/01-a', { intent: 'x' })).code).toBe('contract-schema');
  });

  it('refuses an unknown contract field — a silent typo is a contract that does not say what it means', () => {
    const e = errorOf(cmds().spawn('01-leg/01-a', { ...CONTRACT, acceptanceCritera: ['typo'] }));
    expect(e.code).toBe('contract-schema');
    expect(e.blocker).toContain('acceptanceCritera');
  });

  it('accepts the v14 optional fields, and openQuestions as a TOP-LEVEL sibling', () => {
    mkNodeDir('01-leg/01-a');
    const r = cmds().spawn('01-leg/01-a', {
      contract: { ...CONTRACT, workType: 'implementation', model: 'm', targetAreas: ['src/'] },
      openQuestions: [{ id: 'Q1', question: 'which?' }],
    });
    expect(valueOf(r)).toEqual({ id: '01-leg/01-a', kind: 'task' });
    const written = JSON.parse(readFileSync(join(nodeDir('01-leg/01-a'), 'node.json'), 'utf8'));
    expect(written.openQuestions).toHaveLength(1);
    expect(written.contract.openQuestions).toBeUndefined();
  });

  it('rejects F-AC19 unresolvable requiredInputs (hard reject at the write path)', () => {
    const e = errorOf(cmds().spawn('01-leg/01-a', { ...CONTRACT, requiredInputs: ['nothing-locks-this'] }));
    expect(e.code).toBe('F-AC19');
  });

  it('enforces id naming, sibling and prefix uniqueness', () => {
    expect(errorOf(cmds().spawn('01-leg/nope', CONTRACT)).code).toBe('id-naming');
    expect(errorOf(cmds().spawn('01-leg/01-this-segment-is-way-too-long-for-the-cap-now', CONTRACT)).code).toBe('id-naming');
    mkNodeDir('01-leg/01-a');
    valueOf(cmds().spawn('01-leg/01-a', CONTRACT));
    expect(errorOf(cmds().spawn('01-leg/01-a', CONTRACT)).code).toBe('exists');
    expect(errorOf(cmds().spawn('01-leg/01-b', CONTRACT)).code).toBe('prefix-clash');
  });

  it('allows grammar-named worktype segments up to the 40-char cap (v15: <NN>-<worktype>-<slug>)', () => {
    mkNodeDir('01-leg/27-implementation-journey-format-v15');
    valueOf(cmds().spawn('01-leg/27-implementation-journey-format-v15', CONTRACT)); // 35 chars, worktype-tagged — the v15 grammar name spawns
    expect(errorOf(cmds().spawn('01-leg/27-implementation-journey-format-v15', CONTRACT)).code).toBe('exists');
  });

  it('holds the conclusion gate on a TASK parent (commit evidence), and does not consult it at depth 2', () => {
    mkNodeDir('01-leg/01-a');
    valueOf(cmds().spawn('01-leg/01-a', CONTRACT)); // depth 2: the leg parent is never gated
    expect(errorOf(cmds().spawn('01-leg/01-a/01-child', CONTRACT)).code).toBe('conclusion-gate');
  });

  it('holds the leg gate on a new leg', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    expect(errorOf(cmds().spawn('02-next', CONTRACT)).code).toBe('leg-gate');
  });

  it('retires the description.md write (v13: a node dir is node.json — no description.md)', () => {
    mkNodeDir('01-leg/01-a');
    valueOf(cmds().spawn('01-leg/01-a', CONTRACT));
    expect(existsSync(join(nodeDir('01-leg/01-a'), 'description.md'))).toBe(false);
  });
});

describe('submit! + gate! — the two-write gate sequence (core-design §4)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('submit! alone blocks the task — an interrupted gate is resumable, not un-started', () => {
    const c = cmds();
    valueOf(c.submit('01-leg/01-a', 'grill'));
    expect(c.status('01-leg/01-a')).toBe('blocked');
    expect(errorOf(c.submit('01-leg/01-a', 'grill')).code).toBe('already-submitted');
  });

  it('submit!(confirm) records the gate② content binding, and the sha must be a sha', () => {
    const c = cmds();
    valueOf(c.gate('01-leg/01-a', 'grill', 'accept'));
    expect(errorOf(c.submit('01-leg/01-a', 'confirm', { confirmedSha: 'not-a-sha' })).code).toBe('store-refused');
    valueOf(c.submit('01-leg/01-a', 'confirm', { confirmedSha: 'abc1234' }));
    const submitted = c.events('01-leg/01-a').filter((e) => e.type === 'submitted' && e.gate === 'confirm');
    expect(submitted[0].confirmedSha).toBe('abc1234');
  });

  it('THE FIXED COMPOSITE PREDICATE: after a rejection, gate! re-submits so a rework re-enters blocked', () => {
    const c = cmds();
    valueOf(c.gate('01-leg/01-a', 'grill', 'reject', 'not yet'));
    // v13 checked only for a later `confirmed`, so it saw the decided submission as
    // still pending and skipped the write — the rework never re-entered `blocked`.
    valueOf(c.submit('01-leg/01-a', 'grill'));
    expect(c.status('01-leg/01-a')).toBe('blocked');
    const c2 = cmds();
    valueOf(c2.gate('01-leg/01-a', 'grill', 'accept'));
    expect(c2.events('01-leg/01-a').filter((e) => e.type === 'submitted')).toHaveLength(2);
  });

  it('gate! auto-submits when nothing is pending, and never double-submits', () => {
    const c = cmds();
    valueOf(c.gate('01-leg/01-a', 'grill', 'accept'));
    const evs = c.events('01-leg/01-a');
    expect(evs.filter((e) => e.type === 'submitted')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'confirmed')).toHaveLength(1);
  });

  it('G1: a gate accept with a rationale persists it as feedback on the confirmed event', () => {
    const c = cmds();
    valueOf(c.gate('01-leg/01-a', 'grill', 'accept', 'looks right — the contract mirrors the plan'));
    const confirmed = c.events('01-leg/01-a').find((e) => e.type === 'confirmed' && e.gate === 'grill');
    expect(confirmed!.feedback).toBe('looks right — the contract mirrors the plan');
    // an accept with no rationale records no feedback field
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept'));
    const confirm2 = c.events('01-leg/01-a').find((e) => e.type === 'confirmed' && e.gate === 'confirm');
    expect(confirm2!.feedback).toBeUndefined();
  });

  it('owns the 3-reject bound as a CONSTANT and surfaces only {escalated}', () => {
    for (let i = 0; i < 2; i++) expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).escalated).toBe(false);
    expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).escalated).toBe(true);
    expect(errorOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).code).toBe('reject-bound');
    // the bound is PER GATE, and never blocks an accept
    expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'accept')).escalated).toBe(true);
  });

  it('the store refuses a confirm gate with no confirmed grill (the sequence is L0-enforced)', () => {
    expect(errorOf(cmds().gate('01-leg/01-a', 'confirm', 'accept')).code).toBe('store-refused');
  });
});

describe('append! — refuses what the composites own (§8:289)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('refuses every composite-owned kind and names the owner', () => {
    const c = cmds();
    for (const [type, owner] of [
      ['created', 'spawn!'],
      ['submitted', 'submit!'],
      ['confirmed', 'gate!'],
      ['rejected', 'gate!'],
      ['goal-met', 'goal!'],
    ]) {
      const e = errorOf(c.append('01-leg/01-a', ev(type) as JourneyEvent));
      expect(e.code).toBe('composite-owned');
      expect(e.blocker).toContain(owner);
    }
  });

  it('refuses the RETIRED doc-artifact kinds (artifact-locked / superseded) as retired-kind (D3)', () => {
    const c = cmds();
    for (const type of ['artifact-locked', 'superseded']) {
      const e = errorOf(c.append('01-leg/01-a', ev(type) as JourneyEvent));
      expect(e.code).toBe('retired-kind');
      expect(e.blocker).toContain('retired with the docs-as-git refactor');
    }
  });

  it('passes the kinds no composite owns — the frame writes its lifecycle through here', () => {
    const c = cmds();
    for (const type of ['activated', 'evidence', 'waiting', 'extended']) {
      expect(c.append('01-leg/01-a', ev(type) as JourneyEvent).ok).toBe(true);
    }
  });

  it('passing append! does NOT loosen the gate sequence — the store still refuses `completed` before gate②', () => {
    const c = cmds();
    expect(errorOf(c.append('01-leg/01-a', ev('completed') as JourneyEvent)).blocker).toContain('GATE-2');
    valueOf(c.gate('01-leg/01-a', 'grill', 'accept'));
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept'));
    expect(c.append('01-leg/01-a', ev('completed') as JourneyEvent).ok).toBe(true);
  });

  it('still fails closed on the store schema', () => {
    expect(errorOf(cmds().append('01-leg/01-a', ev('evidence', { bogus: 1 }) as JourneyEvent)).code).toBe('store-refused');
  });

  it('records `cancelled` through append! — with a REQUIRED reason (leg 08 task 01)', () => {
    const c = cmds();
    // a missing / blank / non-string reason is refused at the single writer
    for (const extra of [{}, { reason: '   ' }, { reason: 42 }]) {
      const e = errorOf(c.append('01-leg/01-a', ev('cancelled', extra) as JourneyEvent));
      expect(e.code).toBe('store-refused');
      expect(e.blocker).toContain('cancelled requires a reason');
    }
    // with a reason it records — ANY initiator (append-style bookkeeping, never a gate decision)
    expect(valueOf(c.append('01-leg/01-a', ev('cancelled', { reason: 'the goal shrank — no longer needed' }) as JourneyEvent))).toBeUndefined();
    expect(c.status('01-leg/01-a')).toBe('cancelled');
    // provenance: the initiator is stamped onto the record (RECORDED_BY), like the composites' notes
    expect(c.events('01-leg/01-a').find((e) => e.type === 'cancelled')!.note).toContain('test');
  });
});

describe('evidence! + complete! — the close gesture commands (leg 08 task 02)', () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', CONTRACT); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** The gates a task walks to a confirm-gate ACCEPT (grill then confirm). */
  const GATE = [ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })];
  const accepted = (extra: Array<Record<string, unknown>> = []) => writeNode('01-leg/01-a', CONTRACT, [ev('created'), ...GATE, ...extra]);

  it('evidence! records the conclusion — commits[] (+ optional refs[] · claims[] · checks[]) with the initiator provenance', () => {
    accepted();
    const c = cmds();
    expect(valueOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234', note: 'the deliverable' }], { refs: ['src/store'] }))).toEqual({ commits: 1, refs: 1, claims: 0, checks: 0 });
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.type).toBe('evidence');
    expect(e.commits).toEqual([{ sha: 'abc1234', note: 'the deliverable' }]);
    expect(e.refs).toEqual(['src/store']);
    expect(String(e.note)).toContain('test');
    // the conclusion EVIDENCE is not the terminal — an accepted task stays accepted
    expect(c.status('01-leg/01-a')).toBe('accepted');
  });

  it('evidence! carries the STRUCTURED conclusion too (v18: claims per AC + the checks run)', () => {
    accepted();
    const c = cmds();
    const claims = [{ ac: 'AC-1', statement: 'the store holds it', evidence: ['abc1234', 'src/store'] }];
    const checks = [{ command: 'npm test', result: 'pass' as const, detail: '3/3', sha: 'abc1234' }];
    expect(valueOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { claims, checks }))).toEqual({ commits: 1, refs: 0, claims: 1, checks: 1 });
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.claims).toEqual(claims);
    expect(e.checks).toEqual(checks);
    // the SHAPE stays the store's: a malformed claim is refused through this front too
    const bad = errorOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { claims: [{ ac: 'AC-1' }] }));
    expect(bad.code).toBe('store-refused');
    expect(bad.blocker).toContain("needs 'statement'");
  });

  it('evidence! refuses the shapes a conclusion cannot have (named refusals, nothing written)', () => {
    accepted();
    const c = cmds();
    expect(errorOf(c.evidence('01-leg', [{ sha: 'abc1234' }])).code).toBe('leg-gate-write');
    expect(errorOf(c.evidence('01-leg/09-x', [{ sha: 'abc1234' }])).code).toBe('no-node');
    expect(errorOf(c.evidence('01-leg/01-a', [])).code).toBe('no-commits');
    expect(errorOf(c.evidence('01-leg/01-a', [{ sha: '   ' }])).code).toBe('bad-commit');
    expect(errorOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { refs: [''] })).code).toBe('bad-ref');
    expect(c.events('01-leg/01-a').filter((e) => e.type === 'evidence')).toEqual([]);
  });

  it('the commits[] shape stays the STORE\'s — an empty commit list is refused through the general append too (one validator)', () => {
    accepted();
    const e = errorOf(cmds().append('01-leg/01-a', ev('evidence', { commits: [] }) as JourneyEvent));
    expect(e.code).toBe('store-refused');
    expect(e.blocker).toContain('concludes nothing');
  });

  /** A COMPLIANT v18 conclusion: a claim for every contract AC + a passing check bound to
   *  a cited commit (the sha the checks ran against) — what `complete!` now requires. */
  const conclude = (c: Commands, id: string, sha: string) =>
    c.evidence(id, [{ sha }], {
      claims: [{ ac: 'AC-1', statement: 'the AC is met', evidence: [sha] }],
      checks: [{ command: 'npm test', result: 'pass' as const, detail: '3/3', sha }],
    });

  it('complete! records the DONE terminal on an accepted + evidenced task', () => {
    accepted();
    const c = cmds();
    conclude(c, '01-leg/01-a', realSha());
    expect(valueOf(c.complete('01-leg/01-a')).at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.status('01-leg/01-a')).toBe('done');
    expect(String(c.events('01-leg/01-a').at(-1)!.note)).toContain('test');
    expect(c.check()).toEqual([]); // the conclusion is complete: evidence resolves + the gate is cited
  });

  // v18 — the CONCLUSION GATE: the close is a review, so it refuses a thin conclusion.
  // (Each case starts from a FRESH accepted task: the fixture's own shape is rewritten.)
  const ID = '01-leg/01-a';

  it('complete! refuses when an AC carries no claim — named, with the AC listed, nothing written', () => {
    accepted();
    const c = cmds();
    c.evidence(ID, [{ sha: realSha() }], { checks: [{ command: 'npm test', result: 'pass', sha: realSha() }] });
    const e = errorOf(c.complete(ID));
    expect(e.code).toBe('no-structured-conclusion');
    expect(e.blocker).toContain('carry no claim');
    expect(e.blocker).toContain("'AC-1'");
    expect(e.blocker).toContain('--claims');
    expect(c.status(ID)).toBe('accepted'); // nothing was written
    // the derivation the CARD renders is the one that refused
    expect(c.conclusion(ID).unclaimed).toEqual([{ ac: 'AC-1', acText: 'it is done' }]);
  });

  it('complete! refuses when no PASSING check is bound to a cited commit — no checks · a foreign sha · a failing check', () => {
    // one node per case: the fixture hand-writes node.json/events.jsonl, and the store's
    // ledger guard (correctly) refuses a WRITE over a node that was rewritten behind it.
    const at = (id: string) => writeNode(id, CONTRACT, [ev('created'), ...GATE]);
    const close = (id: string, opts: Parameters<Commands['evidence']>[2]) => {
      at(id);
      const c = cmds();
      valueOf(c.evidence(id, [{ sha: realSha() }], opts));
      return { c, err: errorOf(c.complete(id)) };
    };
    // (a) claims, but no checks at all
    const a = close('01-leg/02-nochecks', { claims: [{ ac: 'AC-1', statement: 'met', evidence: [realSha()] }] });
    expect(a.err.code).toBe('no-structured-conclusion');
    expect(a.err.blocker).toContain('no checks');
    // (b) a passing check bound to a sha the task does NOT cite (verification of nothing)
    const b = close('01-leg/03-foreign', {
      claims: [{ ac: 'AC-1', statement: 'met', evidence: [realSha()] }],
      checks: [{ command: 'npm test', result: 'pass', sha: 'deadbeef00000000000000000000000000000000' }],
    });
    expect(b.err.code).toBe('no-structured-conclusion');
    expect(b.err.blocker).toContain('none PASSING against a cited commit');
    expect(b.c.status('01-leg/03-foreign')).toBe('accepted'); // nothing written
    // (c) a FAILING check does not satisfy it
    const d = close('01-leg/04-failing', {
      claims: [{ ac: 'AC-1', statement: 'met', evidence: [realSha()] }],
      checks: [{ command: 'npm test', result: 'fail', detail: '1 failed', sha: realSha() }],
    });
    expect(d.err.code).toBe('no-structured-conclusion');
    expect(d.c.status('01-leg/04-failing')).toBe('accepted');
  });

  it('a claim recorded in a LATER evidence event counts (the rework model) — matched by the AC text or its AC-N', () => {
    accepted();
    const c = cmds();
    const sha = realSha();
    c.evidence(ID, [{ sha }]); // evidence first — thin
    expect(errorOf(c.complete(ID)).code).toBe('no-structured-conclusion');
    // the claim names the criterion by its TEXT, the check passes against the cited commit
    c.evidence(ID, [{ sha }], { claims: [{ ac: 'it is done', statement: 'met — the criterion named by its text', evidence: [sha] }] });
    c.evidence(ID, [{ sha }], { checks: [{ command: 'npm test', result: 'pass', detail: '3/3', sha }] });
    expect(valueOf(c.complete(ID)).at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.check()).toEqual([]);
  });

  it('complete! refuses without the human ACCEPT — none · rejected · an undecided re-submission after an accept', () => {
    // (a) submitted at the confirm gate, never decided
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' })]);
    expect(errorOf(cmds().complete('01-leg/01-a')).code).toBe('not-accepted');
    // (b) rejected
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ...GATE, ev('rejected', { gate: 'confirm', feedback: 'not this' })]);
    expect(errorOf(cmds().complete('01-leg/01-a')).code).toBe('not-accepted');
    // (c) accepted, then RE-SUBMITTED — the LAST decision is the open submission
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' })]);
    const c = cmds();
    const e = errorOf(c.complete('01-leg/01-a'));
    expect(e.code).toBe('not-accepted');
    expect(e.blocker).toContain('last decision: submitted');
  });

  it('complete! refuses without conclusion evidence and names the command to run (F-AC18)', () => {
    accepted();
    const e = errorOf(cmds().complete('01-leg/01-a'));
    expect(e.code).toBe('no-evidence');
    expect(e.blocker).toContain('evidence!');
    expect(cmds().status('01-leg/01-a')).toBe('accepted'); // the honest intermediate state STANDS
  });

  it('AC-2 RESOLVED: gate! confirm accept does NOT auto-complete — `accepted` stands until complete!', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const c = cmds();
    conclude(c, '01-leg/01-a', realSha());
    valueOf(c.submit('01-leg/01-a', 'confirm'));
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'looks right'));
    // the human accepted a task that ALREADY carried commit evidence — still not done:
    // gates decide, commands complete (the gate writes the decision, never the delivery)
    expect(c.status('01-leg/01-a')).toBe('accepted');
    valueOf(c.complete('01-leg/01-a'));
    expect(c.status('01-leg/01-a')).toBe('done');
    expect(c.check()).toEqual([]);
  });

  it('complete! is recorded once, and never on a leg root or an unknown node', () => {
    accepted();
    const c = cmds();
    conclude(c, '01-leg/01-a', 'abc1234');
    valueOf(c.complete('01-leg/01-a'));
    expect(errorOf(c.complete('01-leg/01-a')).code).toBe('already-completed');
    expect(errorOf(c.complete('01-leg')).code).toBe('leg-gate-write');
    expect(errorOf(c.complete('01-leg/09-x')).code).toBe('no-node');
  });

  it('adds NO new write path — every event lands through the single writer', () => {
    accepted();
    const c = cmds();
    conclude(c, '01-leg/01-a', 'abc1234');
    valueOf(c.complete('01-leg/01-a'));
    expect(c.events('01-leg/01-a').map((e) => e.type)).toEqual(['created', 'submitted', 'confirmed', 'submitted', 'confirmed', 'evidence', 'completed']);
    expect(c.verify()).toEqual([]);
  });
});

describe('the task-close vocabulary — closed-set parity in the derived views (leg 08 task 01)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const CANCEL = ev('cancelled', { reason: 'the goal shrank — no longer needed' });
  const seedGoal = () => writeNode('01-goal', CONTRACT, [ev('created'), ev('completed')]);

  it('a cancelled task is never proposed as ready — frontmostReady/advance skip it for the open sibling', () => {
    writeNode('01-leg', CONTRACT);
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), CANCEL]);
    writeNode('01-leg/02-b', CONTRACT, [ev('created')]);
    const c = cmds();
    expect(c.frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/02-b', status: 'queued' });
    expect(c.advance().detail).toContain('next task: 01-leg/02-b');
  });

  it('a leg whose only task was cancelled derives done — the session reaches structural exhaustion', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), CANCEL]);
    const g = valueOf(cmds().goal());
    expect(g.structural.exhausted).toBe(true);
    expect(g.verdict).toBe('unconfirmed');
  });

  it('cancelling a task stuck at an undecided submission IS the escape hatch — the session can then be sealed', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' })]);
    expect(valueOf(cmds().goal()).structural.exhausted).toBe(false); // the stray submission blocks the session
    expect(errorOf(cmds().goalVerdict('met')).code).toBe('undecided-submission');
    // the human records the cancellation through the single writer…
    valueOf(cmds().append('02-work/01-a', CANCEL as JourneyEvent));
    // …and the task no longer holds the session open (the leg derives done, the submission is moot)
    expect(cmds().status('02-work/01-a')).toBe('cancelled');
    expect(valueOf(cmds().goal()).structural.exhausted).toBe(true);
    expect(valueOf(cmds().goalVerdict('met')).verdict).toBe('met');
  });

  it('the accepted-but-uncompleted state is NOT runnable and NOT done — advance stops at the closure boundary', () => {
    writeNode('01-leg', CONTRACT);
    writeNode('01-leg/01-a', CONTRACT, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
    ]);
    const c = cmds();
    expect(c.statuses('01-leg/01-a')[0].status).toBe('accepted');
    expect(c.frontmostReady()).toBeUndefined();
    const a = c.advance();
    expect(a.action).toBe('closure-needed');
    expect(a.detail).not.toContain('next task:');
  });
});

describe('the `deferred` terminal — closed-set parity in the derived views (leg 09)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const DEFER = ev('deferred', { reason: 'the server slice takes priority — this work returns as its own later leg' });
  const seedGoal = () => writeNode('01-goal', CONTRACT, [ev('created'), ev('completed')]);

  it('records `deferred` through append! — any initiator, with the reason the store requires', () => {
    writeNode('01-leg', CONTRACT);
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    const c = cmds();
    expect(valueOf(c.append('01-leg/01-a', DEFER as JourneyEvent))).toBeUndefined();
    expect(c.status('01-leg/01-a')).toBe('deferred');
    expect(c.events('01-leg/01-a').find((e) => e.type === 'deferred')!.reason).toContain('the server slice takes priority');
  });

  it('a deferred task is never proposed as ready — frontmostReady/advance skip it for the open sibling', () => {
    writeNode('01-leg', CONTRACT);
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), DEFER]);
    writeNode('01-leg/02-b', CONTRACT, [ev('created')]);
    const c = cmds();
    expect(c.frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/02-b', status: 'queued' });
    expect(c.advance().detail).toContain('next task: 01-leg/02-b');
  });

  it('a leg whose only task was deferred derives done — the session reaches structural exhaustion', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), DEFER]);
    const g = valueOf(cmds().goal());
    expect(g.structural.exhausted).toBe(true);
    expect(g.verdict).toBe('unconfirmed');
  });

  it('deferring a task stuck at an undecided submission leaves the sweep clean — the goal verdict can be recorded', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' })]);
    expect(valueOf(cmds().goal()).structural.exhausted).toBe(false); // the stray submission blocks the session
    expect(errorOf(cmds().goalVerdict('met')).code).toBe('undecided-submission');
    valueOf(cmds().append('02-work/01-a', DEFER as JourneyEvent)); // the human postpones the work
    expect(cmds().status('02-work/01-a')).toBe('deferred'); // the undecided submission no longer re-derives blocked
    expect(valueOf(cmds().goal()).structural.exhausted).toBe(true);
    expect(valueOf(cmds().goalVerdict('met')).verdict).toBe('met');
  });
});

describe('lock! — the THIN artifact record (one current per name; any file; never touches the file)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Write a deliverable into a node's OWN artifacts/ dir; returns its project-relative path. */
  const deliverable = (id: string, name: string, body: string): string => {
    const p = join(nodeDir(id), 'artifacts', name);
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(p, body);
    return `.ann/journey/legs/${id}/artifacts/${name}`;
  };

  it('records a THIN artifact over the producer\'s own file — bytes untouched, no stamp, no symlink', () => {
    const rel = deliverable('01-leg/01-a', 'my-spec.md', '# body\n');
    const before = readFileSync(join(root, rel), 'utf8');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'my-spec.md'));
    // contentPath IS the recorded path (the producer's own file — ann never copies)
    expect(locked.contentPath).toBe(rel);
    expect(locked.path).toBe(rel);
    // AC1: the file on disk is byte-identical after the lock — no marker, no re-write
    expect(readFileSync(join(root, rel), 'utf8')).toBe(before);
    // the event records {name, path, lockSha, version} — and NO docs/ layer appears;
    // the recorded name is the FILE's stem (my-spec.md → my-spec)
    const evt = cmds().events('01-leg/01-a').find((e) => e.type === 'artifact-locked');
    expect(evt!.artifact).toMatchObject({ name: 'my-spec', path: rel, version: 1 });
    expect(evt!.artifact!.lockSha).toMatch(/^[0-9a-f]{7}$/);
    expect(existsSync(join(root, '.ann', 'docs'))).toBe(false);
  });

  it('locks ANY file type — a .js deliverable locks (F3 gone)', () => {
    const rel = deliverable('01-leg/01-a', 'tool.js', 'export const x = 1;\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'tool.js'));
    expect(locked.name).toBe('tool'); // the stem of tool.js
    expect(locked.path).toBe(rel);
    expect(locked.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(readFileSync(join(root, rel), 'utf8')).toBe('export const x = 1;\n'); // bytes untouched
  });

  it('records the optional free-form type tag; unknown types are NOT refused (F2 gone)', () => {
    deliverable('01-leg/01-a', 'x.md', 'x\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'x.md', { type: 'script' }));
    expect(locked.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(cmds().events('01-leg/01-a').find((e) => e.type === 'artifact-locked')!.artifact!.type).toBe('script');
    // no type → the event omits it (a distinct name is current alongside x — per-name)
    deliverable('01-leg/01-a', 'y.md', 'y\n');
    valueOf(new Commands(new Store(root), 'test').lock('01-leg/01-a', 'y.md'));
    expect(new Store(root).events('01-leg/01-a').find((e) => e.type === 'artifact-locked' && e.artifact?.name === 'y')!.artifact!.type).toBeUndefined();
  });

  it('derives N from the LOG — one current per name; the next version follows the recorded locks', () => {
    // 01-leg/01-a produces my-spec (v1) and concludes (both gates + completed); the v1
    // lock is fixture-written history — the same artifact-locked event a live lock! writes.
    writeNode('01-leg/01-a', CONTRACT, [
      ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
      ev('artifact-locked', { artifact: { name: 'my-spec', path: '.ann/journey/legs/01-leg/01-a/artifacts/my-spec.md', lockSha: 'aaaaaaa', version: 1 } }),
    ]);
    deliverable('01-leg/01-a', 'my-spec.md', 'v1\n');
    writeNode('01-leg/02-b', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    deliverable('01-leg/02-b', 'my-spec.md', 'v2\n');
    // one current per name — the successor must wait for the old locker to step aside
    expect(errorOf(new Commands(new Store(root), 'test').lock('01-leg/02-b', 'my-spec.md')).code).toBe('already-current');
    // step the DONE locker aside via a recorded `superseded` — written as LOG HISTORY
    // (the docs-as-git refactor retired the supersede! command, so no live write produces
    // this; the resolver still reads a historical supersession to drop the old producer
    // from `current`, which is how an archived session's version chain stays coherent).
    writeNode('01-leg/01-a', CONTRACT, [
      ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
      ev('artifact-locked', { artifact: { name: 'my-spec', path: '.ann/journey/legs/01-leg/01-a/artifacts/my-spec.md', lockSha: 'aaaaaaa', version: 1 } }),
      ev('superseded', { successor: { name: 'my-spec', path: '.ann/journey/legs/01-leg/02-b/artifacts/my-spec.md' } }),
    ]);
    const locked = valueOf(new Commands(new Store(root), 'test').lock('01-leg/02-b', 'my-spec.md'));
    expect(locked.contentPath).toBe('.ann/journey/legs/01-leg/02-b/artifacts/my-spec.md');
    // the version is recorded on the lock event — N is deterministic from the log
    const lockEvent = new Store(root).events('01-leg/02-b').find((e) => e.type === 'artifact-locked');
    expect((lockEvent!.artifact as { version?: number }).version).toBe(2);
  });

  it('refuses a file that does not exist (no-file)', () => {
    expect(errorOf(cmds().lock('01-leg/01-a', 'missing.md')).code).toBe('no-file');
  });

  it('write confinement (AC-5): an out-of-folder write target is refused / unrepresentable', () => {
    deliverable('01-leg/01-a', 'my-spec.md', '# body\n');
    // a single artifacts-relative segment is the ONLY shape lock! accepts — anything that
    // could reach outside the node's own artifacts/ dir is refused (a separator, `..`, an
    // absolute path, empty)
    for (const bad of ['../escape.md', 'sub/dir.md', '/abs/path.md', '..', '.', 'a\\b.md', '']) {
      expect(errorOf(cmds().lock('01-leg/01-a', bad)).code).toBe('outside-artifacts');
    }
    // even an EXISTING file outside artifacts/ is refused — lock! only ever records the
    // addressed node's own producer file
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'x\n');
    expect(errorOf(cmds().lock('01-leg/01-a', '../outside.md')).code).toBe('outside-artifacts');
    expect(readFileSync(outside, 'utf8')).toBe('x\n'); // untouched — no write ever aimed there
  });
});

describe('verify — the DRIFT read (the mirror direction of check)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes through a clean store as clean', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    expect(cmds().verify()).toEqual([]);
  });

  it('treats a stray artifacts/ file as INERT — the doc-artifact drifts retired with docs-as-git (D4 gone)', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'stray.md'), 'x\n');
    // verify() no longer reconciles record→disk artifact files — outputs are docs at docs/
    expect(cmds().verify()).toEqual([]);
  });

  it('surfaces an events.jsonl dir the store does not key (node.json is the load key)', () => {
    const ghost = join(nodeDir('01-leg'), '10-ghost');
    mkdirSync(ghost, { recursive: true });
    writeFileSync(join(ghost, 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    expect(cmds().verify().some((p) => p.startsWith('node-orphan: 01-leg/10-ghost'))).toBe(true);
  });
});

// supersede! is DELETED in the docs-as-git refactor (D3): a rework re-writes the staged
// docs/<name>.md — there is no lock to supersede. Its one remaining trace in the log is
// history read by the legacy current() resolver (exercised in the lock! N-derivation test).

describe('read — the L1 content view (core-design §5)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('serves the content verbatim so what a caller reads hashes to what was locked', () => {
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'my-spec.md'), '# body\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'my-spec.md'));
    const r = valueOf(new Commands(new Store(root), 'test').read('my-spec'));
    expect(r.content).toBe('# body\n');
    expect(r.sha).toBe(locked.sha);
    expect(r.provenance).toBe('derived-from');
  });

  it('fails closed on an unresolvable name', () => {
    expect(errorOf(cmds().read('nope')).code).toBe('unresolved');
  });

  it('resolves a DOC through the manifest (the forward path) before falling back to current()', () => {
    // docs/spec.md wins over a legacy artifact-locked 'spec' of the same logical name
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'spec.md'), '<!-- draft -->\n# The Spec\n\nbody\n');
    writeDocsManifest(root, scanDocsDir(root));
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'spec.md'), '# legacy spec\n');
    valueOf(cmds().lock('01-leg/01-a', 'spec.md'));
    const r = valueOf(new Commands(new Store(root), 'test').read('spec'));
    expect(r.path).toBe('docs/spec.md');
    expect(r.content).toBe('# The Spec\n\nbody\n'); // marker-stripped, matching the doc sha
    expect(r.sha).toMatch(/^[0-9a-f]{7}$/);
    // an unindexed name still falls back to the legacy current() reader
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'legacy-doc.md'), '# old\n');
    valueOf(cmds().lock('01-leg/01-a', 'legacy-doc.md'));
    const legacy = valueOf(new Commands(new Store(root), 'test').read('legacy-doc'));
    expect(legacy.path).toBe('.ann/journey/legs/01-leg/01-a/artifacts/legacy-doc.md');
  });
});

describe('ledger — the write-rev ledger read + the store-external guard', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    mkNodeDir('01-leg/01-a'); // the store writes a spawn into a folder that already exists
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('exposes the rev + per-node last-write after a CLI write', () => {
    const c = cmds();
    expect(valueOf(c.spawn('01-leg/01-a', CONTRACT)).kind).toBe('task');
    const view = c.ledger();
    expect(view.rev).toBeGreaterThanOrEqual(1);
    expect(view.nodes['01-leg/01-a'].lastRev).toBeGreaterThan(0);
    expect(view.nodes['01-leg/01-a'].eventsSha).toMatch(/^[0-9a-f]{40}$/);
    expect(view.nodes['01-leg/01-a'].lastEventAt.length).toBeGreaterThan(0);
  });

  it('verify surfaces an external edit and append! fails store-refused with the verify hint', () => {
    const c = cmds();
    c.spawn('01-leg/01-a', CONTRACT);
    appendFileSync(join(nodeDir('01-leg/01-a'), 'events.jsonl'), JSON.stringify({ at: '2026-08-27', type: 'extended', note: 'forged' }) + '\n');
    expect(c.verify().some((d) => d.startsWith('store-external:'))).toBe(true);
    const r = c.append('01-leg/01-a', { at: '2026-08-27', type: 'extended', note: 'after' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('store-refused');
      expect(r.error.blocker).toContain('ann verify');
    }
  });
});

describe('goal! met — the HUMAN verdict (goal-session-design §4)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** v6 — the seeded childless goal leg (created+completed on its root → done). */
  const seedGoal = () => writeNode('01-goal', CONTRACT, [ev('created'), ev('completed')]);
  /** A structurally-exhausted session: a done work leg under the seeded goal. */
  const exhausted = () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('completed')]);
  };
  /** The met state: an exhausted session sealed by a HUMAN verdict. */
  const met = () => {
    exhausted();
    valueOf(cmds().goalVerdict('met', 'all criteria confirmed'));
  };

  it('refuses an AUTOMATED (agent) initiator — the verdict is a human call', () => {
    exhausted();
    const e = errorOf(new Commands(new Store(root), 'agent').goalVerdict('met'));
    expect(e.code).toBe('human-only');
    expect(e.blocker).toContain('RECORDED_BY');
  });

  it('refuses with no goal leg', () => {
    writeNode('01-leg', CONTRACT);
    expect(errorOf(cmds().goalVerdict('met')).code).toBe('no-goal');
  });

  it('refuses a double met — the verdict is immutable per session', () => {
    met();
    expect(errorOf(cmds().goalVerdict('met')).code).toBe('already-met');
  });

  it('refuses while an undecided submission hides anywhere (a done task can still hold one)', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' })]);
    const e = errorOf(cmds().goalVerdict('met'));
    expect(e.code).toBe('undecided-submission');
    expect(e.blocker).toContain('02-work/01-a');
  });

  it('refuses a verdict before structural exhaustion', () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created')]);
    expect(errorOf(cmds().goalVerdict('met')).code).toBe('not-exhausted');
  });

  it('records goal-met on the goal root once the session is exhausted', () => {
    exhausted();
    const r = valueOf(cmds().goalVerdict('met', 'criteria confirmed'));
    expect(r.verdict).toBe('met');
    const goalMet = cmds().events('01-goal').find((e) => e.type === 'goal-met');
    expect(goalMet).toMatchObject({ decision: 'met', feedback: 'criteria confirmed' });
    expect(goalMet!.note).toContain('test');
  });

  it('no post-met spawns — a sealed session accepts no new work (a stale verdict is never carried)', () => {
    met();
    const e = errorOf(cmds().spawn('02-work/01-b', CONTRACT));
    expect(e.code).toBe('goal-met');
  });
});

describe('goal! archive — the guarded structural reset (goal-session-design §6)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const seedGoal = () => writeNode('01-goal', CONTRACT, [ev('created'), ev('completed')]);
  const exhausted = () => {
    seedGoal();
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('completed')]);
  };
  const met = () => {
    exhausted();
    valueOf(cmds().goalVerdict('met'));
  };

  it('refuses when the session is not met and the journey is not empty', () => {
    exhausted();
    expect(errorOf(cmds().goalArchive()).code).toBe('not-met');
  });

  it('--override forces the structural reset past an un-met session', () => {
    exhausted();
    const r = valueOf(cmds().goalArchive(true));
    expect(existsSync(r.dest)).toBe(true);
    expect(new Store(root).ids()).toEqual([]);
  });

  it('an EMPTY journey archives as the placeholder session', () => {
    const r = valueOf(cmds().goalArchive());
    expect(r.slug).toBe('session');
    expect(existsSync(r.dest)).toBe(true);
  });

  it('a met session archives: legs + the live ledger move; the live store reloads empty', () => {
    met();
    const r = valueOf(cmds().goalArchive());
    expect(r.slug).toBe('goal'); // no locked goal.md → the fallback slug from the goal leg id
    expect(existsSync(join(r.dest, 'legs', '01-goal', 'node.json'))).toBe(true);
    expect(existsSync(join(r.dest, 'legs', '02-work', '01-a', 'node.json'))).toBe(true);
    expect(existsSync(join(r.dest, '.ledger.json'))).toBe(true); // goalVerdict bootstrapped it
    expect(existsSync(join(root, '.ann', 'journey', '.ledger.json'))).toBe(false); // live ledger removed
    expect(existsSync(join(root, '.ann', 'journey', 'legs', '01-goal'))).toBe(false); // legs moved out
    expect(new Store(root).ids()).toEqual([]); // reload → empty journey
  });

  it('refuses a store-external drift even when met — ann never archives a state it does not recognize (override bypasses)', () => {
    met();
    appendFileSync(join(nodeDir('01-goal'), 'events.jsonl'), JSON.stringify({ at: '2026-08-27', type: 'goal-met', decision: 'met', note: 'forged' }) + '\n');
    const e = errorOf(cmds().goalArchive());
    expect(e.code).toBe('verify');
    expect(e.blocker).toContain('store-external');
    expect(valueOf(cmds().goalArchive(true)).dest.length).toBeGreaterThan(0);
  });
});

describe('goal! seed — the L1 materialize (guard → seedGoal → docs/goal.md named by the manifest)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const GOAL_DOC = `# Goal

Goal: Build a working goal! seed command

Success criteria:
- The validated goal is realized: Build a working goal! seed command
- docs/goal.md is the authored goal doc, named by the committed manifest
`;

  it('GUARDS: an EMPTY journey only — a non-empty journey is refused with the archive pointer', () => {
    writeNode('01-leg', {});
    const e = errorOf(cmds().goalSeed(GOAL_DOC));
    expect(e.code).toBe('not-empty');
    expect(e.blocker).toContain('goal! archive for a new session');
    expect(existsSync(join(root, 'docs', 'goal.md'))).toBe(false); // nothing written
  });

  it('GO: seeds the goal leg AND writes docs/goal.md — the manifest names it, no goal-root lock (D7)', () => {
    const c = cmds();
    const r = valueOf(c.goalSeed(GOAL_DOC));
    expect(r.id).toBe('01-goal');
    expect(r.contract).toEqual({
      intent: 'Build a working goal! seed command',
      acceptanceCriteria: [
        'The validated goal is realized: Build a working goal! seed command',
        'docs/goal.md is the authored goal doc, named by the committed manifest',
      ],
    });
    // the authored doc lands in docs/ (git content) — node.json holds only the parsed contract
    expect(readFileSync(join(root, 'docs', 'goal.md'), 'utf8')).toContain('Goal: Build a working goal! seed command');
    expect(JSON.parse(readFileSync(join(nodeDir('01-goal'), 'node.json'), 'utf8')).contract.intent).toBe('Build a working goal! seed command');
    // the doc resolves through the committed manifest — no goal-root artifact-lock, no orphan doc
    expect(new Store(root).resolveDoc('goal')).toMatchObject({ name: 'goal', path: 'docs/goal.md' });
    expect(c.events('01-goal').some((e) => e.type === 'artifact-locked')).toBe(false);
    expect(new Store(root).verify()).toEqual([]); // D2/D4-clean — docs/ is not an artifact orphan
    // the goal view reads the seeded session: present · generated contract · OPEN (no work spawned → not exhausted)
    const g = valueOf(c.goal());
    expect(g.present).toBe(true);
    expect(g.goalId).toBe('01-goal');
    expect(g.goalDoc).toMatchObject({ name: 'goal', path: 'docs/goal.md' });
    expect(g.goalDoc!.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(g.contract).toEqual(r.contract);
    expect(g.verdict).toBe('open'); // exhaustion needs WORK — a bare seed is the open state
    expect(g.reseed).toMatchObject({ reseedable: true, why: expect.stringContaining('fresh & unconsumed') }); // the sole goal is re-seedable
  });

  it('RE-SEED: a sole UNCONSUMED goal is REPLACED in place — docs/goal.md overwritten, node contract + manifest entry regenerated', () => {
    const c = cmds();
    valueOf(c.goalSeed(GOAL_DOC)); // first seed — the journey's only node
    const GOAL_DOC_2 = `# Goal

Goal: Build a RE-SEEDABLE goal! seed command

Success criteria:
- The validated goal is realized: Build a RE-SEEDABLE goal! seed command
- re-seeding overwrites docs/goal.md and regenerates the manifest entry
`;
    const r = valueOf(c.goalSeed(GOAL_DOC_2)); // goal! seed again on the same sole goal
    expect(r.id).toBe('01-goal'); // replaced IN PLACE — not a second leg
    expect(r.contract).toEqual({
      intent: 'Build a RE-SEEDABLE goal! seed command',
      acceptanceCriteria: [
        'The validated goal is realized: Build a RE-SEEDABLE goal! seed command',
        're-seeding overwrites docs/goal.md and regenerates the manifest entry',
      ],
    });
    // the new doc is on disk, the old doc is gone; the node contract regenerated 1:1
    const md = readFileSync(join(root, 'docs', 'goal.md'), 'utf8');
    expect(md).toContain('Goal: Build a RE-SEEDABLE goal! seed command');
    expect(md).not.toContain('Build a working goal! seed command');
    expect(JSON.parse(readFileSync(join(nodeDir('01-goal'), 'node.json'), 'utf8')).contract.intent).toBe('Build a RE-SEEDABLE goal! seed command');
    // the reseed re-names the doc at the NEW sha — doc + manifest + the goal view agree
    expect(r.doc).toMatchObject({ name: 'goal', path: 'docs/goal.md' });
    expect(r.doc.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(valueOf(c.goal()).goalDoc?.sha).toBe(r.doc.sha); // the view resolves the doc the reseed just wrote
    expect(new Store(root).verify()).toEqual([]); // D2/D4-clean — no orphan doc, no lock
    expect(new Store(root).ids()).toEqual(['01-goal']); // still exactly one leg — nothing leaked
  });

  it('RE-SEED GUARD: once a work leg spawns AFTER the goal, re-seeding refuses with the consumer + the archive path', () => {
    const c = cmds();
    valueOf(c.goalSeed(GOAL_DOC));
    mkNodeDir('02-work'); // the store writes a spawn into a folder that already exists
    valueOf(c.spawn('02-work', CONTRACT)); // the first work leg after the goal — goal.md is now consumed
    const e = errorOf(c.goalSeed(GOAL_DOC));
    expect(e.code).toBe('not-empty');
    expect(e.blocker).toContain('consumed by 02-work');
    expect(e.blocker).toContain('goal! archive'); // the change path is archive → a new goal, never a silent reseed
    // the goal view surfaces the same state + why
    const g = valueOf(c.goal());
    expect(g.reseed).toMatchObject({ reseedable: false, why: expect.stringContaining('consumed by 02-work') });
    // the original doc was NOT touched by the refused reseed
    expect(readFileSync(join(root, 'docs', 'goal.md'), 'utf8')).toContain('Goal: Build a working goal! seed command');
  });

  it('RE-SEED GUARD: a met goal never re-seeds — the sealed session is terminal', () => {
    // the met state: an exhausted session sealed by the human verdict (goal-session-design §4)
    writeNode('01-goal', CONTRACT, [ev('created'), ev('completed')]);
    writeNode('02-work', CONTRACT);
    writeNode('02-work/01-a', CONTRACT, [ev('created'), ev('completed')]);
    valueOf(cmds().goalVerdict('met', 'sealed'));
    const e = errorOf(cmds().goalSeed(GOAL_DOC));
    expect(e.code).toBe('not-empty');
    expect(e.blocker).toContain('sealed');
    const g = valueOf(cmds().goal());
    expect(g.reseed).toMatchObject({ reseedable: false, why: expect.stringContaining('sealed (met)') });
  });

  it('a malformed doc is refused with NO partial writes (seedGoal parses before it writes)', () => {
    const e = errorOf(cmds().goalSeed('# Goal\n\nGoal: no success criteria here\n'));
    expect(e.code).toBe('store-refused');
    expect(e.blocker).toContain("seedGoal rejected");
    expect(new Store(root).ids()).toEqual([]); // nothing half-seeded
  });
});
