import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Store,
  StoreLocationError,
  StoreReadonlyError,
  resolveStoreLocation,
  storeJourneyDir,
} from '../store.js';
import { blobSha } from '../sha.js';
import { Commands } from '../../commands/index.js';

// ── ANN_STORE session-addressing (the same commands read ANY journey) ──────────────
// These unit tests cover the STORE-side contract: the resolver normalizes the three
// target shapes, the constructor derives legs/ledger from the journey root and fails
// closed (named) on a missing store, a read-only store refuses writes with the NAMED
// StoreReadonlyError, and a 'journey'-kind store remaps recorded artifact paths into
// its own legs/ while never attempting a docs-manifest read. CLI wiring (ANN_STORE at
// process start, the read-only chokepoint, exit codes) lives in session-read.e2e.test.

/** Write one node's immutable record + optional events under a journey legs root. */
function node(legs: string, id: string, contract: unknown, events: Array<Record<string, unknown>> = []) {
  const dir = join(legs, id);
  mkdirSync(dir, { recursive: true });
  const nodeJson = JSON.stringify({ id, contract, createdAt: '2026-08-19' });
  writeFileSync(join(dir, 'node.json'), nodeJson);
  let eventsContent = '';
  if (events.length) {
    eventsContent = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(dir, 'events.jsonl'), eventsContent);
  }
  return { nodeJson, eventsContent };
}

/** A faithful archived-session store: a temp dir with bare `journey/{legs, .ledger.json}`
 *  — the shape `goal! archive` round-trips. The goal leg is met; a leg has a structured
 *  artifact lock (current 'alpha-spec') and a legacy-PROSE lock (current 'beta-note');
 *  recorded artifact paths read `.ann/journey/…`-style anchors while the FILES live under
 *  the journey's own `legs/…` — exactly the remap readers must apply. */
function archivedJourney(): { group: string; journey: string } {
  const group = mkdtempSync(join(tmpdir(), 'ann-arch-'));
  const journey = join(group, 'journey');
  const legs = join(journey, 'legs');
  const today = '2026-08-19';
  const entries: Record<string, { nodeJson: string; eventsContent: string }> = {};

  // 01-goal — the seeded, MET goal leg (childless; created+completed+goal-met).
  const goal = node(legs, '01-goal', {
    intent: 'A testable archived session',
    acceptanceCriteria: ['reads resolve through the legacy current() path'],
  }, [
    { at: today, type: 'created', note: 'goal seeded' },
    { at: today, type: 'completed', note: 'goal grilled' },
    { at: today, type: 'goal-met', decision: 'met', note: 'goal met (test)' },
  ]);
  entries['01-goal'] = goal;

  // 02-leg/01-produce — a completed task locking 'alpha-spec' (structured, recorded
  // path in the pre-journey `tree/rounds/…` anchor).
  const alpha = node(legs, '02-leg/01-produce', {
    intent: 'produce the alpha spec',
    acceptanceCriteria: ['alpha-spec.md is written'],
  }, [
    { at: today, type: 'created', note: 'spawned' },
    { at: today, type: 'activated', note: 'work started' },
    { at: today, type: 'submitted', gate: 'grill', note: 'grill' },
    { at: today, type: 'confirmed', gate: 'grill', note: 'ok' },
    {
      at: today,
      type: 'artifact-locked',
      artifact: { name: 'alpha-spec', path: 'tree/rounds/02-leg/01-produce/artifacts/alpha-spec.md', lockSha: '1234567' },
      note: 'alpha-spec.md specs-locked',
    },
    { at: today, type: 'completed', note: 'done' },
  ]);
  entries['02-leg/01-produce'] = alpha;
  const artifactDir = join(legs, '02-leg', '01-produce', 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'alpha-spec.md'), '# Alpha Spec\n\nbody of the alpha spec\n');

  // 02-leg/02-prose — a completed task whose lock is legacy PROSE (no structured
  // artifact): the logical name + filename come from the note.
  const beta = node(legs, '02-leg/02-prose', {
    intent: 'write the beta note',
    acceptanceCriteria: ['beta-note.md is written'],
  }, [
    { at: today, type: 'created', note: 'spawned' },
    { at: today, type: 'artifact-locked', note: 'logical name: beta-note; beta-note.md specs-locked' },
    { at: today, type: 'completed', note: 'done' },
  ]);
  entries['02-leg/02-prose'] = beta;
  mkdirSync(join(legs, '02-leg', '02-prose', 'artifacts'), { recursive: true });
  writeFileSync(join(legs, '02-leg', '02-prose', 'artifacts', 'beta-note.md'), '# Beta Note\n\nbody of the beta note\n');

  // 02-leg root — leg roots carry node.json only (no events).
  entries['02-leg'] = node(legs, '02-leg', { intent: 'the second leg', acceptanceCriteria: [] });

  // The write-rev ledger — byte-accurate to the files above (so `verify` reads clean).
  let rev = 0;
  const nodes: Record<string, unknown> = {};
  for (const [id, { nodeJson, eventsContent }] of Object.entries(entries)) {
    rev += 1;
    nodes[id] = {
      eventsContent,
      nodeContent: nodeJson,
      eventsSha: blobSha(eventsContent),
      nodeSha: blobSha(nodeJson),
      lastEventAt: eventsContent ? JSON.parse(eventsContent.trim().split('\n').pop() ?? '{}').at ?? '' : '',
      lastRev: rev,
    };
  }
  writeFileSync(join(journey, '.ledger.json'), JSON.stringify({ rev, bootstrappedAt: today, nodes }, null, 2) + '\n');
  return { group, journey };
}

describe('ANN_STORE — resolveStoreLocation (the resolver, three shapes)', () => {
  it('normalizes a project root → {kind:project, root} (journey at <root>/.ann/journey)', () => {
    const t = mkdtempSync(join(tmpdir(), 'ann-proj-'));
    mkdirSync(join(t, '.ann', 'journey', 'legs'), { recursive: true });
    // a project root where `journey` is a SYMLINK onto .ann/journey must read as a
    // PROJECT (checked first) — never as a legacy journey root.
    symlinkSync('.ann/journey', join(t, 'journey'));
    expect(resolveStoreLocation(t)).toEqual({ kind: 'project', root: t });
    expect(storeJourneyDir(resolveStoreLocation(t))).toBe(join(t, '.ann', 'journey'));
    rmSync(t, { recursive: true, force: true });
  });

  it('normalizes a group root (has journey/legs) → {kind:journey, root:<p>/journey}', () => {
    const g = mkdtempSync(join(tmpdir(), 'ann-grp-'));
    mkdirSync(join(g, 'journey', 'legs'), { recursive: true });
    expect(resolveStoreLocation(g)).toEqual({ kind: 'journey', root: join(g, 'journey') });
    expect(storeJourneyDir(resolveStoreLocation(g))).toBe(join(g, 'journey'));
    rmSync(g, { recursive: true, force: true });
  });

  it('normalizes a journey dir (has legs/ directly) → {kind:journey, root:<p>}', () => {
    const { group, journey } = archivedJourney();
    expect(resolveStoreLocation(journey)).toEqual({ kind: 'journey', root: journey });
    expect(resolveStoreLocation(group)).toEqual({ kind: 'journey', root: journey });
    rmSync(group, { recursive: true, force: true });
  });

  it('throws the NAMED StoreLocationError for a bad/missing target', () => {
    try {
      resolveStoreLocation(join(tmpdir(), 'ann-nope-missing'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreLocationError);
      expect((e as Error).name).toBe('StoreLocationError');
    }
    // a dir that exists but has no legs/ journey store
    const t = mkdtempSync(join(tmpdir(), 'ann-empty-'));
    expect(() => resolveStoreLocation(t)).toThrow(StoreLocationError);
    rmSync(t, { recursive: true, force: true });
  });
});

describe('ANN_STORE — Store construction (fail-closed, named)', () => {
  it('constructs over all three normalized shapes and reads the same journey', () => {
    const { group, journey } = archivedJourney();
    const a = new Store(journey); // journey dir → journey root
    const b = new Store(group);   // group root → <root>/journey → same journey root
    expect(a.kind).toBe('journey');
    expect(b.kind).toBe('journey');
    expect(b.legs).toBe(a.legs);
    expect(a.status('01-goal')).toBe('done');
    expect(b.ids().sort()).toEqual(['01-goal', '02-leg', '02-leg/01-produce', '02-leg/02-prose']);
    rmSync(group, { recursive: true, force: true });
  });

  it('derives legs/ledger from the journey root for a PROJECT-kind store (unchanged active behavior)', () => {
    const t = mkdtempSync(join(tmpdir(), 'ann-proj-'));
    mkdirSync(join(t, '.ann', 'journey', 'legs'), { recursive: true });
    const s = new Store(t);
    expect(s.kind).toBe('project');
    expect(s.legs).toBe(join(t, '.ann', 'journey', 'legs'));
    expect(storeJourneyDir({ kind: s.kind, root: s.root })).toBe(join(t, '.ann', 'journey'));
    rmSync(t, { recursive: true, force: true });
  });

  it('fails CLOSED with the NAMED error when the store dir is missing (not a raw ENOENT)', () => {
    // an object location bypasses the resolver — the constructor's own legs guard fires
    const t = mkdtempSync(join(tmpdir(), 'ann-nolegs-'));
    mkdirSync(join(t, '.ann'), { recursive: true }); // .ann exists, but no .ann/journey/legs
    expect(() => new Store({ kind: 'project', root: t })).toThrow(StoreLocationError);
    rmSync(t, { recursive: true, force: true });
  });

  it('direct-construction with a non-normalizing string throws the NAMED error', () => {
    expect(() => new Store(join(tmpdir(), 'ann-bad-xyz'))).toThrow(StoreLocationError);
  });
});

describe('ANN_STORE — read-only store (layer b: the Store guard)', () => {
  it('constructing read-only makes every WRITE method throw the NAMED StoreReadonlyError', () => {
    const { group } = archivedJourney();
    const ro = new Store(group, { readOnly: true }); // group root → the archive's journey root
    expect(() => ro.appendEvent(ro.resolveNode('02-leg/01-produce'), { at: '2026-08-19', type: 'completed' })).toThrow(StoreReadonlyError);
    expect(() => ro.spawn('03-leg', { intent: 'x', acceptanceCriteria: ['y'] })).toThrow(StoreReadonlyError);
    expect(() => ro.seedGoal('# Goal\n\n- a\n')).toThrow(StoreReadonlyError);
    expect(() => ro.reseedGoal('# Goal\n\n- a\n')).toThrow(StoreReadonlyError);
    expect(() => ro.archiveJourney('slug')).toThrow(StoreReadonlyError);
    rmSync(group, { recursive: true, force: true });
  });

  it('read methods stay available on a read-only store', () => {
    const { group } = archivedJourney();
    const ro = new Store(group, { readOnly: true });
    expect(ro.status('02-leg/01-produce')).toBe('done');
    expect(ro.ids()).toHaveLength(4);
    rmSync(group, { recursive: true, force: true });
  });

  it('verify() reads clean on an archived journey (the ledger travels with the session)', () => {
    const { group } = archivedJourney();
    const ro = new Store(group, { readOnly: true });
    expect(ro.verify()).toEqual([]);
    rmSync(group, { recursive: true, force: true });
  });
});

describe('ANN_STORE — resolution rule + path remap under a journey root', () => {
  it('current()/detail() remap recorded artifact paths INTO the journey root (strip the .ann/journey anchor)', () => {
    const { group } = archivedJourney();
    const s = new Store(group); // journey root
    const cur = s.current('alpha-spec');
    expect(cur).toBeDefined();
    // recorded `tree/rounds/…` → project `.ann/journey/…` → JOURNEY-relative `legs/…`
    expect(cur!.path).toBe('legs/02-leg/01-produce/artifacts/alpha-spec.md');
    expect(existsSync(join(group, 'journey', cur!.path))).toBe(true);
    // legacy PROSE lock resolves too
    expect(s.current('beta-note')!.path).toBe('legs/02-leg/02-prose/artifacts/beta-note.md');
    // detail() artifact paths remap identically
    const d = s.detail('02-leg/01-produce');
    expect(d.artifacts.map((a) => a.path)).toEqual(['legs/02-leg/01-produce/artifacts/alpha-spec.md']);
    rmSync(group, { recursive: true, force: true });
  });

  it('a journey-kind store NEVER attempts a docs-manifest read (resolveDoc = undefined)', () => {
    const { group } = archivedJourney();
    const s = new Store(group);
    expect(s.resolveDoc('alpha-spec')).toBeUndefined();
    expect(s.resolveDoc('goal')).toBeUndefined();
    // the same names still resolve through the legacy reader
    expect(s.current('alpha-spec')).toBeDefined();
    rmSync(group, { recursive: true, force: true });
  });

  it('a project-kind store resolves through ITS docs manifest (manifest-forward)', () => {
    const p = mkdtempSync(join(tmpdir(), 'ann-docproj-'));
    mkdirSync(join(p, '.ann', 'journey', 'legs', '01-goal'), { recursive: true });
    writeFileSync(join(p, '.ann', 'journey', 'legs', '01-goal', 'node.json'), JSON.stringify({ id: '01-goal', contract: { intent: 'x', acceptanceCriteria: ['y'] }, createdAt: '2026-08-19' }));
    mkdirSync(join(p, 'docs'), { recursive: true });
    writeFileSync(join(p, 'docs', 'foo.md'), '# Foo\n\nthe foo doc\n');
    writeFileSync(join(p, 'docs', 'manifest.json'), JSON.stringify({ foo: 'docs/foo.md' }));
    const s = new Store(p);
    const doc = s.resolveDoc('foo');
    expect(doc).toEqual({ name: 'foo', path: 'docs/foo.md', sha: s.resolveDoc('foo')!.sha });
    expect(existsSync(join(p, doc!.path))).toBe(true);
    rmSync(p, { recursive: true, force: true });
  });

  it('reads (Commands) work over an archived journey: read/goal/statuses/results/detail', () => {
    const { group } = archivedJourney();
    const ro = new Store(group, { readOnly: true });
    const c = new Commands(ro, 'test');
    // read <name> — via the LEGACY current() path, remapped into the archive legs
    const alpha = c.read('alpha-spec');
    if (!alpha.ok) throw new Error(alpha.error.blocker);
    expect(alpha.value.content).toContain('body of the alpha spec');
    // goal view — present, met (goalDoc absent: the archive has no docs/ home)
    const goal = c.goal();
    expect(goal.ok && goal.value.present).toBe(true);
    if (goal.ok) {
      expect(goal.value.goalStatus).toBe('done');
      expect(goal.value.verdict).toBe('met');
      expect(goal.value.goalDoc).toBeUndefined();
    }
    // statuses / detail / results reads
    expect(c.statuses().map((r) => r.id).sort()).toEqual(['01-goal', '02-leg', '02-leg/01-produce', '02-leg/02-prose']);
    expect(c.status('02-leg/01-produce')).toBe('done');
    expect(c.detail('02-leg/01-produce').gates.grill.state).toBe('accepted');
    rmSync(group, { recursive: true, force: true });
  });
});
