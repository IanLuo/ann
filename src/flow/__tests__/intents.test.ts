import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands, CommandResult } from '../../commands/index.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';
import { IntentTranslator } from '../intents.js';
import { Intent, ProposeSpawnIntent, StageDocIntent, Step, StepOutput } from '../types.js';

/**
 * INTENT TRANSLATION (core-design §3) — *docs are git content, events are acceptance.*
 * These tests pin DOCS-AS-GIT: a `stage-doc` writes docs/<name>.md IMMEDIATELY at the
 * repo's docs/ home — no event, no task-local artifacts/ file, no `artifact-locked`
 * (and thus nothing to supersede). `propose-spawn` defers to commit, so a child's
 * requiredInputs resolve through the docs manifest because the staged doc is already
 * on disk. `evidence` + `close` are immediate and idempotent on replay; the commit
 * record is `{ spawned }` only. The translator REFUSES an intent the step did not
 * declare in produces?[] (absence = produces NOTHING).
 */

let root: string;
const TASK = '01-leg/01-a';
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };

const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);

const node = (id: string, contract: unknown, events: Array<Record<string, unknown>> = []) => {
  const dir = nodeDir(id);
  mkdirSync(dir, { recursive: true });
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

/** The git-home file a staged doc lives at — <store root>/docs/<name>.md. */
const docFile = (name: string) => join(root, 'docs', `${name}.md`);
/** The operator's post-commit regen (`ann docs --write`) — the manifest is DERIVED from
 *  scanDocsDir, so a staged doc on disk becomes manifest-served (resolveDoc/F-AC19). */
const regenDocs = () => writeDocsManifest(root, scanDocsDir(root));

const stageDoc = (name: string, content: string): StageDocIntent => ({ kind: 'stage-doc', name, content });
const proposeSpawn = (id: string, contract: unknown): ProposeSpawnIntent => ({ kind: 'propose-spawn', id, contract });

const must = <T>(r: CommandResult<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.blocker}`);
  return r.value;
};
const errorOf = <T>(r: CommandResult<T>) => {
  if (r.ok) throw new Error('expected a refusal, got success');
  return r.error;
};

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the translator refuses what the step did not declare', () => {
  it('an intent absent from produces[] is REFUSED — the declaration cannot drift from execute', () => {
    const t = new IntentTranslator(setup(), TASK);
    const e = errorOf(t.translate(step(['evidence']), [stageDoc('x', '# x\n')]));
    expect(e.code).toBe('undeclared-intent');
    expect(e.blocker).toContain('produces[]');
  });

  it('an ABSENT produces[] means it produces NOTHING', () => {
    const t = new IntentTranslator(setup(), TASK);
    expect(errorOf(t.translate(step(undefined), [{ kind: 'evidence', note: 'x' }])).code).toBe('undeclared-intent');
  });
});

describe('stage-doc — the doc file NOW at the repo git docs/ home', () => {
  it('writes docs/<name>.md immediately, records it on deferred.docs, and appends NO event', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    const before = c.events(TASK).length;
    must(t.translate(step(['stage-doc']), [stageDoc('my-spec', '# body\n')]));
    expect(readFileSync(docFile('my-spec'), 'utf8')).toBe('# body\n'); // the file is REAL now
    expect(t.deferred.docs).toEqual([{ name: 'my-spec', path: 'docs/my-spec.md' }]);
    expect(c.events(TASK)).toHaveLength(before); // no event appended
    // docs are git content: no task artifacts/ file, no artifact-locked event — ever
    expect(existsSync(join(nodeDir(TASK), 'artifacts'))).toBe(false);
    expect(c.events(TASK).some((e) => e.type === 'artifact-locked' || e.type === 'superseded')).toBe(false);
    expect(c.store.current('my-spec')).toBeUndefined();
  });

  it('is idempotent by bytes on replay — re-declaring the same doc records one deferred entry', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    const s = step(['stage-doc']);
    must(t.translate(s, [stageDoc('my-spec', '# body\n')]));
    const bytes = readFileSync(docFile('my-spec'), 'utf8');
    must(t.translate(s, [stageDoc('my-spec', '# body\n')])); // replay from the transcript
    expect(readFileSync(docFile('my-spec'), 'utf8')).toBe(bytes);
    expect(t.deferred.docs).toEqual([{ name: 'my-spec', path: 'docs/my-spec.md' }]);
    expect(c.events(TASK).map((e) => e.type)).toEqual(['created']);
  });

  it('a REWORK re-writes the same file fresh — still no event, no lock to supersede', () => {
    const c = setup();
    const first = new IntentTranslator(c, TASK);
    must(first.translate(step(['stage-doc']), [stageDoc('my-spec', '# draft\n')]));
    const rework = new IntentTranslator(c, TASK);
    must(rework.translate(step(['stage-doc']), [stageDoc('my-spec', '# revised\n')]));
    expect(readFileSync(docFile('my-spec'), 'utf8')).toBe('# revised\n');
    expect(c.events(TASK).some((e) => e.type === 'artifact-locked' || e.type === 'superseded')).toBe(false);
  });
});

describe('stage-doc name — a safe file stem under docs/', () => {
  it('refuses a name that would not make a safe top-level docs/ file stem', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    const s = step(['stage-doc']);
    for (const bad of ['../escape', 'a/b', 'my doc', '.hidden', '-dash', '']) {
      const e = errorOf(t.translate(s, [stageDoc(bad, '# x\n')]));
      expect(e.code).toBe('stage-doc-name');
      expect(e.blocker).toContain('safe file stem');
    }
    expect(existsSync(join(root, 'docs'))).toBe(false); // refused before any write
  });
});

describe('commit() — the deferred propose-spawn records here (docs were staged immediately)', () => {
  it('returns { spawned } only; doc-before-spawn holds BY CONSTRUCTION so requiredInputs resolve', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    must(
      t.translate(step(['stage-doc', 'propose-spawn']), [
        stageDoc('my-spec', '# body\n'),
        proposeSpawn('01-leg/02-b', { intent: 'consume it', acceptanceCriteria: ['x'], requiredInputs: ['my-spec'] }),
      ]),
    );
    expect(c.ids()).not.toContain('01-leg/02-b'); // nothing spawned at translate
    // the operator commits docs/my-spec.md + refreshes the manifest (the two-phase) —
    // the staged doc is ALREADY on disk, so the child's requiredInput resolves
    regenDocs();
    mkdirSync(nodeDir('01-leg/02-b'), { recursive: true }); // spawn writes node.json into the node's folder
    const r = must(t.commit());
    expect(Object.keys(r)).toEqual(['spawned']); // no locks[], no other record
    expect(r.spawned).toEqual(['01-leg/02-b']);
    expect(c.status('01-leg/02-b')).toBe('queued');
  });

  it('is idempotent — a re-commit does not double-spawn', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['propose-spawn']), [proposeSpawn('01-leg/02-b', CONTRACT)]));
    mkdirSync(nodeDir('01-leg/02-b'), { recursive: true }); // spawn writes node.json into the node's folder
    expect(must(t.commit())).toEqual({ spawned: ['01-leg/02-b'] });
    expect(must(t.commit())).toEqual({ spawned: [] }); // already exists — no-op
    expect(c.ids().filter((i) => i === '01-leg/02-b')).toHaveLength(1);
    expect(c.status('01-leg/02-b')).toBe('queued');
  });

  it('refuses a depth-3 child — it would be invisible to frontmostReady/tasksOf', () => {
    const t = new IntentTranslator(setup(), TASK);
    const e = errorOf(t.translate(step(['propose-spawn']), [proposeSpawn('01-leg/01-a/01-kid', CONTRACT)]));
    expect(e.code).toBe('spawn-depth');
  });

  it('no-ops when the id already exists', () => {
    setup();
    node('01-leg/02-b', CONTRACT, [ev('created')]);
    const c = new Commands(new Store(root), 'test');
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['propose-spawn']), [proposeSpawn('01-leg/02-b', CONTRACT)]));
    expect(t.deferred.spawns).toEqual([]);
    expect(must(t.commit())).toEqual({ spawned: [] });
  });
});

describe('evidence + close — immediate, idempotent on replay', () => {
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

  it('the append path the translator uses accepts evidence carrying commits[] (F-AC18 conclusion)', () => {
    const c = setup();
    const t = new IntentTranslator(c, TASK);
    must(t.translate(step(['evidence']), [{ kind: 'evidence', note: 'the spec is drafted' }]));
    // the operator's conclusion record — evidence.commits[] is a lawful append, never
    // refused the way the RETIRED artifact kinds are; a later replay dedups on it
    const r = c.append(TASK, { at: '2026-08-27', type: 'evidence', note: 'committed the staged doc', commits: [{ sha: 'deadbee', note: 'spec' }] });
    expect(r.ok).toBe(true);
    must(t.translate(step(['evidence']), [{ kind: 'evidence', note: 'committed the staged doc' }])); // replay — dedup on the note
    const evidenceEvents = c.events(TASK).filter((e) => e.type === 'evidence');
    expect(evidenceEvents).toHaveLength(2);
    expect(evidenceEvents[1].commits).toEqual([{ sha: 'deadbee', note: 'spec' }]);
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
});

describe('commands.append refuses the retired + composite-owned kinds', () => {
  it('refuses the RETIRED doc-artifact kinds with retired-kind', () => {
    const c = setup();
    const locked = errorOf(c.append(TASK, { at: '2026-08-27', type: 'artifact-locked', note: 'seal', artifact: { name: 'x', path: 'a/x.md', lockSha: 'abc' } }));
    expect(locked.code).toBe('retired-kind');
    const superseded = errorOf(c.append(TASK, { at: '2026-08-27', type: 'superseded', note: 'old' }));
    expect(superseded.code).toBe('retired-kind');
    expect(c.events(TASK)).toHaveLength(1); // nothing landed
  });

  it('refuses the COMPOSITE-owned kinds with composite-owned', () => {
    const c = setup();
    for (const type of ['created', 'submitted', 'confirmed', 'rejected', 'goal-met']) {
      const e = errorOf(c.append(TASK, { at: '2026-08-27', type }));
      expect(e.code).toBe('composite-owned');
    }
    expect(c.events(TASK)).toHaveLength(1); // nothing landed
  });
});
