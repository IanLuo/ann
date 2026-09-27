import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, JourneyEvent } from '../../store/store.js';
import { Commands, CommandResult, REJECT_BOUND } from '../index.js';
import type { CaptureEnv } from '../capture.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';
import { runValidators } from '../../flow/validators/index.js';

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

const cmds = (capture: CaptureEnv = stubCapture()) => new Commands(new Store(root), 'test', capture);

/** A sha that RESOLVES in the ann repo — required for evidence.commits[] that check()
 *  traces (`git cat-file -t`, run against process.cwd()). */
const realSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim().slice(0, 7);

/** A STUBBED capture seam (leg 12/03): the engine's exec surface is the ONE thing the
 *  capture injects, so a pass and a fail are exercised without running a suite inside a
 *  test. Everything else — the allowlist, the guards, the sha, the write — stays the
 *  engine's, which is why `head`/`dirty` stub the same seam rather than bypass it. */
const stubCapture = (o: { exitCode?: number; exits?: Record<string, number>; output?: string; dirty?: string[]; head?: string | undefined } = {}): CaptureEnv => ({
  // `head: undefined` means NO GIT — spelled by PRESENCE, so the stub can express it
  head: () => ('head' in o ? o.head : realSha()),
  dirty: () => o.dirty ?? [],
  run: (name) => ({ exitCode: o.exits?.[name] ?? o.exitCode ?? 0, stdout: o.output ?? 'Tests  3 passed (3)\n', stderr: '' }),
});

describe('spawn! — DECLARED dependencies are validated where a contract enters (leg 12/17)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const dep = (deps: string[]) => ({ intent: 'x', acceptanceCriteria: ['x'], dependsOn: deps });

  it('refuses SELF · UNKNOWN · NON-TASK · CYCLE · bad shape — each by name, writing nothing', () => {
    writeNode('01-leg', CONTRACT, []);
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    const c = cmds();
    const code = (id: string, deps: unknown) => {
      const r = c.spawn(id, dep(deps as string[]));
      return r.ok ? 'OK' : r.error.code;
    };
    // the happy path FIRST (a real dependency spawns)
    expect(code('01-leg/02-b', ['01-leg/01-a'])).toBe('OK');
    expect(c.store.status('01-leg/02-b')).toBe('blocked');
    // …then each refusal, on a FRESH id (an existing id refuses as 'exists' before these)
    expect(code('01-leg/06-f', ['01-leg/06-f'])).toBe('dependsOn-self');
    expect(code('01-leg/07-g', ['01-leg/09-gone'])).toBe('dependsOn-unknown');
    expect(code('01-leg/08-h', ['01-leg'])).toBe('dependsOn-target');
    expect(code('01-leg/09-i', [''])).toBe('dependsOn-shape');
    // A CHAIN is legal — and a CYCLE CANNOT BE CREATED THROUGH spawn at all: every target
    // must already exist and a NEW node has no dependents, so nothing existing can point
    // back at it. The spawn-time cycle guard is defensive insurance against a future writer
    // path; the LIVE net is check() (Store.depCycleProblems), tested in the store suite
    // against a hand-written cycle.
    writeNode('01-leg/03-c', dep(['01-leg/02-b']), [ev('created')]);
    const c2 = cmds(); // a FRESH store: the node written above is not in the earlier snapshot
    expect(c2.spawn('01-leg/04-d', dep(['01-leg/03-c'])).ok).toBe(true); // a chain, not a cycle
    expect(c2.store.check().join('\n')).not.toContain('CYCLE');
    // and nothing was written by any refusal
    expect(c.store.ids()).not.toContain('01-leg/04-d');
    expect(c.store.ids()).not.toContain('01-leg/06-f');
  });

  it('a spawned dependency BLOCKS its dependent in the derived views', () => {
    writeNode('01-leg', CONTRACT, []);
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    expect(cmds().spawn('01-leg/02-b', dep(['01-leg/01-a'])).ok).toBe(true);
    const c = cmds();
    expect(c.store.status('01-leg/02-b')).toBe('blocked');
    expect(c.frontmostReady()?.task).toBe('01-leg/01-a');
  });
});

describe('brief — the gate decision material in ONE read (leg 12/15)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const LONG = 'x'.repeat(1200);
  const writeOpenQ = (id: string, qs: unknown[], events: Array<Record<string, unknown>>) => {
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract: { intent: LONG, acceptanceCriteria: ['AC ' + LONG] }, openQuestions: qs, createdAt: '2026-08-27' }));
    writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('assembles the decision material and CAPS the walls (intent · AC · the latest note), each cut with its length NAMED', () => {
    writeOpenQ(
      '01-leg/01-a',
      [{ id: 'Q1', question: 'which way?', blocking: true, defaultIfUnanswered: 'this way' }],
      [
        ev('created'),
        ev('submitted', { gate: 'grill' }),
        ev('confirmed', { gate: 'grill', feedback: 'the approach is right, start here', note: 'accepted (test)' }),
        ev('extended', { note: LONG }),
      ],
    );
    const b = cmds().brief('01-leg/01-a');
    expect(b.status).toBe('queued'); // the grill was ACCEPTED in this fixture — the entry gate is passed
    expect(b.gates.grill).toBe('accepted');
    expect(b.next.verdict).toBe('entry-accepted');
    // the caps: cut, and the cut length written down (never a silent truncation)
    expect(b.intent.length).toBeLessThan(700);
    expect(b.intent).toContain('+');
    expect(b.acceptanceCriteria[0]).toContain('ann detail 01-leg/01-a');
    expect(b.latestNote?.truncated).toBe(true);
    expect(b.latestNote?.chars).toBe(1200);
    expect(b.latestNote?.index).toBe(4); // the event's number, for the drill
    // the decision material a human needs, in order
    expect(b.openQuestions).toEqual([{ id: 'Q1', question: 'which way?', blocking: true, defaultIfUnanswered: 'this way' }]);
    expect(b.decisions).toEqual([{
      kind: 'gate', gate: 'grill', subject: 'grill', decision: 'accepted', type: 'confirmed',
      event: 3, at: '2026-08-27', what: 'accepted at the grill gate',
      why: 'the approach is right, start here', by: 'test',
    }]);
    // an uncapped read is available, and 0 means UNCAPPED
    expect(cmds().brief('01-leg/01-a', { noteChars: 0 }).latestNote?.text.length).toBe(1200);
  });

  it('names the ABSENCE of a why (never infers one) and reports why the close would refuse', () => {
    writeNode('01-leg/02-b', { intent: 'x', acceptanceCriteria: ['AC1'] }, [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }), // a BARE accept — the measured 19
      ev('submitted', { gate: 'confirm' }),
    ]);
    const b = cmds().brief('01-leg/02-b');
    expect(b.decisions[0].why).toBeUndefined();
    expect(b.conclusion.unclaimed.length).toBe(1);
    expect(b.closeBlocker).toBeDefined();
    expect(b.closeBlocker?.code).toBeTruthy();
  });
});

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
    // THE FLOOR COMES FIRST (12/22 AC-1): with no evidence the CONFIRM submission cannot
    // close, so it is refused outright — nothing written (not even a malformed sha reaches
    // the store's own guard), and no rejection burned on a submission the engine refused.
    expect(errorOf(c.submit('01-leg/01-a', 'confirm', { confirmedSha: 'not-a-sha' })).code).toBe('submission-not-ready');
    expect(c.events('01-leg/01-a').some((e) => e.type === 'submitted' && e.gate === 'confirm')).toBe(false);
    expect(c.events('01-leg/01-a').some((e) => e.type === 'rejected')).toBe(false);
    // …now a conclusion the predicate holds — then the sha's own shape is the store's to check
    valueOf(c.capture('01-leg/01-a', 'npm test'));
    valueOf(c.evidence('01-leg/01-a', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
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
    // an accept with no rationale records no feedback field — still legal at the ENTRY gate
    // (AC-1 bounds the why-requirement to `confirm`, a task's terminal decision)
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'the evidence closes it'));
    const confirm2 = c.events('01-leg/01-a').find((e) => e.type === 'confirmed' && e.gate === 'confirm');
    expect(confirm2!.feedback).toBe('the evidence closes it');
  });

  it('owns the 3-reject bound as a CONSTANT and surfaces only {escalated}', () => {
    for (let i = 0; i < 2; i++) expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).escalated).toBe(false);
    expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).escalated).toBe(true);
    expect(errorOf(cmds().gate('01-leg/01-a', 'grill', 'reject', 'no')).code).toBe('reject-bound');
    // the bound is PER GATE, and never blocks an accept
    expect(valueOf(cmds().gate('01-leg/01-a', 'grill', 'accept')).escalated).toBe(true);
  });

  /* AC-5 (leg 12 task 22) — THE ESCALATION'S REAL GESTURE. At the bound the worker is OUT,
   * and a human who decides anyway records an OVERRIDE: the accept lands carrying the
   * reviewer's objection, DERIVED from the review record rather than typed by the caller.
   * An override that states its own objection could state one the log does not hold — which
   * is the silent decision the field exists to prevent. */
  function escalated(id: string, objection: 'open' | 'resolved' | 'none' = 'open'): Commands {
    writeNode(id, CONTRACT, [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }),
      ...Array.from({ length: REJECT_BOUND }, () => ev('rejected', { gate: 'confirm', feedback: 'the gap is still open' })),
    ]);
    const c = cmds(); // the store SCANS at construction — the fixture is on disk first
    if (objection !== 'none') {
      valueOf(
        c.landFindings(id, [
          { id: 'F1', severity: 'gap', where: 'src/x.ts:1', text: 'the criterion is unmet', status: objection, provenance: 'gate review worker (model)' },
        ]),
      );
    }
    return c;
  }

  it('AC-5: --force lands the accept WITH the record’s own objection, and stamps the decider', () => {
    const c = escalated('01-leg/01-a');
    const objection = c.reviewObjection('01-leg/01-a');
    expect(objection?.text).toContain('F1 [gap]');
    expect(objection?.text).toContain('the criterion is unmet');
    const v = valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'I reread it myself and the criterion does hold', { force: true }));
    expect(v.decision).toBe('accept');
    const confirmed = c.events('01-leg/01-a').find((e) => e.type === 'confirmed' && e.gate === 'confirm');
    // THE RECORD'S WORDS, not the caller's — the override is read back, never dictated
    expect(confirmed?.override).toEqual({ objection: objection!.text });
    // …and it rides the human's decision rather than replacing it: the why still stands
    expect(confirmed?.feedback).toBe('I reread it myself and the criterion does hold');
    expect(confirmed?.decider).toBe('human');
    expect(c.brief('01-leg/01-a').gates.confirm).toBe('accepted');
  });

  it('AC-5: --force refuses by NAME in the three states where it is not the gesture, with ZERO writes', () => {
    // one node per case: a fixture rewritten AFTER a write would trip the ledger's
    // store-external guard instead of the refusal under test
    const cases: Array<{ name: string; id: string; c: Commands; code: string; says: string }> = [
      { name: 'an entry-gate accept', id: '01-leg/01-a', c: cmds(), code: 'force-not-accept', says: 'rides a CONFIRM accept' },
      { name: 'below the bound (the worker is still the decider)', id: '01-leg/01-a', c: cmds(), code: 'force-not-escalated', says: 'still the decider' },
      { name: 'nothing open to override', id: '01-leg/02-b', c: escalated('01-leg/02-b', 'none'), code: 'force-no-objection', says: 'no OPEN gap/regression' },
      { name: 'the objection is already RESOLVED', id: '01-leg/03-c', c: escalated('01-leg/03-c', 'resolved'), code: 'force-no-objection', says: 'no OPEN gap/regression' },
    ];
    for (const k of cases) {
      const before = k.c.events(k.id).length;
      // the gesture it IS is spelled per case: only the first is not a confirm accept
      const decision = k.code === 'force-not-accept' ? (['grill', 'accept'] as const) : (['confirm', 'accept'] as const);
      const err = errorOf(cmds().gate(k.id, decision[0], decision[1], 'x', { force: true }));
      expect(err.code, k.name).toBe(k.code);
      expect(err.blocker, k.name).toContain(k.says);
      expect(k.c.events(k.id), k.name).toHaveLength(before); // a refusal is not a write
    }
    // …and the escalation reads the OPEN defects only: a resolved one is not an objection
    expect(escalated('01-leg/04-d', 'resolved').reviewObjection('01-leg/04-d')).toBeUndefined();
  });

  it('the store refuses a confirm gate with no confirmed grill (the sequence is L0-enforced)', () => {
    // the why is supplied so the refusal under test is the STORE's, not AC-1's
    expect(errorOf(cmds().gate('01-leg/01-a', 'confirm', 'accept', 'the sequence is the point')).code).toBe('store-refused');
  });

  /* AC-1 (leg 12 task 11) — THE WHY IS REQUIRED WHERE IT IS LOST. The channel existed on
   * the accept path and was never filled: 18 of the journey's 49 accepts recorded NOTHING.
   * A rejection's why is forced by the rework loop; this is the write-path rule that makes
   * the accept's not optional either. The rule is at the ONE chokepoint (gate!), so the
   * CLI, the served card and the frame all meet it. */
  it('AC-1: a confirm accept with NO why is REFUSED by name, with ZERO writes', () => {
    const c = cmds();
    valueOf(c.gate('01-leg/01-a', 'grill', 'accept'));
    const before = c.events('01-leg/01-a').length;
    const err = errorOf(c.gate('01-leg/01-a', 'confirm', 'accept'));
    expect(err.code).toBe('why-required');
    expect(err.blocker).toContain('confirm accept needs a why');
    // the refusal names the exact gesture that would work
    expect(err.blocker).toContain('ann gate! 01-leg/01-a confirm accept');
    // ZERO WRITES — not even the submitted(confirm) that a decided gate would leave behind
    expect(c.events('01-leg/01-a')).toHaveLength(before);
    expect(c.gateState('01-leg/01-a', 'confirm')).toBe('none');
    // whitespace is not a why either
    expect(errorOf(c.gate('01-leg/01-a', 'confirm', 'accept', '   ')).code).toBe('why-required');
    expect(c.events('01-leg/01-a')).toHaveLength(before);
    // ...and a non-empty why writes it onto the decision
    const ok = valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'the work is done and the evidence is in'));
    expect(ok.completed).toBeUndefined(); // no evidence yet — the honest intermediate state
    expect(c.events('01-leg/01-a').find((e) => e.type === 'confirmed' && e.gate === 'confirm')!.feedback)
      .toBe('the work is done and the evidence is in');
  });

  it('AC-1 is bounded to the TERMINAL gate: a bare GRILL accept and a bare reject are untouched', () => {
    // the entry gate still accepts on a bare "yes" — it opens work, it does not close it
    expect(cmds().gate('01-leg/01-a', 'grill', 'accept').ok).toBe(true);
    // a reject's why is forced by the rework loop and is a SEPARATE concern; the AC-1 rule
    // never fires on the reject direction (its code appears nowhere in that refusal)
    const rej = cmds().gate('01-leg/01-a', 'grill', 'reject');
    expect(rej.ok || rej.error.code !== 'why-required').toBe(true);
  });

  /* The ONE close rule (leg 08 task 02, CORRECTIVE): the accept auto-completes on evidence,
   * and NOTHING ELSE does. These pin the two non-closing directions — the entry gate and the
   * reject — against the same fixture shape the closing path uses. */
  it('a GRILL accept never completes — GATE① opens the work; only the CONFIRM accept closes', () => {
    writeNode('01-leg/02-grill', CONTRACT, [ev('created')]);
    const c = cmds();
    valueOf(c.evidence('01-leg/02-grill', [{ sha: realSha() }]));
    const out = valueOf(c.gate('01-leg/02-grill', 'grill', 'accept'));
    expect(out.completed).toBeUndefined();
    expect(out.pending).toBeUndefined(); // the pending hint is a CONFIRM-gate fact only
    expect(c.events('01-leg/02-grill').some((e) => e.type === 'completed')).toBe(false);
    expect(c.status('01-leg/02-grill')).toBe('queued'); // GATE① accepted, the work has not started
  });

  it('a REJECT never completes — even with the conclusion evidence already present', () => {
    writeNode('01-leg/03-reject', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const c = cmds();
    // a conclusion that HOLDS (12/22 AC-1) — otherwise the submission below never lands and
    // this would be testing the floor instead of the reject
    valueOf(c.capture('01-leg/03-reject', 'npm test'));
    valueOf(c.evidence('01-leg/03-reject', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    valueOf(c.submit('01-leg/03-reject', 'confirm'));
    const out = valueOf(c.gate('01-leg/03-reject', 'confirm', 'reject', 'not this time'));
    expect(out.completed).toBeUndefined();
    expect(out.pending).toBeUndefined(); // a rejection is a decision, not a missing gesture
    expect(c.events('01-leg/03-reject').some((e) => e.type === 'completed')).toBe(false);
    expect(c.status('01-leg/03-reject')).not.toBe('done');
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
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'the contract held'));
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

  it('evidence! carries the STRUCTURED conclusion too (v18: claims per AC + the checks run; leg 12/03: the ac→check MAPPING + the reported label)', () => {
    accepted();
    const c = cmds();
    const claims = [{ ac: 'AC-1', statement: 'the store holds it', evidence: ['abc1234', 'src/store'] }];
    const checks = [{ command: 'npm test', result: 'pass' as const, detail: '3/3', sha: 'abc1234' }];
    expect(valueOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { claims, checks }))).toEqual({ commits: 1, refs: 0, claims: 1, checks: 1 });
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.claims).toEqual(claims);
    // the WRITER labels a check the runner typed (AC-2): the log holds no unlabeled one
    expect(e.checks).toEqual([{ ...checks[0], source: 'reported' }]);
    // the SHAPE stays the store's: a malformed claim is refused through this front too
    const bad = errorOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { claims: [{ ac: 'AC-1' }] }));
    expect(bad.code).toBe('store-refused');
    expect(bad.blocker).toContain("needs a 'check'");
    // …and a check that CLAIMS to be captured is refused here BY NAME — a fact is
    // engine-produced (capture!), never typed into the conclusion record
    const forged = errorOf(c.evidence('01-leg/01-a', [{ sha: 'abc1234' }], { checks: [{ command: 'npm test', result: 'pass', source: 'captured', exitCode: 0, sha: 'abc1234', detail: 'sha1:0 · ok' }] }));
    expect(forged.code).toBe('store-refused');
    expect(forged.blocker).toContain('ENGINE-PRODUCED');
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

  /** A COMPLIANT conclusion (leg 12/03): the CAPTURED pass — the engine ran an
   *  allowlisted command through the stubbed seam and recorded the real exit code — plus a
   *  claim per AC MAPPED to it by check. The sha the capture binds is the stubbed HEAD. */
  const conclude = (c: Commands, id: string, sha: string) => {
    valueOf(c.capture(id, 'npm test'));
    return c.evidence(id, [{ sha }], { claims: [{ ac: 'AC-1', check: 'npm test', evidence: [sha] }] });
  };

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
    valueOf(c.capture(ID, 'npm test')); // the fact alone claims nothing about any AC
    c.evidence(ID, [{ sha: realSha() }]);
    const e = errorOf(c.complete(ID));
    expect(e.code).toBe('no-structured-conclusion');
    // the refusal names the gap exactly: NEITHER claimed NOR transferred (12/12 AC-2)
    expect(e.blocker).toContain('neither claimed NOR transferred');
    expect(e.blocker).toContain("'AC-1'");
    expect(e.blocker).toContain('--claims');
    expect(e.blocker).toContain('--transfer'); // the other way out of the gap, named
    expect(c.status(ID)).toBe('accepted'); // nothing was written
    // the derivation the CARD renders is the one that refused
    expect(c.conclusion(ID).unclaimed).toEqual([{ ac: 'AC-1', acText: 'it is done' }]);
  });

  it('complete! refuses when no CAPTURED pass is bound to a cited commit — no checks · a REPORTED pass · a foreign sha · a failing run', () => {
    // one node per case: the fixture hand-writes node.json/events.jsonl, and the store's
    // ledger guard (correctly) refuses a WRITE over a node that was rewritten behind it.
    const at = (id: string) => writeNode(id, CONTRACT, [ev('created'), ...GATE]);
    const close = (id: string, capture: CaptureEnv, opts: Parameters<Commands['evidence']>[2] = {}) => {
      at(id);
      const c = cmds(capture);
      valueOf(c.evidence(id, [{ sha: realSha() }], opts));
      return { c, err: errorOf(c.complete(id)) };
    };
    // (a) claims, but no checks at all
    const a = close('01-leg/02-nochecks', stubCapture(), { claims: [{ ac: 'AC-1', statement: 'met', evidence: [realSha()] }] });
    expect(a.err.code).toBe('no-captured-pass');
    expect(a.err.blocker).toContain('no checks at all');
    // (b) a REPORTED pass is a CLAIM: it is labelled in the log and refuses the close BY
    // NAME — the tightening (leg 12/03 AC-4), no reason-string escape hatch
    const b = close('01-leg/03-reported', stubCapture(), {
      claims: [{ ac: 'AC-1', statement: 'met', evidence: [realSha()] }],
      checks: [{ command: 'npm test', result: 'pass', sha: realSha() }],
    });
    expect(b.err.code).toBe('no-captured-pass');
    expect(b.err.blocker).toContain('a REPORTED check (--checks) is what the runner says');
    expect(b.err.blocker).toContain("ann capture! 01-leg/03-reported");
    expect(b.c.status('01-leg/03-reported')).toBe('accepted'); // nothing written
    expect(b.c.store.checksOf('01-leg/03-reported')[0].source).toBe('reported');
    // (c) a FAILING captured run records the real result and blocks the close (AC-5)
    at('01-leg/05-failing');
    const fc = cmds(stubCapture({ exitCode: 1, output: '1 failed' }));
    valueOf(fc.capture('01-leg/05-failing', 'npm test'));
    valueOf(fc.evidence('01-leg/05-failing', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    const f = { c: fc, err: errorOf(fc.complete('01-leg/05-failing')) };
    expect(f.err.code).toBe('no-captured-pass');
    expect(f.err.blocker).toContain('the latest captured run FAILED: npm test');
    expect(f.c.store.checksOf('01-leg/05-failing')[0]).toMatchObject({ source: 'captured', result: 'fail', exitCode: 1 });
    expect(f.c.status('01-leg/05-failing')).toBe('accepted');
  });

  it('a claim mapped to a FAILING check refuses by name even when another command has a captured pass', () => {
    accepted();
    // the AC's own act FAILED — on bytes the conclusion does NOT cite (the cited-commit
    // case is refused earlier and by its own name: `cited-check-failed`)
    let head = realSha();
    const c = cmds({ head: () => head, dirty: () => [], run: (n) => ({ exitCode: n === 'ann check' ? 1 : 0, stdout: 'Tests  1 passed (1)\n', stderr: '' }) });
    valueOf(c.capture(ID, 'npm test')); // a captured PASS (the global predicate is satisfied)
    head = 'feedface';
    valueOf(c.capture(ID, 'ann check')); // …and a FAILED run for the AC's own act
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'ann check' }] }));
    const e = errorOf(c.complete(ID));
    expect(e.code).toBe('claim-failed');
    expect(e.blocker).toContain("'AC-1'");
    expect(e.blocker).toContain('LATEST run FAILED');
    expect(c.status(ID)).toBe('accepted');
  });

  it('a CAPTURED FAILURE on a CITED commit refuses the close — a pass elsewhere on the same bytes cannot certify them (leg 12/02 rework)', () => {
    accepted();
    const c = cmds(stubCapture({ exits: { 'ann check': 1 } }));
    valueOf(c.capture(ID, 'npm test')); // a captured PASS at the cited sha …
    valueOf(c.capture(ID, 'ann check')); // … and a FAILED run at the SAME, cited sha
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] })); // the claim maps the PASSING act
    // the pass-side predicate ALONE would have closed this — the hole the fail side shuts
    expect(c.store.capturedPassBound(ID)).toBe(true);
    expect(c.store.capturedFailCited(ID)?.command).toBe('ann check');
    const e = errorOf(c.complete(ID));
    expect(e.code).toBe('cited-check-failed');
    expect(e.blocker).toContain('ann check');
    expect(e.blocker).toContain(realSha());
    expect(e.blocker).toContain('NEW sha');
    expect(c.status(ID)).toBe('accepted'); // nothing written
  });

  it('a captured failure on a commit the conclusion does NOT cite blocks nothing — it is history, said in the note', () => {
    accepted();
    let head = 'deadbeef';
    const c = cmds({ head: () => head, dirty: () => [], run: (n) => ({ exitCode: n === 'ann check' ? 1 : 0, stdout: 'Tests  1 passed (1)\n', stderr: '' }) });
    valueOf(c.capture(ID, 'ann check')); // FAILED, against the PRE-fix bytes
    head = realSha();
    valueOf(c.capture(ID, 'npm test')); // PASS, against the commit the conclusion cites
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    expect(valueOf(c.complete(ID)).at).toMatch(/^\d{4}-\d{2}-\d{2}$/); // closes
    expect(c.status(ID)).toBe('done');
  });

  it('a commit is matched by NAME: git\'s abbreviation in the citation still finds the captured run (and its failure)', () => {
    accepted();
    // the real shape: `capture!` records the FULL sha, the conclusion cites git's 7 — the
    // raw-string comparison missed its own run (false `no-captured-pass`) and let a FAILED
    // run on cited bytes slip through
    const full = '0123456789abcdef0123456789abcdef01234567';
    const c = cmds({ head: () => full, dirty: () => [], run: (n) => ({ exitCode: n === 'ann check' ? 1 : 0, stdout: 'Tests  1 passed (1)\n', stderr: '' }) });
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.capture(ID, 'ann check'));
    valueOf(c.evidence(ID, [{ sha: full.slice(0, 7) }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    expect(c.store.capturedPassBound(ID)).toBe(true); // the shorthand finds the pass
    expect(c.store.capturedFailCited(ID)?.command).toBe('ann check'); // …and the failure
    expect(errorOf(c.complete(ID)).code).toBe('cited-check-failed');
  });

  it('a RE-RECORDED conclusion supersedes the citation set: the new bytes close it, the old failure stays history', () => {
    accepted();
    let head = 'feedface';
    const c = cmds({ head: () => head, dirty: () => [], run: (n) => ({ exitCode: n === 'ann check' ? 1 : 0, stdout: 'Tests  1 passed (1)\n', stderr: '' }) });
    valueOf(c.capture(ID, 'npm test')); // a pass at the OLD bytes …
    valueOf(c.capture(ID, 'ann check')); // … and a failure at the SAME old bytes
    valueOf(c.evidence(ID, [{ sha: 'feedface' }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    expect(errorOf(c.complete(ID)).code).toBe('cited-check-failed'); // the old conclusion could not close
    // the rework: fix, commit, capture at the NEW sha, re-record citing it
    head = 'cafebabe';
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.evidence(ID, [{ sha: 'cafebabe' }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    expect(c.store.capturedFailCited(ID)).toBeUndefined(); // the old citation set is superseded
    expect(valueOf(c.complete(ID)).at).toMatch(/^\d{4}-\d{2}-\d{2}$/); // …and the new bytes close it
  });

  it('the gate card reads the WHOLE predicate: bound is 0 when the cited bytes carry a captured failure', () => {
    // an UNDECIDED confirm submission — the card's own row for a task still awaiting a decision
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' })]);
    const c = cmds(stubCapture({ exits: { 'ann check': 1 } }));
    valueOf(c.capture('01-leg/01-a', 'npm test'));
    valueOf(c.capture('01-leg/01-a', 'ann check'));
    valueOf(c.evidence('01-leg/01-a', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    const row = c.pendingGates().find((p) => p.task === '01-leg/01-a')!;
    expect(row.delivered.bound).toBe(0); // the card must not promise a close the predicate refuses
    expect(c.store.capturedPassBound('01-leg/01-a')).toBe(true); // …the pass side alone would have
  });

  it('a claim mapping an act the log does NOT hold refuses by name (a mapping is not prose)', () => {
    accepted();
    const c = cmds();
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'ann verify' }] }));
    const e = errorOf(c.complete(ID));
    expect(e.code).toBe('claim-unsubstantiated');
    expect(e.blocker).toContain("'AC-1' → 'ann verify'");
    expect(e.blocker).toContain('ann capture!');
    expect(c.status(ID)).toBe('accepted');
  });

  it('a captured run against a FOREIGN sha (a different commit than the one cited) closes nothing', () => {
    accepted();
    const c = cmds(stubCapture());
    valueOf(c.capture('01-leg/01-a', 'npm test')); // captured against HEAD
    valueOf(c.evidence('01-leg/01-a', [{ sha: 'deadbeef' }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    const e = errorOf(c.complete('01-leg/01-a'));
    expect(e.code).toBe('no-captured-pass');
    expect(e.blocker).toContain('none a CAPTURED pass bound to a cited commit');
    expect(c.status('01-leg/01-a')).toBe('accepted');
  });

  it('a claim recorded in a LATER evidence event counts (the rework model) — matched by the AC text or its AC-N', () => {
    accepted();
    const c = cmds();
    const sha = realSha();
    valueOf(c.capture(ID, 'npm test')); // the FACT first (nothing to claim against yet)
    c.store.appendEvent(c.store.resolveNode(ID), ev('evidence', { commits: [{ sha }] }) as JourneyEvent);
    expect(errorOf(c.complete(ID)).code).toBe('no-structured-conclusion');
    // the claim names the criterion by its TEXT and maps it to the recorded act
    c.store.appendEvent(c.store.resolveNode(ID), ev('evidence', { commits: [{ sha }], claims: [{ ac: 'it is done', check: 'npm test' }] }) as JourneyEvent);
    expect(valueOf(c.complete(ID)).at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.store.checksOf(ID).map((k) => k.source)).toEqual(['captured']);
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

  it('CORRECTIVE (leg 08 task 02 REVERSED): gate! confirm accept AUTO-COMPLETES when the conclusion evidence is present — ONE gesture', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const c = cmds();
    conclude(c, '01-leg/01-a', realSha());
    valueOf(c.submit('01-leg/01-a', 'confirm'));
    const out = valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'looks right'));
    expect(out.completed).toBe(true);
    expect(out.pending).toBeUndefined();
    expect(c.status('01-leg/01-a')).toBe('done');
    // BOTH events, in order — the close RIDES the accept, it is not a second gesture
    expect(c.events('01-leg/01-a').map((e) => e.type).slice(-2)).toEqual(['confirmed', 'completed']);
    expect(String(c.events('01-leg/01-a').at(-1)!.note)).toContain('completed with the confirm accept (evidence present)');
    expect(c.check()).toEqual([]);
    // the done terminal is recorded ONCE: a re-accept never writes a second `completed`,
    // and the explicit gesture is the idempotent refusal (complete! stays exactly as today)
    valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'the same conclusion, restated'));
    expect(c.events('01-leg/01-a').filter((e) => e.type === 'completed')).toHaveLength(1);
    expect(errorOf(c.complete('01-leg/01-a')).code).toBe('already-completed');
    expect(c.status('01-leg/01-a')).toBe('done');
  });

  it('the honest EXCEPTION stands: a confirm accept WITHOUT a closeable conclusion leaves `accepted`, and names the gesture owed', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const c = cmds();
    // THE FLOOR AT THE SUBMISSION (12/22 AC-1): the confirm submission is REFUSED — nothing
    // written, no rejection burned. `submit!` will not stage a question whose answer could
    // not close the record.
    const refused = errorOf(c.submit('01-leg/01-a', 'confirm'));
    expect(refused.code).toBe('submission-not-ready');
    expect(refused.blocker).toContain('no-evidence');
    expect(c.events('01-leg/01-a').some((e) => e.type === 'submitted' && e.gate === 'confirm')).toBe(false);
    expect(c.events('01-leg/01-a').some((e) => e.type === 'rejected')).toBe(false);
    // …but `gate!`'s own implicit submission does NOT pre-read the floor (the ONE path the
    // floor does not own), so the accept can still land on a conclusion that cannot close.
    // THAT is the honest intermediate state, and it is still reachable and still named.
    const out = valueOf(c.gate('01-leg/01-a', 'confirm', 'accept', 'the work is done, the evidence still owed'));
    expect(out.completed).toBeUndefined();
    expect(String(out.pending)).toContain('complete! 01-leg/01-a');
    expect(String(out.pending)).toContain('no-evidence');
    expect(c.status('01-leg/01-a')).toBe('accepted');
    expect(c.events('01-leg/01-a').some((e) => e.type === 'completed')).toBe(false);
    // the explicit path still refuses it — the EVIDENCE is the precondition, not the gesture
    expect(errorOf(c.complete('01-leg/01-a')).code).toBe('no-evidence');
    expect(c.status('01-leg/01-a')).toBe('accepted');
  });

  it('complete! is recorded once, and never on a leg root or an unknown node', () => {
    accepted();
    const c = cmds();
    conclude(c, '01-leg/01-a', realSha());
    valueOf(c.complete('01-leg/01-a'));
    expect(errorOf(c.complete('01-leg/01-a')).code).toBe('already-completed');
    expect(errorOf(c.complete('01-leg')).code).toBe('leg-gate-write');
    expect(errorOf(c.complete('01-leg/09-x')).code).toBe('no-node');
  });

  it('adds NO new write path — every event lands through the single writer', () => {
    accepted();
    const c = cmds();
    conclude(c, '01-leg/01-a', realSha());
    valueOf(c.complete('01-leg/01-a'));
    // the capture is an evidence event on the SAME log — one writer, one path
    expect(c.events('01-leg/01-a').map((e) => e.type)).toEqual(['created', 'submitted', 'confirmed', 'submitted', 'confirmed', 'evidence', 'evidence', 'completed']);
    expect(c.verify()).toEqual([]);
  });
});

describe('landFindings — THE FINDINGS RECORD (leg 12/09 AC-2 · AC-4)', () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', CONTRACT); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const GATE = [ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })];
  /** A task standing at its CONFIRM gate, submitted and undecided — where a review runs. */
  const atConfirm = () => writeNode('01-leg/01-a', CONTRACT, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' })]);

  const F = (over: Record<string, unknown> = {}) => ({
    id: 'F1',
    severity: 'gap' as const,
    where: 'src/surface/handlers.ts:433',
    text: 'AC-4 is unmet: the findings are not exposed by the gate read',
    status: 'open' as const,
    provenance: 'review session (model)',
    ...over,
  });

  it('lands on the ADDRESSED node — confinement is structural, not a check', () => {
    atConfirm();
    writeNode('01-leg/02-b', CONTRACT, [ev('created')]);
    const c = cmds();
    expect(valueOf(c.landFindings('01-leg/01-a', [F()], { anchorSha: 'a1a5056' }))).toEqual({ findings: 1 });
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.type).toBe('evidence');
    expect(e.findings).toEqual([F()]);
    expect(e.anchorSha).toBe('a1a5056');
    expect(String(e.note)).toContain('test');
    // the sibling holds nothing, and the store never sees a write it did not mint
    expect(c.events('01-leg/02-b').filter((x) => x.type === 'evidence')).toEqual([]);
    expect(c.verify()).toEqual([]);
  });

  it('is DELIBERATELY NOT A CONCLUSION — no commits, no claims, no checks, so a review can never close a task', () => {
    atConfirm();
    const c = cmds();
    valueOf(c.landFindings('01-leg/01-a', [F()]));
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.commits).toBeUndefined();
    expect(e.claims).toBeUndefined();
    expect(e.checks).toBeUndefined();
    // AC-4: the session writes NO gate event, and the task is exactly where it was
    expect(c.status('01-leg/01-a')).toBe('blocked');
    expect(c.events('01-leg/01-a').filter((x) => ['confirmed', 'rejected', 'completed'].includes(String(x.type)))).toHaveLength(1);
    // …and the DERIVED gate in hand is unchanged: a review leaves the human's decision pending
    expect(c.detail('01-leg/01-a').next).toEqual({ gate: 'confirm', verdict: 'waiting-on-decision' });
  });

  it('refuses a leg root, an unknown node, an empty list, and a malformed finding — BY NAME, writing nothing', () => {
    atConfirm();
    const c = cmds();
    expect(errorOf(c.landFindings('01-leg', [F()])).code).toBe('leg-gate-write');
    expect(errorOf(c.landFindings('01-leg/09-x', [F()])).code).toBe('no-node');
    expect(errorOf(c.landFindings('01-leg/01-a', [])).code).toBe('no-findings');
    // the deep shape is the SINGLE WRITER's: this front adds only the gesture's precondition
    const bad = errorOf(c.landFindings('01-leg/01-a', [F({ where: '  ' })]));
    expect(bad.code).toBe('store-refused');
    expect(bad.blocker).toContain("needs 'where'");
    const noAuthor = errorOf(c.landFindings('01-leg/01-a', [F({ provenance: '' })]));
    expect(noAuthor.blocker).toContain("needs 'provenance'");
    // nothing was written by any refusal
    expect(c.events('01-leg/01-a').filter((x) => x.type === 'evidence')).toEqual([]);
  });
});

describe("the review OUTCOME — what the worker did, on the record (leg 12/27)", () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', CONTRACT); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const GATE = [ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })];
  const atConfirm = (extra: Array<Record<string, unknown>> = []) =>
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' }), ...extra]);
  const F = (over: Record<string, unknown> = {}) => ({ id: 'F1', severity: 'quality' as const, where: 'src/a.ts:1', text: 'x', status: 'open' as const, provenance: 'gate review worker (model)', ...over });
  const HUMAN = { verdict: 'human' as const, reason: 'an open quality with no defect against the contract', count: 1, run: 'run-7' };
  const ABSENT = { verdict: 'absent' as const, why: 'unavailable' as const, reason: 'the review worker could not run — provider-unavailable', count: 0 };

  it('AC-1 — a landing may carry an outcome and NO findings, and only an outcome-less empty landing is refused', () => {
    atConfirm();
    const c = cmds();
    // the absence lands NOTHING to find — the case the writer used to refuse, and the whole
    // reason an absence left no trace on every path but one
    expect(valueOf(c.landFindings('01-leg/01-a', [], { outcome: ABSENT, note: 'no review' }))).toEqual({ findings: 0 });
    const absent = c.events('01-leg/01-a').at(-1)!;
    expect(absent.findings).toBeUndefined();
    expect(absent.outcome).toEqual(ABSENT);
    // …and an event that says NOTHING is still not a record of anything
    expect(errorOf(c.landFindings('01-leg/01-a', [])).code).toBe('no-findings');
    // the deep shape is the single writer's: a deciding verdict is refused BY NAME, nothing written
    const deciding = errorOf(c.landFindings('01-leg/01-a', [], { outcome: { ...HUMAN, verdict: 'accept' as never } }));
    expect(deciding.code).toBe('store-refused');
    expect(deciding.blocker).toContain("verdict must be 'human' or 'absent'");
    expect(c.events('01-leg/01-a').filter((x) => x.type === 'evidence')).toHaveLength(1);
  });

  it("AC-1 — the outcome rides the review's OWN event, and the LATEST landing's outcome is the fact", () => {
    atConfirm();
    const c = cmds();
    valueOf(c.landFindings('01-leg/01-a', [F()], { outcome: HUMAN, anchorSha: 'a1a5056' }));
    const e = c.events('01-leg/01-a').at(-1)!;
    expect(e.findings).toHaveLength(1);
    expect(e.outcome).toEqual(HUMAN); // ONE review, ONE record: findings and their verdict together
    expect(e.anchorSha).toBe('a1a5056'); // the bytes the review was run over
    expect(c.reviewFindings('01-leg/01-a').outcome).toEqual({ ...HUMAN, at: String(e.at) }); // the date is the EVENT's, never the outcome's to assert
    // a re-review REPLACES the outcome rather than stacking beside it — the same latest-wins
    // model a finding's status follows
    valueOf(c.landFindings('01-leg/01-a', [F({ status: 'resolved' })], { outcome: { ...HUMAN, reason: 'the bytes settled it', count: 0 } }));
    expect(c.reviewFindings('01-leg/01-a').outcome!.reason).toBe('the bytes settled it');
    expect(c.reviewFindings('01-leg/01-a').outcome!.count).toBe(0);
  });

  it('AC-1 — a HUMAN verdict leaves the gate, the rejections and the decisions BYTE-IDENTICAL', () => {
    atConfirm();
    const c = cmds();
    const before = c.events('01-leg/01-a');
    const gatesBefore = c.brief('01-leg/01-a').gates;
    const decisionsBefore = c.brief('01-leg/01-a').decisions;
    expect(valueOf(c.landFindings('01-leg/01-a', [F()], { outcome: HUMAN }))).toEqual({ findings: 1 });
    // the record gains an OUTCOME, never a decision: no rejection burned, no decision event
    expect(c.rejections('01-leg/01-a', 'confirm')).toBe(0);
    expect(c.brief('01-leg/01-a').gates).toEqual(gatesBefore);
    expect(c.brief('01-leg/01-a').decisions).toEqual(decisionsBefore);
    expect(c.events('01-leg/01-a').slice(0, before.length)).toEqual(before); // history untouched, one event appended
    expect(c.status('01-leg/01-a')).toBe('blocked');
    expect(c.detail('01-leg/01-a').next).toEqual({ gate: 'confirm', verdict: 'waiting-on-decision' });
  });

  it('AC-3/AC-4 — the standing: REVIEWED AND LEFT · AT THE BOUND · ABSENT, three distinct lines off the record', () => {
    atConfirm();
    const c = cmds();
    // nothing recorded and no bound: the worker has simply not been given this submission
    expect(c.brief('01-leg/01-a').review).toBeUndefined();

    // REVIEWED AND LEFT — read from the record, never re-derived from the severities
    valueOf(c.landFindings('01-leg/01-a', [F()], { outcome: HUMAN }));
    const left = c.brief('01-leg/01-a').review!;
    expect(left.kind).toBe('human');
    expect(left.line).toContain('REVIEWED AND LEFT');
    expect(left.line).toContain(HUMAN.reason);
    expect(left).toMatchObject({ findings: 1, run: 'run-7' });
    // dated by the landing, not by the caller — and the LABEL is what the next-line slot prints
    if (left.kind !== 'human') throw new Error('expected the human arm');
    expect(left.label).toBe('REVIEWED AND LEFT');
    expect(left.at).toBe(String(c.events('01-leg/01-a').at(-1)!.at));

    // ABSENT — the worker did not answer, and WHICH absence it was is on the line
    valueOf(c.landFindings('01-leg/01-a', [], { outcome: ABSENT }));
    const gone = c.brief('01-leg/01-a').review!;
    expect(gone.kind).toBe('absent');
    expect(gone).toMatchObject({ why: 'unavailable' });
    expect(gone.line).toContain('ABSENT');
    expect(gone.line).toContain('unavailable');

    // AT THE BOUND — DERIVED from the rejection events, needing no record and no model call,
    // and it takes PRECEDENCE: when the worker is out, an earlier pass's outcome is not the
    // live fact (which is exactly why 12/23, never reviewed, can still say so)
    // the state 12/23 is in: the bound is spent and the gate is OPEN AGAIN (a re-submission is
    // what puts it back in front of the worker — and is the whole reason a bound gate reads
    // `submitted` rather than `rejected`, and so can be spoken about at all)
    const spent = [...c.events('01-leg/01-a'), ...Array.from({ length: REJECT_BOUND }, (_, i) => ev('rejected', { gate: 'confirm', feedback: `no ${i}` })), ev('submitted', { gate: 'confirm' })];
    writeNode('01-leg/01-a', CONTRACT, spent);
    const boundStore = new Store(root);
    const atBound = new Commands(boundStore, 'test', stubCapture());
    const bound = atBound.brief('01-leg/01-a').review!;
    expect(bound.kind).toBe('bound');
    expect(bound.line).toContain('AT THE BOUND');
    expect(bound.line).toContain(`of ${REJECT_BOUND} rejections`);
    // three DISTINCT lines — the one sentence that used to mean four different things
    expect(new Set([left.line, gone.line, bound.line]).size).toBe(3);
    // …and a DECIDED gate has no standing to state: the decision is the record
    writeNode('01-leg/02-b', CONTRACT, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm', feedback: 'ok' })]);
    expect(new Commands(new Store(root), 'test', stubCapture()).brief('01-leg/02-b').review).toBeUndefined();
  });
});

describe('capture! — the CAPTURED check (leg 12 task 03: the record is a consequence, not a claim)', () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', CONTRACT); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const ID = '01-leg/01-a';
  const task = () => writeNode(ID, CONTRACT, [ev('created')]);

  it('records the REAL outcome as a FACT: the exit code decides the result, the sha comes from git, the detail is the output digest/summary', () => {
    task();
    const c = cmds(stubCapture({ exitCode: 0, output: '\nTests  3 passed (3)\n' }));
    const v = valueOf(c.capture(ID, 'npm test'));
    expect(v).toMatchObject({ command: 'npm test', result: 'pass', exitCode: 0, sha: realSha() });
    expect(v.detail).toMatch(/^sha1:[0-9a-f]{12} · Tests 3 passed \(3\)$/);
    // the FACT lands on the node's own log, as an evidence record, with provenance
    const e = c.events(ID).at(-1)!;
    expect(e.type).toBe('evidence');
    expect(e.commits).toBeUndefined(); // a check is not a conclusion — it cites nothing by itself
    expect(e.checks).toEqual([{ command: 'npm test', result: 'pass', exitCode: 0, detail: v.detail, sha: realSha(), source: 'captured' }]);
    expect(String(e.note)).toContain("captured 'npm test' → pass (exit 0)");
    expect(String(e.note)).toContain('test'); // RECORDED_BY
    expect(c.verify()).toEqual([]);
  });

  it('records a FAILING run as result=fail with the real exit code — never softened', () => {
    task();
    const c = cmds(stubCapture({ exitCode: 2, output: 'boom\n3 failed | 5 passed' }));
    const v = valueOf(c.capture(ID, 'ann verify'));
    expect(v).toMatchObject({ command: 'ann verify', result: 'fail', exitCode: 2 });
    expect(v.detail).toContain('3 failed | 5 passed');
    expect(c.store.checksOf(ID)[0]).toMatchObject({ source: 'captured', result: 'fail', exitCode: 2 });
    expect(c.store.capturedPassBound(ID)).toBe(false);
  });

  it('is NOT A SHELL: only the five allowlisted names run — anything else is refused by name, having executed nothing', () => {
    task();
    let ran = 0;
    const env = stubCapture();
    const c = cmds({ ...env, run: (n, d) => { ran += 1; return env.run(n, d); } });
    for (const bad of ['rm -rf /', 'npm test -- --watch', 'sh', 'node -e "1"', 'npm  test', 'NPM TEST']) {
      const e = errorOf(c.capture(ID, bad));
      expect(e.code).toBe('unknown-command');
      expect(e.blocker).toContain('not on the ALLOWLIST');
      expect(e.blocker).toContain('not a shell');
    }
    expect(ran).toBe(0); // nothing reached the exec seam
    expect(c.events(ID).filter((e) => e.type === 'evidence')).toEqual([]);
    // task-addressed only (a leg carries no verification; an unknown node is refused)
    expect(errorOf(c.capture('01-leg', 'npm test')).code).toBe('leg-gate-write');
    expect(errorOf(c.capture('01-leg/09-x', 'npm test')).code).toBe('no-node');
  });

  it('refuses a DIRTY tree and a missing HEAD fail-closed — the sha must be the bytes the run really saw', () => {
    task();
    let ran = 0;
    const dirtyEnv = stubCapture({ dirty: ['src/store/store.ts', 'docs/x.md'] });
    const c = cmds({ ...dirtyEnv, run: (n, d) => { ran += 1; return dirtyEnv.run(n, d); } });
    const d = errorOf(c.capture(ID, 'npm test'));
    expect(d.code).toBe('dirty-tree');
    expect(d.blocker).toContain('src/store/store.ts');
    expect(d.blocker).toContain('commit first');
    expect(ran).toBe(0);
    const g = errorOf(cmds(stubCapture({ head: undefined })).capture(ID, 'npm test'));
    expect(g.code).toBe('no-git');
    expect(cmds().events(ID).filter((e) => e.type === 'evidence')).toEqual([]);
  });

  it('the log DISTINGUISHES a fact from a claim: an unlabeled --checks entry is labelled reported, a capture is marked captured', () => {
    task();
    const c = cmds();
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }], checks: [{ command: 'npm run build', result: 'pass', detail: 'typed by a runner' }] }));
    const checks = c.store.checksOf(ID);
    expect(checks.map((k) => [k.command, k.source, k.result])).toEqual([
      ['npm test', 'captured', 'pass'],
      ['npm run build', 'reported', 'pass'],
    ]);
    // only the captured one can satisfy the predicate
    expect(c.store.capturedPassBound(ID)).toBe(true);
    // …and a reported check alone never does (same command, typed instead of run)
    valueOf(c.evidence(ID, [{ sha: realSha() }], { checks: [{ command: 'npm run typecheck', result: 'pass' }] }));
    expect(c.store.checksOf(ID).at(-1)!.source).toBe('reported');
    expect(c.store.checksOf(ID).filter((k) => k.source === 'reported')).toHaveLength(2);
  });

  it('the ac→CHECK MAPPING is derived by the store: the claim resolves to the recorded run, and the prose is derived when omitted', () => {
    task();
    const c = cmds();
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    const [claim] = c.conclusion(ID).claims;
    expect(claim.check).toBe('npm test');
    expect(claim.bound).toMatchObject({ command: 'npm test', result: 'pass', source: 'captured' });
    expect(claim.statement).toBe('verified by npm test'); // prose optional OR DERIVED
    // a reported run resolves too — and says so (the reader can tell a fact from a claim)
    valueOf(c.evidence(ID, [{ sha: realSha() }], { checks: [{ command: 'ann check', result: 'pass' }] }));
    expect(c.conclusion(ID).claims[0].bound).toMatchObject({ source: 'captured' });
    expect(c.conclusion(ID).checks.map((k) => k.source)).toEqual(['captured', 'reported']);
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

/**
 * THE HALF ACCEPT (leg 12/12) — closing a task while its remaining scope moves to a named
 * successor, as ONE validated act.
 *
 * The user's ask ("I want to halfly accept — the task I want to close, but need to open a
 * new task for some continuing work") was already expressible in the FORMAT and unreachable
 * from every tool: `transferred {target, scope}` had no owning command, its target was only
 * checked LATER by check(), and a genuinely unmet AC still blocked the close — so the honest
 * record was impossible and the operator was pushed into a false claim.
 */
describe('the HALF ACCEPT — one gesture, a bounded successor (leg 12/12)', () => {
  const ID = '01-leg/01-a';
  const NEXT = '01-leg/02-b';
  const C3 = { intent: 'do three things', acceptanceCriteria: ['the first is done', 'the second is done', 'the third is done'] };
  const SCOPE = 'AC-2: the second is done\nAC-3: the third is done';
  const GATE = [ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })];
  const atConfirm = () => writeNode(ID, C3, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' })]);

  /** The task at its CONFIRM gate, its work landed, AC-1 claimed by a CAPTURED pass. Every
   *  node is written BEFORE the Commands is constructed (the store reads the tree once), and
   *  the fixture's own writes happen once — the refusals below write nothing, so one fixture
   *  serves them all. */
  const halfReady = (pre?: () => void) => {
    writeNode('01-leg', C3);
    atConfirm();
    writeNode(NEXT, C3, [ev('created')]);
    if (pre) pre();
    const c = cmds(stubCapture());
    valueOf(c.capture(ID, 'npm test'));
    valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
    return c;
  };
  const half = (c: Commands, opts: { scope?: string; target?: string; why?: string } = {}) =>
    c.gate(ID, 'confirm', 'accept', opts.why ?? 'the first half landed; the rest moves with it', {
      transfer: { target: opts.target ?? NEXT, scope: opts.scope ?? SCOPE },
    });
  const eventsText = () => readFileSync(join(nodeDir(ID), 'events.jsonl'), 'utf8');

  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /* ── AC-1 — the refusals, every one NAMED and with ZERO writes ───────────────── */

  it('AC-1 refuses each malformed half accept BY NAME, writing nothing', () => {
    const cases: Array<[string, (c: Commands) => CommandResult<unknown>]> = [
      ['why-required', (c) => c.gate(ID, 'confirm', 'accept', '', { transfer: { target: NEXT, scope: SCOPE } })],
      ['why-required', (c) => c.gate(ID, 'confirm', 'accept', '   ', { transfer: { target: NEXT, scope: SCOPE } })],
      ['transfer-not-confirm', (c) => c.gate(ID, 'grill', 'accept', 'a why', { transfer: { target: NEXT, scope: SCOPE } })],
      ['transfer-not-accept', (c) => c.gate(ID, 'confirm', 'reject', 'not this time', { transfer: { target: NEXT, scope: SCOPE } })],
      ['transfer-no-target', (c) => c.gate(ID, 'confirm', 'accept', 'a why', { transfer: { target: '01-leg/nope', scope: SCOPE } })],
      ['transfer-no-target', (c) => c.gate(ID, 'confirm', 'accept', 'a why', { transfer: { target: '   ', scope: SCOPE } })],
      ['transfer-self', (c) => c.gate(ID, 'confirm', 'accept', 'a why', { transfer: { target: ID, scope: SCOPE } })],
      ['transfer-empty-scope', (c) => c.gate(ID, 'confirm', 'accept', 'a why', { transfer: { target: NEXT, scope: '  \n ' } })],
      ['transfer-unknown-ac', (c) => c.gate(ID, 'confirm', 'accept', 'a why', { transfer: { target: NEXT, scope: 'AC-9: nothing of the sort' } })],
    ];
    const c = halfReady();
    const before = eventsText();
    for (const [code, run] of cases) {
      // the GESTURE is refused, not the node: the confirm gate is still undecided afterwards
      expect(errorOf(run(c)).code, `expected ${code}`).toBe(code);
      expect(eventsText()).toBe(before); // ZERO writes — byte-identical
      expect(c.gateState(ID, 'confirm')).toBe('submitted');
    }
  });

  it('AC-1 the why is refused FIRST — --transfer is not a way around it', () => {
    const c = halfReady();
    expect(errorOf(c.gate(ID, 'confirm', 'accept', '', { transfer: { target: NEXT, scope: SCOPE } })).code).toBe('why-required');
    expect(c.events(ID).some((x) => x.type === 'transferred')).toBe(false);
  });

  it('AC-4 a SECOND identical transfer refuses by name — the scope is recorded once', () => {
    const c = halfReady();
    valueOf(half(c));
    const before = eventsText();
    const e = errorOf(half(c));
    expect(e.code).toBe('transfer-duplicate');
    expect(e.blocker).toContain('already records this exact transfer');
    expect(eventsText()).toBe(before);
    expect(c.events(ID).filter((x) => x.type === 'transferred')).toHaveLength(1);
  });

  /* ── AC-1/AC-2 — the act, the credit ────────────────────────────────────────── */

  it('AC-1 THE HALF ACCEPT: one act writes accepted → transferred → completed, in that order', () => {
    const c = halfReady();
    const out = valueOf(half(c));
    expect(out).toMatchObject({ gate: 'confirm', decision: 'accept', completed: true });
    expect(out.transferred).toEqual({ target: NEXT, scope: SCOPE });
    // ONE ORDER, and it is the one the close depends on: the transfer lands BEFORE the
    // close it is credited by, so the record never closes first and explains itself after.
    expect(c.events(ID).map((x) => x.type).slice(-3)).toEqual(['confirmed', 'transferred', 'completed']);
    const t = c.events(ID).find((x) => x.type === 'transferred')!;
    expect(t.target).toBe(NEXT);
    expect(t.scope).toBe(SCOPE); // VERBATIM — the record keeps the text the human wrote
    expect(c.status(ID)).toBe('done');
    expect(c.check()).toEqual([]); // the half accept leaves the journey form-clean
  });

  it('AC-2 the conclusion reads a transferred AC as MOVED — with its target, and never as met', () => {
    const c = halfReady();
    valueOf(half(c));
    const k = c.conclusion(ID);
    expect(k.transferred).toEqual([
      { ac: 'AC-2', acText: 'the second is done', target: NEXT },
      { ac: 'AC-3', acText: 'the third is done', target: NEXT },
    ]);
    // NEITHER claimed NOR unclaimed: the claim list does not grow a false entry
    expect(k.unclaimed).toEqual([]);
    expect(k.claims.map((x) => x.ac)).toEqual(['AC-1']);
  });

  it('AC-2 complete! stops demanding a claim for a transferred AC — and still names the real gap', () => {
    // the task is ACCEPTED but the evidence is not yet in: this is where complete! speaks
    const c = halfReady();
    valueOf(half(c, { scope: 'AC-2: the second is done\nAC-3: the third is done' }));
    expect(c.status(ID)).toBe('done');
    // a THIRD criterion moved nowhere is still named — neither claimed NOR transferred
    const c2 = (() => {
      makeStore();
      writeNode('01-leg', C3);
      writeNode('01-leg/03-c', C3, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' })]);
      writeNode(NEXT, C3, [ev('created')]);
      const x = cmds(stubCapture());
      valueOf(x.capture('01-leg/03-c', 'npm test'));
      // the evidence claims AC-1 and AC-3 only; AC-2 is the criterion that moves
      valueOf(x.evidence('01-leg/03-c', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }, { ac: 'AC-3', check: 'npm test' }] }));
      return x;
    })();
    valueOf(c2.gate('01-leg/03-c', 'confirm', 'accept', 'half', { transfer: { target: NEXT, scope: 'AC-2: the second is done' } }));
    expect(c2.conclusion('01-leg/03-c').transferred.map((t) => t.ac)).toEqual(['AC-2']);
    expect(c2.conclusion('01-leg/03-c').unclaimed).toEqual([]);
    // …and the AC that is neither gets NAMED by the one refusal that reads this derivation
    const c3 = (() => {
      makeStore();
      writeNode('01-leg', C3);
      writeNode('01-leg/03-c', C3, [ev('created'), ...GATE, ev('submitted', { gate: 'confirm' })]);
      writeNode(NEXT, C3, [ev('created')]);
      const x = cmds(stubCapture());
      valueOf(x.capture('01-leg/03-c', 'npm test'));
      valueOf(x.evidence('01-leg/03-c', [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
      valueOf(x.gate('01-leg/03-c', 'confirm', 'accept', 'half', { transfer: { target: NEXT, scope: 'AC-2: the second is done' } }));
      // the auto-close rode the accept; a re-open reads the SAME derivation the card renders
      return x;
    })();
    expect(c3.conclusion('01-leg/03-c').unclaimed).toEqual([{ ac: 'AC-3', acText: 'the third is done' }]);
  });

  it('AC-2 a transfer of RESIDUAL scope names no AC and credits none — allowed, and it satisfies nothing', () => {
    const c = halfReady();
    valueOf(half(c, { scope: 'the remaining hardening work, unnamed' }));
    expect(c.conclusion(ID).transferred).toEqual([]);
    expect(c.conclusion(ID).unclaimed.map((u) => u.ac)).toEqual(['AC-2', 'AC-3']);
  });

  it('AC-4 a transfer to ANOTHER LEG is allowed — the format target is a leg/task id', () => {
    const c = halfReady(() => {
      writeNode('02-other', C3);
      writeNode('02-other/01-c', C3, [ev('created')]);
    });
    expect(valueOf(half(c, { target: '02-other/01-c' })).transferred).toEqual({ target: '02-other/01-c', scope: SCOPE });
    expect(c.conclusion(ID).transferred.every((t) => t.target === '02-other/01-c')).toBe(true);
  });

  /* ── AC-3 — nothing else moves ──────────────────────────────────────────────── */

  it('AC-3 NO NEW STATE: every derived read after a half accept IS the read of an ordinary close', () => {
    // The strongest form of "nothing else moves": run the SAME task to the same end twice —
    // once by half accept, once by a plain confirm accept — and compare the WHOLE derived
    // surface. Anything the transfer moved beyond its own event would show up here.
    //
    // Both sides CLOSE, and that is the precondition of the comparison, not a detail of it:
    // the ordinary close this is measured against is one whose predicate HOLDS (12/22 AC-1)
    // — the same three criteria, all claimed by the same captured pass, no transfer needed.
    // The half accept reaches the same DONE terminal by MOVING two of them instead.
    const reads = (kind: 'half' | 'plain') => {
      makeStore();
      writeNode('01-leg', C3);
      atConfirm();
      writeNode(NEXT, C3, [ev('created')]);
      const c = cmds(stubCapture());
      valueOf(c.capture(ID, 'npm test'));
      if (kind === 'half') {
        valueOf(c.evidence(ID, [{ sha: realSha() }], { claims: [{ ac: 'AC-1', check: 'npm test' }] }));
        valueOf(half(c));
      } else {
        valueOf(
          c.evidence(ID, [{ sha: realSha() }], {
            claims: [
              { ac: 'AC-1', check: 'npm test' },
              { ac: 'AC-2', check: 'npm test' },
              { ac: 'AC-3', check: 'npm test' },
            ],
          }),
        );
        valueOf(c.gate(ID, 'confirm', 'accept', 'the whole thing landed; every criterion is claimed'));
      }
      return {
        status: c.status(ID),
        leg: c.status('01-leg'),
        ready: c.frontmostReady(),
        look: c.lookBack(),
        distance: runValidators(c.store, ID).filter((f) => f.code === 'distance-to-goal'),
        check: c.check(),
        verify: c.verify(),
        types: c.events(ID).map((e) => e.type),
      };
    };
    const plain = reads('plain');
    const halfReads = reads('half');
    // each read the AC names, pinned by name
    expect(halfReads.status).toBe(plain.status);
    expect(halfReads.leg).toBe(plain.leg);
    expect(plain.look.legGate).toEqual(halfReads.look.legGate);
    expect(halfReads.distance).toEqual(plain.distance);
    expect(halfReads.ready).toEqual(plain.ready);
    expect(halfReads.check).toEqual([]);
    expect(halfReads.verify).toEqual([]);
    // …and the catch-all: the whole surface, minus the transfer event itself, is identical
    expect({ ...halfReads, types: [] }).toEqual({ ...plain, types: [] });
    expect(halfReads.types.filter((t) => t !== 'transferred')).toEqual(plain.types);
    expect(plain.types).not.toContain('transferred');
    expect(halfReads.status).toBe('done'); // the same DONE terminal: no `partial`, no new word
  });

  /* ── AC-4 — order-independence of the F-AC16 check ──────────────────────────── */

  it('AC-4 F-AC16 is order-insensitive: transfer-then-complete and complete-then-transfer both pass', () => {
    const seq = (order: 'transfer-first' | 'complete-first') => {
      makeStore();
      writeNode('01-leg', C3);
      writeNode(NEXT, C3, [ev('created')]);
      const tail = [ev('created'), ...GATE, ev('gate-revised', { gate: { old: 'confirm', new: 'grill' }, note: 'terms moved (test)' })];
      const transfer = ev('transferred', { target: NEXT, scope: SCOPE });
      const completed = ev('completed');
      writeNode(ID, C3, order === 'transfer-first' ? [...tail, transfer, completed] : [...tail, completed, transfer]);
      return new Store(root).closureProblems();
    };
    expect(seq('transfer-first')).toEqual([]);
    expect(seq('complete-first')).toEqual([]);
    // the check still BITES: without the transfer, a close after a gate revision is flagged
    makeStore();
    writeNode('01-leg', C3);
    writeNode(ID, C3, [ev('created'), ...GATE, ev('gate-revised', { gate: { old: 'confirm', new: 'grill' }, note: 'x' }), ev('completed')]);
    expect(new Store(root).closureProblems()[0]).toContain('gate-revised but closed without transferred/deferred');
  });

  it('AC-4 the target-existence rule still bites — F-AC16 unchanged for a record written by hand', () => {
    writeNode('01-leg', C3);
    writeNode(ID, C3, [ev('created'), ...GATE, ev('transferred', { target: '01-leg/ghost', scope: SCOPE })]);
    expect(new Store(root).closureProblems()[0]).toContain("transferred target '01-leg/ghost' does not exist");
  });
});
