import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, JourneyEvent } from '../store.js';
import { getVOCAB } from '../vocab.js';
import { blobSha } from '../sha.js';

// Fixture helper: a disposable journey store in a temp dir.
let root: string;
function makeStore() {
  root = mkdtempSync(join(tmpdir(), 'ann-store-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}
function legDir(leg: string) { return join(root, '.ann', 'journey', 'legs', leg); }
function nodeDir(id: string) { return join(root, '.ann', 'journey', 'legs', id); }
function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>>) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-19' }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-19', type, ...extra });

describe('Store — derived status (journey-format-spec v8 §12)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('derives task status from the event tail', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.status('01-goal/01-a')).toBe('done');
  });

  it('derives leg status from children: all tasks done → leg done', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('done');
  });

  it('a queued child keeps the leg queued', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('queued');
  });

  it('frontmost-ready: a failed attempt + an active retry → leg active, not failed', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('01-goal/01-attempt', {}, [ev('created'), ev('failed')]);
    writeNode('01-goal/02-retry', {}, [ev('created'), ev('activated')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('active');
  });

  it('a childless leg derives from its own lifecycle (L1 base step)', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('done');
  });

  it('all remaining children failed → leg blocked (escalate)', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('failed')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('blocked');
  });

  it('superseded annotates done, never overrides it', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed'), { at: '2026-08-19', type: 'superseded', successor: { name: 'x', path: 'y' } }]);
    const s = new Store(root);
    expect(s.status('01-goal/01-a')).toBe('done'); // status stays done; superseded is an annotation
  });
});

describe('Store — resolution current(name) (format §5)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves the artifact-locked producer that is not superseded', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('02-other/01-producer', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'journey/legs/02-other/01-producer/artifacts/spec.md', lockSha: 'aaaaaaa' } })]);
    const s = new Store(root);
    expect(s.current('spec')?.producer).toBe('02-other/01-producer');
  });

  it('a superseded producer is not current', () => {
    writeNode('01-goal', {}, [ev('created')]);
    writeNode('01-goal/01-old', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p1.md', lockSha: 'a' } })]);
    writeNode('01-goal/02-new', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p2.md', lockSha: 'b' } })]);
    writeNode('01-goal/01-old', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p1.md', lockSha: 'a' } }), ev('superseded', { successor: { name: 'spec', path: 'p2.md' } })]);
    const s = new Store(root);
    expect(s.current('spec')?.producer).toBe('01-goal/02-new');
  });

  it('parses legacy prose artifact-locked notes (resolver collect() fallback)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { note: 'spec-v3.md specs-locked (logical name: spec)' })]);
    const s = new Store(root);
    expect(s.current('spec')?.producer).toBe('01-goal/01-a');
    expect(s.current('spec')?.path).toBe('.ann/journey/legs/01-goal/01-a/artifacts/spec-v3.md');
  });

  it('derives the logical name from the filename when the note has no marker (third fallback)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { note: 'functional-spec-v3.md specs-locked — no marker here' })]);
    const s = new Store(root);
    expect(s.current('functional-spec')?.producer).toBe('01-goal/01-a');
  });

  it('normalizes legacy tree/rounds/ recorded paths to .ann/journey/legs/ (no symlinks needed)', () => {
    const legacy = join(root, '.ann', 'journey', 'legs', '01-goal');
    mkdirSync(join(legacy, 'artifacts'), { recursive: true });
    writeFileSync(join(legacy, 'artifacts', 'design.md'), 'body');
    writeNode('01-goal', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'design', path: 'tree/rounds/01-goal/artifacts/design.md', lockSha: 'a' } })]);
    const s = new Store(root);
    expect(s.current('design')?.path).toBe('.ann/journey/legs/01-goal/artifacts/design.md');
    expect(s.check()).toEqual([]); // no MISSING — the legacy path resolves
  });

  it('normalizes legacy /00/ recorded paths (the flatten, v8)', () => {
    const dir = join(root, '.ann', 'journey', 'legs', '01-goal', '01-a');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'spec.md'), 'body');
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('artifact-locked', { artifact: { name: 'spec', path: 'journey/legs/01-goal/00/01-a/artifacts/spec.md', lockSha: 'a' } })]);
    const s = new Store(root);
    expect(s.current('spec')?.path).toBe('.ann/journey/legs/01-goal/01-a/artifacts/spec.md');
    expect(s.check()).toEqual([]); // no MISSING — the /00/ path resolves
  });
});

describe('Store — appendEvent, the single writer (LB-3)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('rejects an unknown event type (vocab registry)', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent(s.resolveNode('01-goal/01-a'), ev('bogus-type'))).toThrow(/known type|vocab/);
  });

  it('rejects an event without at', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent(s.resolveNode('01-goal/01-a'), { type: 'extended' } as never)).toThrow(/at/);
  });

  it('appends a valid event (tasks only — leg roots carry no events)', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('extended'));
    expect(s.events('01-goal/01-a').map((e) => e.type)).toEqual(['created', 'extended']);
  });

  it('enforces GATE-1: produced work requires confirmed(gate=grill) before it', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent(s.resolveNode('01-goal/01-a'), ev('artifact-locked', { artifact: { name: 'x', path: 'x.md', lockSha: 'a' } }))).toThrow(/grill/);
  });

  it('enforces GATE-2: completed requires confirmed(gate=confirm)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const s = new Store(root);
    expect(() => s.appendEvent(s.resolveNode('01-goal/01-a'), ev('completed'))).toThrow(/confirm/);
  });

  it('a submitted without a decision at a gate derives blocked (v8 §3 — a gate cannot be skipped silently)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' })]);
    const s = new Store(root);
    expect(s.status('01-goal/01-a')).toBe('blocked');
    // the decision unblocks it
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    expect(new Store(root).status('01-goal/01-a')).toBe('queued');
  });

  it('flags a confirm-gate before any confirmed grill (flow-control v4 §3 — gates are sequential)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })]);
    const s = new Store(root);
    expect(s.gateProblems('01-goal/01-a').some((p) => p.includes('GATE-SEQ'))).toBe(true);
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
    ]);
    expect(new Store(root).gateProblems('01-goal/01-a').some((p) => p.includes('GATE-SEQ'))).toBe(false);
  });

  it('gateProblems is UNCONDITIONAL; the cutoff grandfathers only at CHECK-REPORTING (core-design §1)', () => {
    // A pre-cutoff task carrying the legacy prose-gate shape: the WRITER still sees the
    // gap (so it refuses new gate-skipping writes), while check() does not re-litigate it.
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed', { note: 'gate=confirm accepted' })]);
    const s = new Store(root);
    expect(s.gateProblems('01-goal/01-a').some((p) => p.includes('GATE-2'))).toBe(true);
    expect(s.check().some((p) => p.includes('GATE-2'))).toBe(false);
  });

  it('the v13 prose escapes are GONE from the writer: a note-derived gate and a bare confirmed no longer count', () => {
    // Both legacy escapes in one tail — `confirmed` with no structured gate (the
    // empty-gate fallback) and a `retrospective` grill note (the suppression).
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('confirmed', { gate: 'grill', note: 'retrospective grill' }),
      ev('artifact-locked', { artifact: { name: 'x', path: 'x.md', lockSha: 'a' } }),
      ev('confirmed', { gate: 'grill', note: 'gate=confirm — recorded in prose' }),
      ev('completed'),
    ]);
    const problems = new Store(root).gateProblems('01-goal/01-a');
    expect(problems.some((p) => p.includes('GATE-2'))).toBe(true); // no structured confirm gate
    expect(problems.some((p) => p.includes('GATE-1'))).toBe(true); // the retrospective note no longer suppresses
  });

  it('the full honest sequence appends cleanly', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('submitted', { gate: 'grill' }));
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('confirmed', { gate: 'grill' }));
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('artifact-locked', { artifact: { name: 'x', path: 'x.md', lockSha: 'a' } }));
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('submitted', { gate: 'confirm' }));
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('confirmed', { gate: 'confirm' }));
    s.appendEvent(s.resolveNode('01-goal/01-a'), ev('completed'));
    expect(s.status('01-goal/01-a')).toBe('done');
  });
});

describe('Store — check() integrity', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reports gate gaps and missing files, stays green on a clean store', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('completed')]);
    const s = new Store(root);
    expect(s.gateProblems('01-goal/01-a').filter((p) => p.includes('GATE-2'))).toHaveLength(1); // 01-a completed without confirm gate
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed')]);
    expect(new Store(root).check()).toEqual([]);
  });

  it('flags a closure without transferred/deferred after gate-revised (F-AC16)', () => {
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('gate-revised', { gate: { old: 'x', new: 'y' } }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
      ev('completed'),
    ]);
    const s = new Store(root);
    expect(s.check().some((p) => p.includes('F-AC16'))).toBe(true);
    // with the transferred event, the closure is clean
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('gate-revised', { gate: { old: 'x', new: 'y' } }),
      ev('transferred', { target: '02-next' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
      ev('completed'),
    ]);
    writeNode('02-next', {}, [ev('created')]);
    expect(new Store(root).check().some((p) => p.includes('F-AC16'))).toBe(false);
  });

  it('flags a transferred target that does not exist (F-AC16)', () => {
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('gate-revised', { gate: { old: 'x', new: 'y' } }),
      ev('transferred', { target: '99-missing' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
      ev('completed'),
    ]);
    const s = new Store(root);
    expect(s.check().some((p) => p.includes('does not exist (F-AC16)'))).toBe(true);
  });

  it('flags a MISSING current artifact file (resolution fail-closed)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'journey/legs/01-goal/01-a/artifacts/does-not-exist.md', lockSha: 'a' } })]);
    const s = new Store(root);
    expect(s.check().some((p) => p.includes('MISSING: spec'))).toBe(true);
  });

  it('flags a locked-but-orphaned name (one current per name)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p1.md', lockSha: 'a' } })]);
    writeNode('01-goal/02-b', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p2.md', lockSha: 'b' } }), ev('superseded', { successor: { name: 'other', path: 'p3.md' } })]);
    // 02-b superseded with a DIFFERENT successor name — 'spec' has a current (01-a), so no orphan:
    expect(new Store(root).check().some((p) => p.includes('NO CURRENT'))).toBe(false);
  });

  it('does not false-positive an orphan when all producers of a name are superseded toward it', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p1.md', lockSha: 'a' } })]);
    writeNode('01-goal/02-b', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p2.md', lockSha: 'b' } })]);
    writeNode('01-goal/02-b', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p2.md', lockSha: 'b' } }), ev('superseded', { successor: { name: 'spec', path: 'p3.md' } })]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: 'p1.md', lockSha: 'a' } }), ev('superseded', { successor: { name: 'spec', path: 'p2.md' } })]);
    expect(new Store(root).check().some((p) => p.includes('NO CURRENT'))).toBe(false);
  });
});

describe('Store — verify() the DRIFT read (log claims vs filesystem/git reality)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const SPEC = '# Spec\n';
  // write a real producer artifact + record a current artifact-locked event for it
  const lockSpec = (lockSha: string, id = '01-goal/01-a') => {
    const dir = join(nodeDir(id), 'artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), SPEC);
    writeNode(id, {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'spec', path: `journey/legs/${id}/artifacts/spec.md`, lockSha } })]);
    return join(dir, 'spec.md');
  };

  it('stays green on a coherent store: real file + matching lockSha (no docs/ layer)', () => {
    lockSpec(blobSha(SPEC).slice(0, 7));
    expect(new Store(root).verify()).toEqual([]);
  });

  it('D2 — flags a current artifact whose recorded lockSha no longer matches the file bytes', () => {
    const actual = blobSha(SPEC);
    lockSpec(actual.slice(0, 7) + 'x'); // last char changed — the recorded sha is stale
    const drifts = new Store(root).verify();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toContain('locksha: spec');
  });

  it('D4 — flags an .md under artifacts/ that no artifact-locked event names', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const dir = join(nodeDir('01-goal/01-a'), 'artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal.md'), 'orphan\n');
    expect(new Store(root).verify()).toContain('artifact-orphan: 01-goal/01-a/artifacts/goal.md vs no artifact-locked event of this node names it');
  });

  it('D4 — an evidence-cited fixture in artifacts/ is accounted for, not an orphan (F4 gone)', () => {
    const dir = join(nodeDir('01-goal/01-a'), 'artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'analysis.md'), '# analysis\n');
    writeNode('01-goal/01-a', {}, [ev('created'), ev('evidence', { refs: ['.ann/journey/legs/01-goal/01-a/artifacts/analysis.md'] })]);
    expect(new Store(root).verify()).toEqual([]);
  });

  it('D4 — flags events.jsonl without node.json (invisible to the store) and the mirror', () => {
    writeNode('01-goal', {}, []);
    const ghost = join(nodeDir('01-goal'), '10-no-node');
    mkdirSync(ghost, { recursive: true });
    writeFileSync(join(ghost, 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    // a task dir with node.json but no log — the "vice versa" of the pair
    mkdirSync(join(nodeDir('01-goal'), '11-no-log'), { recursive: true });
    writeFileSync(join(nodeDir('01-goal'), '11-no-log', 'node.json'), JSON.stringify({ id: '01-goal/11-no-log', contract: {}, createdAt: '2026-08-19' }));
    const drifts = new Store(root).verify();
    expect(drifts).toContain('node-orphan: 01-goal/10-no-node — events.jsonl vs node.json (invisible to the store — load keys on node.json)');
    expect(drifts).toContain('node-orphan: 01-goal/11-no-log — node.json vs events.jsonl (a task dir with no log)');
  });
});

describe('Store — spawn (creation record + created event through the single writer)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes node.json + the created event via appendEvent (tasks)', () => {
    const s = new Store(root);
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(existsSync(join(root, '.ann', 'journey', 'legs', '01-goal', '01-a', 'node.json'))).toBe(true);
    expect(s.events('01-goal/01-a').map((e) => e.type)).toEqual(['created']);
    expect(s.status('01-goal/01-a')).toBe('queued');
  });

  it('spawning a leg writes NO events at all (v8 §13 — leg roots have no log)', () => {
    const s = new Store(root);
    s.spawn('07-new-leg', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(existsSync(join(root, '.ann', 'journey', 'legs', '07-new-leg', 'events.jsonl'))).toBe(false);
    expect(s.events('07-new-leg')).toEqual([]);
  });

  it('appendEvent refuses events on leg roots (write path = the enforcement)', () => {
    const s = new Store(root);
    s.spawn('07-new-leg', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(() => s.appendEvent(s.resolveNode('07-new-leg'), ev('completed'))).toThrow(/leg roots carry no events/);
  });

  it('writes openQuestions as a TOP-LEVEL sibling of contract (format v14 §2)', () => {
    const s = new Store(root);
    const oq = [{ id: 'Q1', question: 'which way?', blocking: true }];
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'], openQuestions: oq } });
    const node = JSON.parse(readFileSync(join(root, '.ann', 'journey', 'legs', '01-goal', '01-a', 'node.json'), 'utf8'));
    expect(node.openQuestions).toEqual(oq);
    expect(node.contract.openQuestions).toBeUndefined();
    expect(Object.keys(node)).toEqual(['id', 'contract', 'openQuestions', 'createdAt']);
  });

  it('rejects a re-spawn (immutable id)', () => {
    const s = new Store(root);
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(() => new Store(root).spawn('01-goal/01-a', {})).toThrow();
  });

  it('write confinement (AC-1): resolveNode mints the ONE id→folder mapping and refuses every escape', () => {
    const s = new Store(root);
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    // the canonical folder — the only target a writer may derive from
    expect(s.resolveNode('01-goal/01-a').dir).toBe(join(root, '.ann', 'journey', 'legs', '01-goal', '01-a'));
    expect(s.resolveNode('01-goal/01-a').id).toBe('01-goal/01-a');
    // a nonexistent node is refused (the handle names an EXISTING node only)
    expect(() => s.resolveNode('01-goal/zzz')).toThrow(/no node/);
    // anything that would smuggle a write outside the legs root is refused at resolve,
    // before any write — a caller cannot mint a handle for a folder it does not own
    expect(() => s.resolveNode('..')).toThrow(/not a node under the store's legs root/);
    expect(() => s.resolveNode('../escape')).toThrow(/not a node under the store's legs root/);
    expect(() => s.resolveNode('01-goal/01-a/../..')).toThrow(/not a node under the store's legs root/); // normalizes to the legs root itself
    expect(() => s.resolveNode('01-goal/01-a/../01-a')).toThrow(/no node/); // back under the root, but not an existing node
  });
});

describe('Store — append-only and leg-root discipline', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('leg-level events are inert: status derives from children, never from root events', () => {
    // A leg whose root events claim completed stays QUEUED while a child is unfinished —
    // the derived model ignores leg-root events for status (v8 §12).
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('queued'); // children win, root events are inert
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    expect(new Store(root).status('01-goal')).toBe('done');
  });
});

describe('Store — leg gate (v8 §12/§13)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('blocks a new leg until the predecessor leg\'s tasks are all done', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.legGateMet('02-next').met).toBe(true); // predecessor (01-goal) tasks all done
    writeNode('01-goal/02-b', {}, [ev('created')]);
    expect(new Store(root).legGateMet('02-next').met).toBe(false); // 02-b unfinished (fresh snapshot)
  });

  it('a childless predecessor uses its own record (L1 base step)', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.legGateMet('02-next').met).toBe(true);
    writeNode('01-goal', {}, [ev('created')]);
    expect(new Store(root).legGateMet('02-next').met).toBe(false);
  });
});

describe('VOCAB — the registry is the source of truth', () => {
  it('carries the schema vocabulary', () => {
    expect(getVOCAB().eventTypes).toContain('artifact-locked');
    expect(getVOCAB().gates).toEqual(['grill', 'confirm']);
    expect(getVOCAB().eventTypes).toContain('waiting'); // v14 §3 — the empty-chain verify wait
    // v3 (resource-registry §9 migration 1): artifactTypes entries carry the docs/
    // category they place into + whether they take a -v<N> filename — this is what
    // makes placement DERIVE from the type instead of being a code convention.
    expect(getVOCAB().artifactTypes.spec).toEqual({ category: 'specs', versioned: true });
    expect(getVOCAB().artifactTypes.record.versioned).toBe(false);
    expect(getVOCAB().artifactTypes.record.category).toBeUndefined(); // task-local
  });
});

describe('Store — F-AC18 artifact gate (format v9 §14)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const writeV9Node = (id: string, createdAt: string, events: Array<Record<string, unknown>>) => {
    mkdirSync(nodeDir(id), { recursive: true });
    writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract: {}, createdAt }));
    writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('flags a v9-spawned task completed without an artifact-locked record', () => {
    writeV9Node('06-engine-build/05-new-task', '2026-08-21', [
      ev('created'), ev('confirmed', { gate: 'grill' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    expect(new Store(root).check().some((p) => p.includes('F-AC18'))).toBe(true);
  });

  it('grandfathers a pre-v9 task (createdAt before the cutoff)', () => {
    writeV9Node('06-engine-build/04-old-task', '2026-08-19', [
      ev('created'), ev('confirmed', { gate: 'grill' }), ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    expect(new Store(root).check().some((p) => p.includes('F-AC18'))).toBe(false);
  });

  it('a v9 task WITH an artifact-locked record passes F-AC18', () => {
    const id = '06-engine-build/06-new-task';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'record.md'), '# record\n');
    writeV9Node(id, '2026-08-21', [
      ev('created'), ev('confirmed', { gate: 'grill' }),
      ev('artifact-locked', { artifact: { name: 'record', path: 'journey/legs/06-engine-build/06-new-task/artifacts/record.md', lockSha: 'abc1234' } }),
      ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    expect(new Store(root).check().some((p) => p.includes('F-AC18'))).toBe(false);
  });

  it('a v9 task with STRUCTURED commit evidence (no artifact-locked) passes F-AC18 (v10)', () => {
    writeV9Node('06-engine-build/07-code-task', '2026-08-21', [
      ev('created'), ev('confirmed', { gate: 'grill' }),
      ev('evidence', { commits: [{ sha: '8e94c58', note: 'step 1' }], refs: ['src/abilities/llm/'] }),
      ev('confirmed', { gate: 'confirm' }), ev('completed'),
    ]);
    expect(new Store(root).check().some((p) => p.includes('F-AC18'))).toBe(false);
  });

  it('parentConcluded: true for a locked artifact OR commit evidence, false for neither (v10 gate)', () => {
    const a = '06-engine-build/08a';
    const b = '06-engine-build/08b';
    const c = '06-engine-build/08c';
    mkdirSync(join(nodeDir(a), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(a), 'artifacts', 'x.md'), '# x\n');
    writeNode(a, {}, [ev('artifact-locked', { artifact: { name: 'x', path: 'journey/legs/06-engine-build/08a/artifacts/x.md', lockSha: 'abc' } })]);
    writeNode(b, {}, [ev('evidence', { commits: [{ sha: 'abc1234' }] })]);
    writeNode(c, {}, [ev('evidence', { note: 'no commits here' })]);
    const s = new Store(root);
    expect(s.parentConcluded(a)).toBe(true); // artifact-locked
    expect(s.parentConcluded(b)).toBe(true); // commit evidence
    expect(s.parentConcluded(c)).toBe(false); // prose only — never counts (NFR-COM-1)
  });
});

describe('Store — current() resolves by logical name (multi-artifact producers, v9)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a producer locking two artifacts resolves each by its own name', () => {
    const id = '06-engine-build/13-amendment';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'a.md'), '# a\n');
    writeFileSync(join(nodeDir(id), 'artifacts', 'b.md'), '# b\n');
    writeNode(id, {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'a-spec', path: 'journey/legs/06-engine-build/13-amendment/artifacts/a.md', lockSha: '1111111' } }),
      ev('artifact-locked', { artifact: { name: 'b-spec', path: 'journey/legs/06-engine-build/13-amendment/artifacts/b.md', lockSha: '2222222' } }),
    ]);
    const s = new Store(root);
    expect(s.current('b-spec')?.path).toBe('.ann/journey/legs/06-engine-build/13-amendment/artifacts/b.md');
    expect(s.current('a-spec')?.path).toBe('.ann/journey/legs/06-engine-build/13-amendment/artifacts/a.md');
  });
});

describe('Store — commit traceability (format v10 §9)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('flags an evidence.commits[] sha that does not resolve in git', () => {
    writeNode('06-engine-build/09-code', {}, [
      ev('evidence', { commits: [{ sha: 'deadbeef00000000000000000000000000000000' }] }),
    ]);
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('deadbeef00000000000000000000000000000000') && p.includes('does not resolve'))).toBe(true);
  });

  it('passes a commits[] sha that DOES resolve in git (real repo commit)', () => {
    writeNode('06-engine-build/10-code', {}, [
      ev('evidence', { commits: [{ sha: '8e94c58' }], refs: ['src/abilities/llm/'] }),
    ]);
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('does not resolve') || p.includes('does not exist'))).toBe(false);
  });

  it('flags a refs[] path that does not exist', () => {
    writeNode('06-engine-build/11-code', {}, [
      ev('evidence', { commits: [{ sha: '8e94c58' }], refs: ['src/definitely-not-a-real-dir/'] }),
    ]);
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('src/definitely-not-a-real-dir/') && p.includes('does not exist'))).toBe(true);
  });

  it('ignores evidence without commits[]/refs[] (prose-only never checked — NFR-COM-1)', () => {
    writeNode('06-engine-build/12-code', {}, [ev('evidence', { note: 'checkpoint — prose mentions a commit' })]);
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('does not resolve') || p.includes('does not exist'))).toBe(false);
  });
});

describe('Store — detail() (the full task/leg card)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('derives contract, gate states, artifact roles, and blockers for a task', () => {
    const id = '06-engine-build/05-s2';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'spec.md'), '# spec\n');
    writeNode(
      id,
      { intent: 'Build the thing', acceptanceCriteria: ['AC-A', 'AC-B'], targetAreas: ['src/'] },
      [
        ev('created'),
        ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
        ev('submitted', { gate: 'confirm' }), // pending — human hasn't decided
        ev('artifact-locked', { artifact: { name: 'thing-spec', path: 'journey/legs/06-engine-build/05-s2/artifacts/spec.md', lockSha: 'abc1234' } }),
      ],
    );
    const d = new Store(root).detail(id);
    expect(d.isLeg).toBe(false);
    expect(d.status).toBe('blocked'); // pending confirm gate
    if (!d.contract) throw new Error('contract missing');
    expect(d.contract.intent).toBe('Build the thing');
    expect(d.contract.acceptanceCriteria).toEqual(['AC-A', 'AC-B']);
    expect(d.gates.grill).toMatchObject({ state: 'confirmed' });
    expect(d.gates.confirm.state).toBe('submitted'); // awaiting decision
    expect(d.artifacts).toEqual([
      expect.objectContaining({ name: 'thing-spec', sha: 'abc1234', role: 'current', path: '.ann/journey/legs/06-engine-build/05-s2/artifacts/spec.md' }),
    ]);
    expect(d.blockers).toEqual(['submitted (gate=confirm) awaiting decision']);
    expect(d.events.length).toBe(5);
  });

  it('marks an artifact superseded when another producer holds current', () => {
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/01-a/artifacts/x.md', lockSha: '111' } }),
      ev('superseded', { successor: { name: 'x-spec', path: 'journey/legs/01-goal/01-b/artifacts/x2.md' } }),
    ]);
    writeNode('01-goal/01-b', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/01-b/artifacts/x2.md', lockSha: '222' } }),
    ]);
    const s = new Store(root);
    const d1 = s.detail('01-goal/01-a');
    const d2 = s.detail('01-goal/01-b');
    expect(d1.artifacts[0].role).toBe('superseded');
    expect(d2.artifacts[0].role).toBe('current');
  });

  it('lists a leg\'s tasks with statuses', () => {
    writeNode('06-engine-build', {}, []);
    writeNode('06-engine-build/01-a', {}, [ev('created'), ev('completed')]);
    writeNode('06-engine-build/02-b', {}, [ev('created')]);
    const d = new Store(root).detail('06-engine-build');
    expect(d.isLeg).toBe(true);
    expect(d.tasks).toEqual([
      { id: '06-engine-build/01-a', status: 'done' },
      { id: '06-engine-build/02-b', status: 'queued' },
    ]);
  });
});

describe('Store — F-AC19 contract checklist (format v11 §2/§7)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const currentArtifact = () => {
    // a current artifact 'x-spec' so requiredInputs can resolve
    const id = '01-goal/00-spec';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'x.md'), '# x\n');
    writeNode(id, {}, [ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/00-spec/artifacts/x.md', lockSha: 'aaa' } })]);
  };

  it('contractProblems: a self-sufficient contract passes', () => {
    currentArtifact();
    const s = new Store(root);
    expect(s.contractProblems({ intent: 'Do the thing', acceptanceCriteria: ['AC1'], requiredInputs: ['x-spec'] })).toEqual([]);
  });

  it('contractProblems: flags missing intent / empty ACs / unresolvable input by name', () => {
    currentArtifact();
    const s = new Store(root);
    expect(s.contractProblems({ acceptanceCriteria: ['AC1'] })).toEqual([expect.stringContaining('intent')]);
    expect(s.contractProblems({ intent: 'x', acceptanceCriteria: [] })).toEqual([expect.stringContaining('acceptanceCriteria')]);
    expect(s.contractProblems({ intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['no-such-artifact'] })).toEqual([
      expect.stringContaining("requiredInput 'no-such-artifact' does not resolve"),
    ]);
  });

  it('check() flags a v9+ task with an unresolvable input (F-AC19)', () => {
    currentArtifact();
    mkdirSync(join(nodeDir('06-engine-build/16-bad'), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir('06-engine-build/16-bad'), 'node.json'), JSON.stringify({ id: '06-engine-build/16-bad', contract: { intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['no-such-artifact'] }, createdAt: '2026-08-22' }));
    writeFileSync(join(nodeDir('06-engine-build/16-bad'), 'events.jsonl'), '');
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('F-AC19') && p.includes('16-bad'))).toBe(true);
  });

  it('check() grandfathers a pre-v9 task with an unresolvable input', () => {
    currentArtifact();
    mkdirSync(join(nodeDir('06-engine-build/17-old'), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir('06-engine-build/17-old'), 'node.json'), JSON.stringify({ id: '06-engine-build/17-old', contract: { intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['legacy-path.md'] }, createdAt: '2026-08-19' }));
    writeFileSync(join(nodeDir('06-engine-build/17-old'), 'events.jsonl'), '');
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('F-AC19'))).toBe(false);
  });

  it('check() passes a v9+ task with a self-sufficient contract', () => {
    currentArtifact();
    mkdirSync(join(nodeDir('06-engine-build/18-good'), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir('06-engine-build/18-good'), 'node.json'), JSON.stringify({ id: '06-engine-build/18-good', contract: { intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['x-spec'] }, createdAt: '2026-08-22' }));
    writeFileSync(join(nodeDir('06-engine-build/18-good'), 'events.jsonl'), '');
    const problems = new Store(root).check();
    expect(problems.some((p) => p.includes('F-AC19'))).toBe(false);
  });
});

describe('Store — strict event schema (format v12 §3: unknown fields + shapes rejected)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const s = () => new Store(root);
  const expectReject = (id: string, event: JourneyEvent, re: RegExp) => {
    const store = s();
    expect(() => store.appendEvent(store.resolveNode(id), event)).toThrow(re);
  };

  it('rejects an unknown top-level field on any event type', () => {
    writeNode('06-engine-build/20-a', {}, [ev('created')]);
    expectReject('06-engine-build/20-a', { at: '2026-08-22', type: 'evidence', note: 'x', totallyUnknown: 1 }, /unknown field/);
  });

  it('rejects a malformed artifact (not {name, path, lockSha?, type?, version?})', () => {
    writeNode('06-engine-build/20-b', {}, [ev('created')]);
    expectReject('06-engine-build/20-b', { at: '2026-08-22', type: 'artifact-locked', artifact: 'garbage' } as unknown as JourneyEvent, /artifact.*must be/);
    expectReject('06-engine-build/20-b', { at: '2026-08-22', type: 'artifact-locked', artifact: { name: 'x' } } as unknown as JourneyEvent, /artifact.*must be/); // path missing
    // type is an optional STRING tag; version must stay a number
    expectReject('06-engine-build/20-b', { at: '2026-08-22', type: 'artifact-locked', artifact: { name: 'x', path: 'x.md', lockSha: 'a', type: 7 } } as unknown as JourneyEvent, /type must be a string/);
    expectReject('06-engine-build/20-b', { at: '2026-08-22', type: 'artifact-locked', artifact: { name: 'x', path: 'x.md', lockSha: 'a', version: 'v1' } } as unknown as JourneyEvent, /version must be a number/);
  });

  it('rejects a malformed successor and a gate outside the vocab', () => {
    writeNode('06-engine-build/20-c', {}, [ev('created')]);
    expectReject('06-engine-build/20-c', { at: '2026-08-22', type: 'superseded', successor: { name: 'x' } } as unknown as JourneyEvent, /successor.*must be/);
    expectReject('06-engine-build/20-c', { at: '2026-08-22', type: 'confirmed', gate: 'not-a-gate' } as unknown as JourneyEvent, /gate must be/);
  });

  it('G1 — a non-string feedback on confirmed is rejected (mirrors rejected)', () => {
    writeNode('06-engine-build/20-g', {}, [ev('created')]);
    expectReject('06-engine-build/20-g', { at: '2026-08-22', type: 'confirmed', gate: 'grill', feedback: 42 } as unknown as JourneyEvent, /confirmed.feedback must be a string/);
    expectReject('06-engine-build/20-g', { at: '2026-08-22', type: 'rejected', gate: 'grill', feedback: ['no'] } as unknown as JourneyEvent, /rejected.feedback must be a string/);
  });

  it('rejects malformed commits/refs on evidence', () => {
    writeNode('06-engine-build/20-d', {}, [ev('created')]);
    expectReject('06-engine-build/20-d', { at: '2026-08-22', type: 'evidence', commits: [{ noSha: true }] } as unknown as JourneyEvent, /commits must be/);
    expectReject('06-engine-build/20-d', { at: '2026-08-22', type: 'evidence', refs: [42] } as unknown as JourneyEvent, /refs must be/);
  });

  it('accepts the valid shapes the engine itself writes (dogfood)', () => {
    writeNode('06-engine-build/20-e', {}, [ev('created')]);
    const s2 = s();
    s2.appendEvent(s2.resolveNode('06-engine-build/20-e'), { at: '2026-08-22', type: 'confirmed', gate: 'grill', note: 'ok', feedback: 'looks right' }); // GATE-1 first (G1 feedback)
    s2.appendEvent(s2.resolveNode('06-engine-build/20-e'), { at: '2026-08-22', type: 'evidence', commits: [{ sha: 'abc1234', note: 'step' }], refs: ['src/x'], note: 'ok' });
    s2.appendEvent(s2.resolveNode('06-engine-build/20-e'), { at: '2026-08-22', type: 'artifact-locked', artifact: { name: 'x', path: 'journey/legs/06-engine-build/20-e/artifacts/x.md', lockSha: 'abc', type: 'script', version: 1 }, note: 'ok' });
    expect(s2.events('06-engine-build/20-e').length).toBe(4); // created + 3 valid
  });
});

  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('Store — supersession is PER-NAME (format §3/§5; multi-artifact producers)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('superseding one of a producer\'s locks keeps its other lock current', () => {
    // P1 locks A and B; A is superseded (structured successor.name=A); P2 locks A.
    writeNode('01-goal/01-p1', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'a-spec', path: 'journey/legs/01-goal/01-p1/artifacts/a.md', lockSha: '111' } }),
      ev('artifact-locked', { artifact: { name: 'b-spec', path: 'journey/legs/01-goal/01-p1/artifacts/b.md', lockSha: '222' } }),
      ev('superseded', { successor: { name: 'a-spec', path: 'journey/legs/01-goal/02-p2/artifacts/a2.md' } }),
    ]);
    writeNode('01-goal/02-p2', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'a-spec', path: 'journey/legs/01-goal/02-p2/artifacts/a2.md', lockSha: '333' } }),
    ]);
    const s = new Store(root);
    expect(s.current('a-spec')?.producer).toBe('01-goal/02-p2'); // superseded → P2
    expect(s.current('b-spec')?.producer).toBe('01-goal/01-p1'); // NOT excluded — still P1
    expect(s.check().some((p) => p.includes('NO CURRENT'))).toBe(false);
  });

  it('legacy prose supersession (no successor.name) still excludes the producer', () => {
    writeNode('01-goal/01-legacy', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/01-legacy/artifacts/x.md', lockSha: '111' } }),
      ev('superseded', { note: 'artifacts/x.md (v1) superseded by successor artifact' }),
    ]);
    writeNode('01-goal/02-legacy', {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/02-legacy/artifacts/x2.md', lockSha: '222' } }),
    ]);
    const s = new Store(root);
    expect(s.current('x-spec')?.producer).toBe('01-goal/02-legacy');
  });
});

describe('Store — results() (type-aware result gathering, format v10)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('gathers docs, commits, refs, links, and evidence from the log, in order', () => {
    const id = '06-engine-build/05-s2';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'spec.md'), '# spec\n');
    writeNode(id, {}, [
      ev('created'),
      ev('artifact-locked', { artifact: { name: 'thing-spec', path: 'journey/legs/06-engine-build/05-s2/artifacts/spec.md', lockSha: 'abc1234' } }),
      ev('evidence', { commits: [{ sha: '8e94c58', note: 'step 1' }], refs: ['src/abilities/llm/', 'https://example.com/ext'] }),
      ev('evidence', { note: 'checkpoint — prose only' }),
    ]);
    const items = new Store(root).results(id);
    expect(items.map((i) => i.kind)).toEqual(['doc', 'commit', 'ref', 'link', 'evidence']);
    expect(items[0]).toMatchObject({ kind: 'doc', label: expect.stringContaining('thing-spec @ abc1234 [current]') });
    expect(items[1]).toMatchObject({ kind: 'commit', sha: '8e94c58' });
    expect(items[2]).toMatchObject({ kind: 'ref', path: 'src/abilities/llm/' });
    expect(items[3]).toMatchObject({ kind: 'link', url: 'https://example.com/ext' });
    expect(items[4]).toMatchObject({ kind: 'evidence', note: expect.stringContaining('prose only') });
  });

  it('returns an empty list for a node with no results', () => {
    writeNode('06-engine-build/05-empty', {}, [ev('created')]);
    expect(new Store(root).results('06-engine-build/05-empty')).toEqual([]);
  });
});

describe('Store — the write-rev ledger (store-external integrity)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const CONTRACT = { intent: 'build the ledger', acceptanceCriteria: ['detection works'] };
  const LEDGER = () => join(root, '.ann', 'journey', '.ledger.json');
  const readLedger = () =>
    JSON.parse(readFileSync(LEDGER(), 'utf8')) as { rev: number; nodes: Record<string, { eventsContent: string; nodeContent: string; lastRev: number }> };
  const evPath = (id: string) => join(nodeDir(id), 'events.jsonl');
  const drift = (id: string) => new Store(root).verify().find((d) => d.startsWith(`store-external: ${id}`));
  const extended = () => ev('extended', { note: 'more work' });

  it('reads never create the ledger; the first write bootstraps it with exact bytes', () => {
    writeNode('01-leg/01-a', {}, [ev('created')]);
    new Store(root).verify();
    expect(existsSync(LEDGER())).toBe(false);
    new Store(root).spawn('01-leg/02-b', CONTRACT);
    expect(existsSync(LEDGER())).toBe(true);
    const node = readLedger().nodes['01-leg/02-b'];
    expect(readLedger().rev).toBeGreaterThanOrEqual(1);
    expect(node.eventsContent).toBe(readFileSync(evPath('01-leg/02-b'), 'utf8')); // byte-for-byte
    expect(node.nodeContent).toBe(readFileSync(join(nodeDir('01-leg/02-b'), 'node.json'), 'utf8'));
  });

  it('a leg spawn records nodeContent only (leg roots carry no events)', () => {
    new Store(root).spawn('01-leg', CONTRACT);
    const node = readLedger().nodes['01-leg'];
    expect(node.eventsContent).toBe('');
    expect(node.nodeContent.length).toBeGreaterThan(0);
  });

  it('refuses a write when events.jsonl was changed outside the CLI (no masking)', () => {
    const s = new Store(root);
    s.spawn('01-leg/01-a', CONTRACT);
    appendFileSync(evPath('01-leg/01-a'), JSON.stringify(ev('extended', { note: 'hand-written' })) + '\n');
    expect(() => s.appendEvent(s.resolveNode('01-leg/01-a'), extended())).toThrow(/store-external edit on 01-leg\/01-a/);
  });

  it('refuses a write when node.json was changed outside the CLI', () => {
    const s = new Store(root);
    s.spawn('01-leg/01-a', CONTRACT);
    writeFileSync(join(nodeDir('01-leg/01-a'), 'node.json'), JSON.stringify({ id: '01-leg/01-a', contract: { intent: 'tampered' }, createdAt: '2026-08-20' }));
    expect(() => s.appendEvent(s.resolveNode('01-leg/01-a'), extended())).toThrow(/store-external edit on 01-leg\/01-a/);
  });

  it('a fixture node with no ledger entry writes cleanly and gains an entry', () => {
    writeNode('01-leg/01-a', {}, [ev('created')]);
    const s = new Store(root);
    s.appendEvent(s.resolveNode('01-leg/01-a'), extended());
    expect(readLedger().nodes['01-leg/01-a'].lastRev).toBeGreaterThan(0);
    expect(() => s.appendEvent(s.resolveNode('01-leg/01-a'), extended())).not.toThrow(); // disk now matches the ledger
  });

  it('verify classifies an external append with its onset bound and the differing line', () => {
    const s = new Store(root);
    s.spawn('01-leg/01-a', CONTRACT);
    s.appendEvent(s.resolveNode('01-leg/01-a'), extended());
    appendFileSync(evPath('01-leg/01-a'), JSON.stringify(ev('extended', { note: 'forged' })) + '\n');
    const d = drift('01-leg/01-a');
    expect(d).toContain('class=append');
    expect(d).toContain('rev ');
    expect(d).toContain('+1 line(s)');
    expect(d).toContain('forged');
  });

  it('verify classifies truncate, reorder and rewrite', () => {
    const s = new Store(root);
    s.spawn('01-leg/01-a', CONTRACT);
    s.appendEvent(s.resolveNode('01-leg/01-a'), extended());
    const twoLines = readFileSync(evPath('01-leg/01-a'), 'utf8');
    // truncate — one ann line gone
    writeFileSync(evPath('01-leg/01-a'), twoLines.split('\n')[0] + '\n');
    expect(drift('01-leg/01-a')).toContain('class=truncate');
    // reorder — same events, different order
    writeFileSync(evPath('01-leg/01-a'), twoLines);
    const lines = twoLines.trim().split('\n');
    writeFileSync(evPath('01-leg/01-a'), lines[1] + '\n' + lines[0] + '\n');
    expect(drift('01-leg/01-a')).toContain('class=reorder');
    // rewrite — a line changed in place
    writeFileSync(evPath('01-leg/01-a'), twoLines);
    writeFileSync(evPath('01-leg/01-a'), twoLines.replace('more work', 'changed!'));
    const d = drift('01-leg/01-a');
    expect(d).toContain('class=rewrite');
    expect(d).toMatch(/L\d+/); // names the differing line number
    expect(d).toContain('changed!');
  });

  it('verify classifies a node.json edit', () => {
    const s = new Store(root);
    s.spawn('01-leg/01-a', CONTRACT);
    const nd = join(nodeDir('01-leg/01-a'), 'node.json');
    writeFileSync(nd, readFileSync(nd, 'utf8').replace('build the ledger', 'tampered'));
    expect(drift('01-leg/01-a')).toContain('class=node-edit');
  });

  it('verify reports an unparseable events.jsonl without crashing (load hardening)', () => {
    new Store(root).spawn('01-leg/01-a', CONTRACT);
    writeFileSync(evPath('01-leg/01-a'), 'not-json\n');
    const problems = new Store(root).verify();
    expect(problems.some((d) => d.startsWith('unparseable-events: 01-leg/01-a'))).toBe(true);
  });

  it('a corrupt ledger refuses writes (before touching the log) and is reported by verify', () => {
    new Store(root).spawn('01-leg/01-a', CONTRACT); // bootstrap a real ledger
    writeFileSync(LEDGER(), '{{{ not json');
    const s2 = new Store(root);
    expect(() => s2.appendEvent(s2.resolveNode('01-leg/01-a'), extended())).toThrow(/ledger-corrupt/);
    expect(readFileSync(evPath('01-leg/01-a'), 'utf8')).not.toContain('more work'); // log untouched
    expect(new Store(root).verify().some((d) => d.includes('ledger-corrupt'))).toBe(true);
  });

  it('verify has no store-external lines on a legacy store with no ledger', () => {
    writeNode('01-leg/01-a', {}, [ev('created'), ev('completed')]);
    expect(new Store(root).verify().filter((d) => d.startsWith('store-external:'))).toEqual([]);
  });
});

describe('Store — v6 goal session (goal-session-design §2/§4 + seed/archive)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const CONTRACT = { intent: 'build the goal session', acceptanceCriteria: ['it archives faithfully'] };
  const DOC = '# Goal\n\nGoal: Build the goal session\n\nSuccess criteria:\n- goal.md locks on the goal root\n- a met verdict seals exhaustion\n';
  const goalLock = { at: '2026-08-19', type: 'artifact-locked', artifact: { name: 'goal', path: '.ann/journey/legs/01-goal/artifacts/goal.md', lockSha: 'aaaaaaa' } };

  it('the goal leg is the CHILDLESS seeded leg — a goal leg with children is ordinary', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]); // legacy 01-goal shape matches the same predicate
    expect(new Store(root).goalLegId()).toBe('01-goal');
    expect(new Store(root).status('01-goal')).toBe('done'); // seed events make legStatus derive done
    // a 01-goal WITH a task child is not a goal leg
    writeNode('02-goal', {}, [ev('created'), ev('completed')]);
    writeNode('02-goal/01-a', {}, [ev('created'), ev('completed')]);
    expect(new Store(root).goalLegId()).toBe('01-goal'); // 02-goal: not childless, not the goal
    expect(new Store(root).status('02-goal')).toBe('done'); // but still a derived-done ordinary leg
  });

  it('a locked goal.md alone designates a CHILDLESS leg as the goal leg', () => {
    writeNode('01-goal', {}, [goalLock]);
    expect(new Store(root).goalLegId()).toBe('01-goal');
  });

  it('goal-met + the goal.md lock append ONLY on the designated goal leg root — never a task or another leg', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    writeNode('02-work', {}, []);
    writeNode('02-work/01-a', {}, [ev('created')]);
    // the frontmost seeded leg is the goal; a task under 02-work is not
    const s = new Store(root);
    expect(() => s.appendEvent(s.resolveNode('01-goal'), ev('goal-met', { decision: 'met' }))).not.toThrow();
    expect(() => s.appendEvent(s.resolveNode('02-work/01-a'), ev('goal-met', { decision: 'met' }))).toThrow(/goal-root verdict/);
    // a childless seeded leg BEHIND the goal leg carries no goal events either (leg-root guard)
    writeNode('09-other', {}, [ev('created'), ev('completed')]);
    const s2 = new Store(root);
    expect(() => s2.appendEvent(s2.resolveNode('09-other'), ev('goal-met', { decision: 'met' }))).toThrow(/leg roots carry no events/);
    // the seed is written by seedGoal only — the general writer refuses it on the goal root
    const s3 = new Store(root);
    expect(() => s3.appendEvent(s3.resolveNode('01-goal'), ev('completed'))).toThrow(/leg roots carry no events/);
    // the goal.md lock rides the same goal-root carve-out
    const s4 = new Store(root);
    expect(() => s4.appendEvent(s4.resolveNode('01-goal'), goalLock)).not.toThrow();
  });

  it('goal-met is STATUS-INERT — the verdict never moves legStatus (the seed already derived done)', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    expect(s.status('01-goal')).toBe('done');
    s.appendEvent(s.resolveNode('01-goal'), ev('goal-met', { decision: 'met', note: 'sealed', feedback: 'confirmed' }));
    expect(s.status('01-goal')).toBe('done');
  });

  it('goal-met shape is strict: decision must be \'met\', feedback a string, no unknown fields', () => {
    writeNode('01-goal', {}, [ev('created'), ev('completed')]);
    const s = new Store(root);
    const bad = (extra: Record<string, unknown>) => () => s.appendEvent(s.resolveNode('01-goal'), ev('goal-met', extra));
    expect(bad({ decision: 'no' })).toThrow(/goal-met.decision must be 'met'/);
    expect(bad({})).toThrow(/goal-met.decision must be 'met'/);
    expect(bad({ decision: 'met', feedback: 42 })).toThrow(/goal-met.feedback must be a string/);
    expect(bad({ decision: 'met', bogus: 1 })).toThrow(/unknown field/);
    expect(bad({ decision: 'met', feedback: 'ok' })).not.toThrow();
  });

  it('seedGoal writes goal.md + a node.json generated 1:1 from the doc + the seed events', () => {
    const r = new Store(root).seedGoal(DOC);
    expect(r.id).toBe('01-goal');
    expect(r.contract).toEqual({ intent: 'Build the goal session', acceptanceCriteria: ['goal.md locks on the goal root', 'a met verdict seals exhaustion'] });
    const node = JSON.parse(readFileSync(join(nodeDir('01-goal'), 'node.json'), 'utf8'));
    expect(node.contract).toEqual(r.contract); // node.json mirrors the doc
    expect(existsSync(join(nodeDir('01-goal'), 'artifacts', 'goal.md'))).toBe(true);
    const s = new Store(root);
    expect(s.goalLegId()).toBe('01-goal'); // the seed designates the goal
    expect(s.status('01-goal')).toBe('done');
    expect(s.events('01-goal').map((e) => e.type)).toEqual(['created', 'completed']);
  });

  it('seedGoal refuses a non-empty journey — a goal seeds the first leg of an EMPTY session', () => {
    const s = new Store(root);
    s.seedGoal(DOC);
    expect(() => s.seedGoal(DOC)).toThrow(/not empty/); // nodes nonempty
  });

  it('seedGoal refuses a doc missing the fixed Goal:/Success criteria: sections', () => {
    expect(() => new Store(root).seedGoal('# No structure here')).toThrow(/Goal/);
    expect(() => new Store(root).seedGoal('# Goal\n\nGoal: x\n\nSuccess criteria:\n')).toThrow(/bullet/);
  });

  it('a spawned CHILDLESS leg records a ledger eventsContent of \'\' with no events.jsonl — verify reads it clean (ledger guard: missing file ≡ empty log)', () => {
    const s = new Store(root);
    s.spawn('01-leg', CONTRACT); // leg root: node.json only, ledger eventsContent ''
    expect(existsSync(join(nodeDir('01-leg'), 'events.jsonl'))).toBe(false);
    expect(new Store(root).verify().filter((d) => d.startsWith('store-external:'))).toEqual([]);
    // and a task spawned under it writes cleanly (no null-vs-\'\' mismatch on the sibling entry)
    new Store(root).spawn('01-leg/01-a', CONTRACT);
    expect(new Store(root).verify().filter((d) => d.startsWith('store-external:'))).toEqual([]);
  });

  it('archiveJourney moves legs + the ledger to .ann/archive/sessions/<ts>-<slug>/journey and resets the live store', () => {
    const s = new Store(root);
    s.seedGoal(DOC);
    s.spawn('02-work', CONTRACT);
    s.spawn('02-work/01-a', CONTRACT);
    s.appendEvent(s.resolveNode('01-goal'), ev('goal-met', { decision: 'met' }));
    expect(existsSync(join(root, '.ann', 'journey', '.ledger.json'))).toBe(true);
    const r = s.archiveJourney('goal');
    expect(existsSync(join(r.dest, 'legs', '01-goal', 'node.json'))).toBe(true);
    expect(existsSync(join(r.dest, 'legs', '01-goal', 'events.jsonl'))).toBe(true);
    expect(existsSync(join(r.dest, 'legs', '02-work', '01-a', 'node.json'))).toBe(true);
    expect(existsSync(join(r.dest, '.ledger.json'))).toBe(true);
    expect(existsSync(join(root, '.ann', 'journey', '.ledger.json'))).toBe(false); // live ledger removed
    expect(new Store(root).ids()).toEqual([]); // live tree reset — id reuse across sessions is safe
    // the archived snapshot round-trips Store() through a read-only .ann/journey symlink mount
    const mount = mkdtempSync(join(tmpdir(), 'ann-arch-'));
    mkdirSync(join(mount, '.ann'), { recursive: true });
    symlinkSync(r.dest, join(mount, '.ann', 'journey'), 'dir');
    const loaded = new Store(mount);
    expect(loaded.ids().sort()).toEqual(['01-goal', '02-work', '02-work/01-a']);
    expect(loaded.goalLegId()).toBe('01-goal');
    expect(loaded.events('01-goal').some((e) => e.type === 'goal-met')).toBe(true);
    rmSync(mount, { recursive: true, force: true });
  });
});
