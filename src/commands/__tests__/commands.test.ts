import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
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
    // 01-leg/01-a produces my-spec (v1) and concludes (both gates + completed)
    writeNode('01-leg/01-a', CONTRACT, [
      ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    deliverable('01-leg/01-a', 'my-spec.md', 'v1\n');
    valueOf(cmds().lock('01-leg/01-a', 'my-spec.md'));
    writeNode('01-leg/02-b', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    deliverable('01-leg/02-b', 'my-spec.md', 'v2\n');
    // the old locker must step aside first — one current per name
    expect(errorOf(cmds().lock('01-leg/02-b', 'my-spec.md')).code).toBe('already-current');
    // supersede! (AC-4) steps the done locker aside, naming the successor by node id + file
    valueOf(new Commands(new Store(root), 'test').supersede('01-leg/01-a', '01-leg/02-b', 'my-spec.md'));
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

  it('surfaces a filesystem artifact the log never claimed', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created')]);
    writeFileSync(join(nodeDir('01-leg/01-a'), 'artifacts', 'stray.md'), 'x\n');
    expect(cmds().verify()).toContain('artifact-orphan: 01-leg/01-a/artifacts/stray.md vs no artifact-locked event of this node names it');
  });

  it('surfaces an events.jsonl dir the store does not key (node.json is the load key)', () => {
    const ghost = join(nodeDir('01-leg'), '10-ghost');
    mkdirSync(ghost, { recursive: true });
    writeFileSync(join(ghost, 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    expect(cmds().verify().some((p) => p.startsWith('node-orphan: 01-leg/10-ghost'))).toBe(true);
  });
});

describe('supersede! — the ONE cross-task write (successor named by node id + artifact file)', () => {
  beforeEach(() => {
    makeStore();
    writeNode('01-leg', {});
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Write the successor's own producer file inside its node's artifacts/ dir. */
  const deliverable = (id: string, name: string, body: string): string => {
    const p = join(nodeDir(id), 'artifacts', name);
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  /** A done locker: full gates + completed. */
  const doneLocker = (id: string): void => {
    writeNode(id, CONTRACT, [
      ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
  };

  it('REFUSES a live locker — superseded collapses a non-done node (core-design §3)', () => {
    writeNode('01-leg/01-a', CONTRACT, [ev('created'), ev('activated')]);
    writeNode('01-leg/02-b', CONTRACT, [ev('created')]);
    deliverable('01-leg/02-b', 'my-spec.md', 'v2\n');
    // checked BEFORE the successor is resolved — refused even when it exists
    expect(errorOf(cmds().supersede('01-leg/01-a', '01-leg/02-b', 'my-spec.md')).code).toBe('live-locker');
  });

  it('allows superseding a done locker, naming the successor by node id + artifact file', () => {
    doneLocker('01-leg/01-a');
    writeNode('01-leg/02-b', CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const path = deliverable('01-leg/02-b', 'my-spec.md', 'v2\n');
    const r = valueOf(new Commands(new Store(root), 'test').supersede('01-leg/01-a', '01-leg/02-b', 'my-spec.md'));
    // the recorded successor {name, path} is DERIVED from the successor node's own file —
    // never a caller-supplied path (AC-4)
    expect(r).toEqual({ name: 'my-spec', path: '.ann/journey/legs/01-leg/02-b/artifacts/my-spec.md' });
    expect(readFileSync(path, 'utf8')).toBe('v2\n'); // the successor file is untouched
    // the `superseded` record lands on the OLD locker's node
    const superseded = new Store(root).events('01-leg/01-a').find((e) => e.type === 'superseded');
    expect(superseded!.successor).toEqual({ name: 'my-spec', path: '.ann/journey/legs/01-leg/02-b/artifacts/my-spec.md' });
  });

  it('write confinement (AC-4): the successor file is confined to the successor node\'s artifacts/', () => {
    doneLocker('01-leg/01-a');
    writeNode('01-leg/02-b', CONTRACT, [ev('created')]);
    const c = cmds();
    // a separator / `..` cannot smuggle the successor path out of the successor's folder
    expect(errorOf(c.supersede('01-leg/01-a', '01-leg/02-b', '../escape.md')).code).toBe('outside-artifacts');
    expect(errorOf(c.supersede('01-leg/01-a', '01-leg/02-b', '/abs/escape.md')).code).toBe('outside-artifacts');
    // an unknown successor node is refused by resolveNode — there is no raw path to aim at
    expect(errorOf(c.supersede('01-leg/01-a', '01-leg/zzz', 'x.md')).code).toBe('no-successor-node');
    // a file the successor node never produced is refused (inside the folder, but absent)
    expect(errorOf(c.supersede('01-leg/01-a', '01-leg/02-b', 'ghost.md')).code).toBe('no-successor');
  });
});

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
});

describe('ledger — the write-rev ledger read + the store-external guard', () => {
  beforeEach(() => { makeStore(); writeNode('01-leg', {}); });
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
