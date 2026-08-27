import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands, CommandResult } from '../../commands/index.js';
import { blobSha, stripMarkers } from '../../store/sha.js';
import { IntentTranslator } from '../intents.js';
import { Intent, Step, StepOutput } from '../types.js';

/**
 * INTENT TRANSLATION (core-design §3) — *files are working state, events are acceptance.*
 * These tests pin DEFER-RECORD: the lock file appears immediately, the `artifact-locked`
 * EVENT appears only at commit; a rework re-writes the file and NEVER supersedes a live
 * node; spawns defer beside the locks so lock-before-spawn holds by construction.
 */

let root: string;
const TASK = '01-leg/01-a';
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };

const node = (id: string, contract: unknown, events: Array<Record<string, unknown>> = []) => {
  const dir = join(root, '.ann', 'journey', 'legs', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
};
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

function setup(events = [ev('created')]): Commands {
  root = mkdtempSync(join(tmpdir(), 'ann-intent-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  node('01-leg', {});
  node(TASK, CONTRACT, events);
  return new Commands(new Store(root), 'test');
}

const step = (produces: Step['produces']): Step => ({
  id: 'spec',
  roles: [],
  rules: [],
  produces,
  execute: async (): Promise<StepOutput> => ({ ok: true }),
});

const must = <T>(r: CommandResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.blocker}`);
  return r.value;
};
const errorOf = <T>(r: CommandResult<T>) => {
  if (r.ok) throw new Error('expected a refusal, got success');
  return r.error;
};

const GATED = [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })];
const workingFile = (name: string) => join(root, '.ann', 'journey', 'legs', TASK, 'artifacts', `${name}.md`);
const lockIntent = (name: string, content: string, type = 'spec'): Intent => ({ kind: 'lock-artifact', name, content, type });
/** The lock-time hash, over marker-stripped content — the same bytes the gate binds. */
const shaOf = (content: string): string => blobSha(stripMarkers(content)).slice(0, 7);

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the translator refuses what the step did not declare', () => {
  it('an intent absent from produces[] is REFUSED — the declaration cannot drift from execute', () => {
    const t = new IntentTranslator(setup(), TASK);
    const e = errorOf(t.translate(step(['evidence']), [lockIntent('x', '# x\n')]));
    expect(e.code).toBe('undeclared-intent');
    expect(e.blocker).toContain('produces[]');
  });

  it('an ABSENT produces[] means it produces NOTHING', () => {
    const t = new IntentTranslator(setup(), TASK);
    expect(errorOf(t.translate(step(undefined), [{ kind: 'evidence', note: 'x' }])).code).toBe('undeclared-intent');
  });
});

describe('lock-artifact — DEFER-RECORD (the file now, the event at commit)', () => {
  it('writes the WORKING FILE immediately and records NO event', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['lock-artifact']), [lockIntent('my-spec', '# body\n')]));
    expect(readFileSync(workingFile('my-spec'), 'utf8')).toBe('# body\n');
    expect(c.events(TASK).some((e) => e.type === 'artifact-locked')).toBe(false);
    expect(c.store.current('my-spec')).toBeUndefined();
    expect(t.deferred.locks).toEqual([{ name: 'my-spec', type: 'spec', workingPath: workingFile('my-spec') }]);
  });

  it('a REWORK re-writes the file, still records nothing, and NEVER supersedes a live node', () => {
    const c = setup(GATED);
    const first = new IntentTranslator(c, TASK);
    must(first.translate(step(['lock-artifact']), [lockIntent('my-spec', '# draft\n')]));
    const rework = new IntentTranslator(c, TASK);
    must(rework.translate(step(['lock-artifact']), [lockIntent('my-spec', '# revised\n')]));
    expect(readFileSync(workingFile('my-spec'), 'utf8')).toBe('# revised\n');
    expect(c.events(TASK).some((e) => e.type === 'superseded' || e.type === 'artifact-locked')).toBe(false);
  });

  it('the EVENT lands at commit, and commit is idempotent on replay', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['lock-artifact']), [lockIntent('my-spec', '# body\n')]));
    const r = must(t.commit());
    expect(r.locked.map((l) => l.contentPath)).toEqual(['.ann/docs/specs/my-spec-v1.md']);
    expect(c.store.current('my-spec')?.producer).toBe(TASK);
    expect(must(t.commit()).locked).toEqual([]); // already recorded — no double lock
    expect(c.events(TASK).filter((e) => e.type === 'artifact-locked')).toHaveLength(1);
  });

  it('refuses a lock with neither content nor path', () => {
    const t = new IntentTranslator(setup(GATED), TASK);
    expect(errorOf(t.translate(step(['lock-artifact']), [{ kind: 'lock-artifact', name: 'x' }])).code).toBe('empty-lock');
  });
});

describe('THE GATE②-TO-COMMIT CONTENT BINDING', () => {
  it('commits when the working file still hashes to the sha the confirm gate decided on', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['lock-artifact']), [lockIntent('my-spec', '# body\n')]));
    const sha = must(c.submit(TASK, 'confirm', { confirmedSha: shaOf('# body\n') })).confirmedSha!;
    must(c.gate(TASK, 'confirm', 'accept'));
    expect(must(t.commit({ confirmedSha: sha })).locked).toHaveLength(1);
  });

  it('REFUSES on drift — the artifact changed after the gate', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['lock-artifact']), [lockIntent('my-spec', '# body\n')]));
    const e = errorOf(t.commit({ confirmedSha: 'deadbee' }));
    expect(e.code).toBe('content-drift');
    expect(e.blocker).toContain('commit refuses');
  });
});

describe('propose-spawn — deferred to commit, beside the locks', () => {
  it('defers, then spawns AFTER the locks so requiredInputs resolve through current()', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(
      t.translate(step(['lock-artifact', 'propose-spawn']), [
        lockIntent('my-spec', '# body\n'),
        { kind: 'propose-spawn', id: '01-leg/02-b', contract: { intent: 'consume it', acceptanceCriteria: ['x'], requiredInputs: ['my-spec'] } },
      ]),
    );
    expect(c.ids()).not.toContain('01-leg/02-b'); // nothing spawned yet
    const r = must(t.commit());
    expect(r.spawned).toEqual(['01-leg/02-b']); // and F-AC19 passed because the lock ran first
    expect(c.status('01-leg/02-b')).toBe('queued');
  });

  it('refuses a depth-3 child — it would be invisible to frontmostReady/tasksOf', () => {
    const t = new IntentTranslator(setup(GATED), TASK);
    const e = errorOf(t.translate(step(['propose-spawn']), [{ kind: 'propose-spawn', id: '01-leg/01-a/01-kid', contract: CONTRACT }]));
    expect(e.code).toBe('spawn-depth');
  });

  it('no-ops when the id already exists', () => {
    const c = setup(GATED);
    node('01-leg/02-b', CONTRACT, [ev('created')]);
    const t = new IntentTranslator(new Commands(new Store(root), 'test'), TASK);
    must(t.translate(step(['propose-spawn']), [{ kind: 'propose-spawn', id: '01-leg/02-b', contract: CONTRACT }]));
    expect(t.deferred.spawns).toEqual([]);
  });
});

describe('evidence + close + supersede — immediate, idempotent on replay', () => {
  it('evidence dedups on answers[].id, on refs[], and on a bare note', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    const s = step(['evidence']);
    must(t.translate(s, [{ kind: 'evidence', note: 'a fact' }]));
    must(t.translate(s, [{ kind: 'evidence', note: 'a fact' }]));
    must(t.translate(s, [{ kind: 'evidence', note: 'answered', answers: [{ id: 'Q1', answer: 'yes' }] }]));
    must(t.translate(s, [{ kind: 'evidence', note: 'answered again', answers: [{ id: 'Q1', answer: 'yes' }] }]));
    must(t.translate(s, [{ kind: 'evidence', note: 'ref', refs: ['r1'] }]));
    must(t.translate(s, [{ kind: 'evidence', note: 'ref again', refs: ['r1'] }]));
    expect(c.events(TASK).filter((e) => e.type === 'evidence')).toHaveLength(3);
  });

  it('close validates F-AC16: a transfer must land on a node that exists', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    expect(errorOf(t.translate(step(['close']), [{ kind: 'close', transferred: { target: '01-leg/99-ghost', scope: 'x' } }])).code).toBe('no-target');
    node('01-leg/02-b', CONTRACT, [ev('created')]);
    const c2 = new Commands(new Store(root), 'test');
    const t2 = new IntentTranslator(c2, TASK);
    must(t2.translate(step(['close']), [{ kind: 'close', transferred: { target: '01-leg/02-b', scope: 'the rest' } }]));
    must(t2.translate(step(['close']), [{ kind: 'close', transferred: { target: '01-leg/02-b', scope: 'the rest' } }]));
    expect(c2.events(TASK).filter((e) => e.type === 'transferred')).toHaveLength(1);
  });

  it('close takes exactly one of transferred | deferred | gate-revised', () => {
    const t = new IntentTranslator(setup(), TASK);
    expect(errorOf(t.translate(step(['close']), [{ kind: 'close' }])).code).toBe('close-shape');
  });

  it('supersede REFUSES a live locker — the status collapse would silently kill it', () => {
    const c = setup(GATED);
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['lock-artifact']), [lockIntent('my-spec', '# body\n')]));
    must(t.commit());
    node('01-leg/02-b', CONTRACT, [ev('created')]);
    const c2 = new Commands(new Store(root), 'test');
    const t2 = new IntentTranslator(c2, '01-leg/02-b');
    // the locker (01-leg/01-a) is not done — refused
    const e = errorOf(t2.translate(step(['supersede']), [{ kind: 'supersede', name: 'my-spec', path: '.ann/docs/specs/my-spec-v1.md' }]));
    expect(e.code).toBe('live-locker');
    expect(existsSync(join(root, '.ann', 'docs', 'specs', 'my-spec-v1.md'))).toBe(true);
  });
});

