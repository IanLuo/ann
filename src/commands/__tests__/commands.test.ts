import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, JourneyEvent } from '../../store/store.js';
import { Commands, CommandResult } from '../index.js';

/**
 * L1 — the command surface. These tests pin the INVARIANTS the composites encode:
 * anything that can be reached around a composite is a hole in the invariant it owns.
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);

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
    valueOf(cmds().spawn('01-leg/01-a', CONTRACT));
    expect(errorOf(cmds().spawn('01-leg/01-a', CONTRACT)).code).toBe('exists');
    expect(errorOf(cmds().spawn('01-leg/01-b', CONTRACT)).code).toBe('prefix-clash');
  });

  it('allows grammar-named worktype segments up to the 40-char cap (v15: <NN>-<worktype>-<slug>)', () => {
    valueOf(cmds().spawn('01-leg/27-implementation-journey-format-v15', CONTRACT)); // 35 chars, worktype-tagged — the v15 grammar name spawns
    expect(errorOf(cmds().spawn('01-leg/27-implementation-journey-format-v15', CONTRACT)).code).toBe('exists');
  });

  it('holds the artifact gate on a TASK parent, and does not consult it at depth 2', () => {
    valueOf(cmds().spawn('01-leg/01-a', CONTRACT)); // depth 2: the leg parent is never gated
    expect(errorOf(cmds().spawn('01-leg/01-a/01-child', CONTRACT)).code).toBe('artifact-gate');
  });

  it('holds the leg gate on a new leg', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    expect(errorOf(cmds().spawn('02-next', CONTRACT)).code).toBe('leg-gate');
  });

  it('retires the description.md write (v13: a node dir is node.json + artifacts/)', () => {
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
      ['artifact-locked', 'lock!'],
      ['superseded', 'supersede!'],
    ]) {
      const e = errorOf(c.append('01-leg/01-a', ev(type) as JourneyEvent));
      expect(e.code).toBe('composite-owned');
      expect(e.blocker).toContain(owner);
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
});

describe('lock! — one current per name + type-driven placement (§3 rule 7)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const workingFile = (id: string, name: string, body: string) => writeFileSync(join(nodeDir(id), 'artifacts', `${name}.md`), body);

  it('places a SHARED type into docs/<category>/<name>-v<N>.md and leaves a symlink ref', () => {
    workingFile('01-leg/01-a', 'my-spec', '# body\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'my-spec', { type: 'spec' }));
    expect(locked.contentPath).toBe('.ann/docs/specs/my-spec-v1.md');
    expect(locked.path).toBe('journey/legs/01-leg/01-a/artifacts/my-spec.md');
    const ref = join(nodeDir('01-leg/01-a'), 'artifacts', 'my-spec.md');
    expect(lstatSync(ref).isSymbolicLink()).toBe(true);
    // byte-verbatim through the ref, marker stamped, sha over the STRIPPED content
    const via = readFileSync(ref, 'utf8');
    expect(via).toBe(`<!-- specs:locked:${locked.sha} ${new Date().toISOString().slice(0, 10)} type=spec -->\n# body\n`);
  });

  it('keeps a TASK-LOCAL type as a real file, unversioned', () => {
    workingFile('01-leg/01-a', 'a-record', '# note\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'a-record', { type: 'record' }));
    expect(locked.contentPath).toBe('.ann/journey/legs/01-leg/01-a/artifacts/a-record.md');
    expect(lstatSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'a-record.md')).isSymbolicLink()).toBe(false);
  });

  it('derives N from the LOG — the next version follows the recorded locks, not a counter', () => {
    workingFile('01-leg/01-a', 'my-spec', 'v1\n');
    valueOf(cmds().lock('01-leg/01-a', 'my-spec', { type: 'spec' }));
    writeNode('01-leg/02-b', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    workingFile('01-leg/02-b', 'my-spec', 'v2\n');
    // the old locker must step aside first — one current per name
    expect(errorOf(cmds().lock('01-leg/02-b', 'my-spec', { type: 'spec' })).code).toBe('already-current');
    const c = cmds();
    c.append('01-leg/01-a', ev('completed') as JourneyEvent);
    // (superseding needs a done locker; the successor path is the file it points at)
    const s = new Store(root);
    s.appendEvent('01-leg/01-a', { at: '2026-08-27', type: 'superseded', successor: { name: 'my-spec', path: '.ann/docs/specs/my-spec-v1.md' }, note: 'x' });
    const locked = valueOf(new Commands(new Store(root), 'test').lock('01-leg/02-b', 'my-spec', { type: 'spec' }));
    expect(locked.contentPath).toBe('.ann/docs/specs/my-spec-v2.md');
  });

  it('refuses an unknown artifact type', () => {
    workingFile('01-leg/01-a', 'x', 'x\n');
    expect(errorOf(cmds().lock('01-leg/01-a', 'x', { type: 'not-a-type' })).code).toBe('unknown-type');
  });
});

describe('supersede! — the one cross-task write', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeFileSync(join(root, 'successor.md'), 'x');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('REFUSES a live locker — superseded collapses a non-done node (core-design §3)', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('activated')]);
    expect(errorOf(cmds().supersede('01-leg/01-a', 'n', 'successor.md')).code).toBe('live-locker');
  });

  it('allows superseding a done locker', () => {
    writeNode('01-leg/01-a', CONTRACT, [
      ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    expect(cmds().supersede('01-leg/01-a', 'n', 'successor.md').ok).toBe(true);
  });
});

describe('read — the L1 content view (core-design §5)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('serves MARKER-STRIPPED content so what a caller reads hashes to what was locked', () => {
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'my-spec.md'), '# body\n');
    const locked = valueOf(cmds().lock('01-leg/01-a', 'my-spec', { type: 'spec' }));
    const r = valueOf(new Commands(new Store(root), 'test').read('my-spec'));
    expect(r.content).toBe('# body\n');
    expect(r.sha).toBe(locked.sha);
    expect(r.provenance).toBe('derived-from');
  });

  it('fails closed on an unresolvable name', () => {
    expect(errorOf(cmds().read('nope')).code).toBe('unresolved');
  });
});
