import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { VOCAB } from '../vocab.js';

// Fixture helper: a disposable journey store in a temp dir.
let root: string;
function makeStore() {
  root = mkdtempSync(join(tmpdir(), 'ann-store-'));
  mkdirSync(join(root, 'journey', 'legs'), { recursive: true });
  return root;
}
function legDir(leg: string) { return join(root, 'journey', 'legs', leg); }
function nodeDir(id: string) { return join(root, 'journey', 'legs', id); }
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
    expect(s.current('spec')?.path).toBe('journey/legs/01-goal/01-a/artifacts/spec-v3.md');
  });

  it('derives the logical name from the filename when the note has no marker (third fallback)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('artifact-locked', { note: 'functional-spec-v3.md specs-locked — no marker here' })]);
    const s = new Store(root);
    expect(s.current('functional-spec')?.producer).toBe('01-goal/01-a');
  });

  it('normalizes legacy tree/rounds/ recorded paths to journey/legs/ (no symlinks needed)', () => {
    const legacy = join(root, 'journey', 'legs', '01-goal');
    mkdirSync(join(legacy, 'artifacts'), { recursive: true });
    writeFileSync(join(legacy, 'artifacts', 'design.md'), 'body');
    writeNode('01-goal', {}, [ev('created'), ev('artifact-locked', { artifact: { name: 'design', path: 'tree/rounds/01-goal/artifacts/design.md', lockSha: 'a' } })]);
    const s = new Store(root);
    expect(s.current('design')?.path).toBe('journey/legs/01-goal/artifacts/design.md');
    expect(s.check()).toEqual([]); // no MISSING — the legacy path resolves
  });

  it('normalizes legacy /00/ recorded paths (the flatten, v8)', () => {
    const dir = join(root, 'journey', 'legs', '01-goal', '01-a');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'spec.md'), 'body');
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('artifact-locked', { artifact: { name: 'spec', path: 'journey/legs/01-goal/00/01-a/artifacts/spec.md', lockSha: 'a' } })]);
    const s = new Store(root);
    expect(s.current('spec')?.path).toBe('journey/legs/01-goal/01-a/artifacts/spec.md');
    expect(s.check()).toEqual([]); // no MISSING — the /00/ path resolves
  });
});

describe('Store — appendEvent, the single writer (LB-3)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('rejects an unknown event type (vocab registry)', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent('01-goal/01-a', ev('bogus-type'))).toThrow(/known type|vocab/);
  });

  it('rejects an event without at', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent('01-goal/01-a', { type: 'extended' } as never)).toThrow(/at/);
  });

  it('appends a valid event (tasks only — leg roots carry no events)', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    s.appendEvent('01-goal/01-a', ev('extended'));
    expect(s.events('01-goal/01-a').map((e) => e.type)).toEqual(['created', 'extended']);
  });

  it('enforces GATE-1: produced work requires confirmed(gate=grill) before it', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    expect(() => s.appendEvent('01-goal/01-a', ev('artifact-locked', { artifact: { name: 'x', path: 'x.md', lockSha: 'a' } }))).toThrow(/grill/);
  });

  it('enforces GATE-2: completed requires confirmed(gate=confirm)', () => {
    writeNode('01-goal/01-a', {}, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    const s = new Store(root);
    expect(() => s.appendEvent('01-goal/01-a', ev('completed'))).toThrow(/confirm/);
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
    expect(s.check().some((p) => p.includes('GATE-SEQ'))).toBe(true);
    writeNode('01-goal/01-a', {}, [
      ev('created'),
      ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }),
      ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }),
    ]);
    expect(new Store(root).check().some((p) => p.includes('GATE-SEQ'))).toBe(false);
  });

  it('the full honest sequence appends cleanly', () => {
    writeNode('01-goal/01-a', {}, [ev('created')]);
    const s = new Store(root);
    s.appendEvent('01-goal/01-a', ev('submitted', { gate: 'grill' }));
    s.appendEvent('01-goal/01-a', ev('confirmed', { gate: 'grill' }));
    s.appendEvent('01-goal/01-a', ev('artifact-locked', { artifact: { name: 'x', path: 'x.md', lockSha: 'a' } }));
    s.appendEvent('01-goal/01-a', ev('submitted', { gate: 'confirm' }));
    s.appendEvent('01-goal/01-a', ev('confirmed', { gate: 'confirm' }));
    s.appendEvent('01-goal/01-a', ev('completed'));
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
    const problems = s.check();
    expect(problems.filter((p) => p.includes('GATE-2'))).toHaveLength(1); // 01-a completed without confirm gate
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

describe('Store — spawn (creation record + created event through the single writer)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes node.json + the created event via appendEvent (tasks)', () => {
    const s = new Store(root);
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(existsSync(join(root, 'journey', 'legs', '01-goal', '01-a', 'node.json'))).toBe(true);
    expect(s.events('01-goal/01-a').map((e) => e.type)).toEqual(['created']);
    expect(s.status('01-goal/01-a')).toBe('queued');
  });

  it('spawning a leg writes NO events at all (v8 §13 — leg roots have no log)', () => {
    const s = new Store(root);
    s.spawn('07-new-leg', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(existsSync(join(root, 'journey', 'legs', '07-new-leg', 'events.jsonl'))).toBe(false);
    expect(s.events('07-new-leg')).toEqual([]);
  });

  it('appendEvent refuses events on leg roots (write path = the enforcement)', () => {
    const s = new Store(root);
    s.spawn('07-new-leg', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(() => s.appendEvent('07-new-leg', ev('completed'))).toThrow(/leg roots carry no events/);
  });

  it('rejects a re-spawn (immutable id)', () => {
    const s = new Store(root);
    s.spawn('01-goal/01-a', { contract: { intent: 'x', acceptanceCriteria: ['a'] } });
    expect(() => new Store(root).spawn('01-goal/01-a', {})).toThrow();
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
    expect(VOCAB.eventTypes).toContain('artifact-locked');
    expect(VOCAB.gates).toEqual(['grill', 'confirm']);
    expect(VOCAB.artifactTypes).toContain('spec');
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
});
