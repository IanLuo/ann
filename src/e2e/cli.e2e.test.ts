import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, symlinkSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { Store } from '../store/store.js';
import { scanDocsDir, writeDocsManifest } from '../store/docs.js';

/**
 * E2E — the real CLI binary (`node dist/surface/cli.js`) driven as a subprocess
 * against an isolated, git-backed temp project. The unit suite drives Store/Commands
 * in-process; this suite proves the whole binary works the way a user invokes it:
 * argv parsing, the `!` write-marker, id/decision validation, project resolution, and
 * a full task lifecycle ending in a clean `check`.
 *
 * Docs-as-git (Stage B): a task's deliverable is a DOC staged to docs/<name>.md and
 * committed; a task concludes via structured `evidence.commits[]`. The suite mirrors
 * that — gates through the CLI, the doc committed in the temp project, and the
 * conclusion recorded as commit evidence.
 *
 * `npm run build` first (npm pretest does it) — dist/surface/cli.js is what we spawn.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');

/** Hermetic: the default baseUrl falls back to the real OpenAI endpoint. Point it at
 *  127.0.0.1:1 so provider calls refuse the connection instantly instead of leaking out. */
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

interface CliResult { code: number | null; stdout: string; stderr: string; }

function cli(root: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json') },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const out = (r: CliResult) => r.stdout + r.stderr;

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/** A fresh ann project: registry data + the legacy root symlinks, git-backed. */
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  // Mirror the real repo's root view: journey/ rules/ are symlinks onto .ann/.
  // (docs/ is RETIRED in the thin model, leg 07 — no root docs symlink is created.)
  // cmdCheck verifies on-disk hashes via join(ROOT, l.path) — the legacy path resolves through
  // the journey symlink, so the integrity loop runs instead of skipping.
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

/** The docs-as-git store no longer pre-creates a spawned node's folder (outputs are
 *  docs at the repo docs/ home, not per-task artifacts/), so the fixture pre-creates
 *  the folder a `spawn!` will write node.json into. Without it store.spawn's
 *  node.json write would land in a missing directory. */
function prep(root: string, ...ids: string[]): void {
  for (const id of ids) mkdirSync(join(root, '.ann', 'journey', 'legs', id), { recursive: true });
}

const LEG = '01-leg';
const TASK = '01-leg/01-a';
const CONTRACT = (intent: string) => JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`] });
const EVENT = (type: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ at: '2026-08-29', type, ...extra });

describe('e2e — the CLI binary', () => {
  let root: string;
  beforeEach(() => { root = newProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('drives a task through the full lifecycle and check stays clean', () => {
    prep(root, LEG, TASK);
    expect(out(cli(root, ['spawn!', LEG, CONTRACT('the first leg')]))).toContain('spawned 01-leg (leg)');
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('do the thing')]))).toContain('spawned 01-leg/01-a (task)');
    expect(out(cli(root, ['status']))).toContain('queued');

    // provenance: RECORDED_BY lands on the create event
    expect(out(cli(root, ['journey', TASK]))).toContain('e2e');

    // write discipline: a bare write name is refused with a hint
    const bare = cli(root, ['append', TASK, '{}']);
    expect(bare.code).toBe(1);
    expect(out(bare)).toContain("writes are marked with '!'");

    // gate ①: submit alone blocks, the decision releases it
    expect(out(cli(root, ['submit!', TASK, 'grill']))).toContain('submitted grill');
    expect(out(cli(root, ['status', TASK]))).toContain('blocked');
    expect(out(cli(root, ['gate!', TASK, 'grill', 'accept', 'looks right']))).toContain('gate grill: accept');
    expect(out(cli(root, ['status', TASK]))).not.toContain('blocked');

    // the deliverable: a doc staged to docs/<name>.md at the repo docs/ home (docs are
    // git content — a real run! stages it via stage-doc; here we write the bytes), then
    // the generated manifest resolves it
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe actual deliverable\n');
    expect(out(cli(root, ['docs', '--write']))).toContain('regenerated');
    // the doc resolves via the manifest — no per-task artifacts/ file, no docs/-vN symlink
    expect(existsSync(join(root, '.ann', 'journey', 'legs', TASK, 'artifacts', 'thing.md'))).toBe(false);
    expect(out(cli(root, ['read', 'thing']))).toContain('the actual deliverable');

    // commit the staged doc in the temp project (git is the archive); the commit sha is
    // the traceability the conclusion evidence cites (F-AC18)
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'stage the deliverable']);
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(out(cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'evidence', note: 'the thing is committed', commits: [{ sha, note: 'deliverable' }] })]))).toContain('appended');

    // gate ②: confirm is not 'done' on its own — completed event closes it
    expect(out(cli(root, ['submit!', TASK, 'confirm']))).toContain('submitted confirm');
    expect(out(cli(root, ['gate!', TASK, 'confirm', 'accept', 'done']))).toContain('gate confirm: accept');
    expect(out(cli(root, ['status', TASK]))).not.toContain('done');
    expect(out(cli(root, ['append!', TASK, EVENT('completed', { note: 'finished' })]))).toContain('appended');
    expect(out(cli(root, ['status', TASK]))).toContain('done');

    // commit the whole tree so the check's manifest-freshness + traceability read a clean git
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'close 01-leg/01-a']);
    const chk = cli(root, ['check']);
    expect(chk.code).toBe(0);
    expect(out(chk)).toContain('OK — 1 docs in the manifest, no gate gaps.');
    expect(out(chk)).toContain('State: 01-leg done');
  });

  it('cancelled — the task-close terminal, recordable through append! with a REQUIRED reason', () => {
    prep(root, LEG, TASK);
    cli(root, ['spawn!', LEG, CONTRACT('the first leg')]);
    cli(root, ['spawn!', TASK, CONTRACT('do the thing')]);

    // the reason is REQUIRED — a bare / blank cancellation is refused at the single writer
    for (const raw of [EVENT('cancelled'), JSON.stringify({ at: '2026-08-29', type: 'cancelled', reason: '   ' })]) {
      const r = cli(root, ['append!', TASK, raw]);
      expect(r.code).toBe(1);
      expect(out(r)).toContain('cancelled requires a reason');
    }

    // with a reason it records, and the derived status is the terminal word
    expect(out(cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'cancelled', reason: 'the goal shrank — this work is no longer needed' })]))).toContain('appended');
    expect(out(cli(root, ['status', TASK]))).toContain('cancelled');
    // closed-set parity: the cancelled task no longer holds its leg shut
    expect(out(cli(root, ['journey']))).toContain('01-leg done');
    const chk = cli(root, ['check']);
    expect(chk.code).toBe(0);
    expect(out(chk)).toContain('State: 01-leg done');
  });

  it('enforces the write discipline and the gates through the CLI', () => {
    prep(root, LEG, TASK);
    cli(root, ['spawn!', LEG, CONTRACT('l')]);
    cli(root, ['spawn!', TASK, CONTRACT('t')]);

    // duplicate id, bad JSON, bad id, sibling prefix clash — all refused by spawn!
    expect(cli(root, ['spawn!', TASK, CONTRACT('x')]).code).toBe(1);
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('x')]))).toContain('already exists');
    expect(out(cli(root, ['spawn!', '01-leg/01-b', '{nope']))).toContain('bad contract JSON');
    expect(out(cli(root, ['spawn!', '01-leg/9', CONTRACT('x')]))).toContain('id-naming');
    expect(out(cli(root, ['spawn!', '01-leg/01-b', CONTRACT('x')]))).toContain('prefix-clash');

    // a bare write name is refused with a hint — the `!` is a guarantee, not advice
    expect(cli(root, ['submit', TASK, 'grill']).code).toBe(1);
    expect(out(cli(root, ['submit', TASK, 'grill']))).toContain("writes are marked with '!'");

    // a composite-owned event kind cannot be appended around the mutator
    expect(out(cli(root, ['append!', TASK, EVENT('confirmed', { gate: 'grill' })]))).toContain('composite-owned');

    // the RETIRED doc-artifact kinds are refused on the general append (D3)
    expect(out(cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'artifact-locked', artifact: { name: 'x', path: '.ann/journey/legs/01-leg/01-a/artifacts/x.md', lockSha: 'aaaaaaa' } })]))).toContain('retired-kind');
    expect(out(cli(root, ['append!', TASK, EVENT('superseded')]))).toContain('retired-kind');

    // the STORE's gate enforcement through the write surface: a completed without the
    // confirm gate is refused (GATE-2 GAP), never a silent skip
    expect(out(cli(root, ['append!', TASK, EVENT('completed', { note: 'nope' })]))).toContain('GATE-2 GAP');

    // gate! validates its decision vocabulary
    expect(cli(root, ['gate!', TASK, 'grill', 'maybe']).code).toBe(2);
    expect(out(cli(root, ['gate!', TASK, 'grill', 'maybe']))).toContain('usage:');
  });

  it('run! fails closed with no reachable provider', () => {
    prep(root, LEG, '01-leg/02-a');
    cli(root, ['spawn!', LEG, CONTRACT('l')]);
    cli(root, ['spawn!', '01-leg/02-a', CONTRACT('run me')]);

    const run = cli(root, ['run!', '01-leg/02-a']);
    expect(run.code).toBe(1);
    expect(out(run)).toContain('FAILED');
    expect(out(run)).toContain('provider-unavailable');
    expect(out(cli(root, ['status', '01-leg/02-a']))).toContain('failed');
  });

  it('detects a store change made outside the CLI, refuses to write over it, and reasons about it', () => {
    prep(root, LEG, TASK);
    expect(out(cli(root, ['spawn!', LEG, CONTRACT('l')]))).toContain('spawned');
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('do the thing')]))).toContain('spawned');

    // the write-rev ledger read
    expect(out(cli(root, ['ledger']))).toContain('LEDGER rev');
    expect(out(cli(root, ['ledger', '--json']))).toContain('"rev"');
    const before = JSON.parse(cli(root, ['ledger', '--json']).stdout);
    expect(before.rev).toBeGreaterThanOrEqual(2); // leg + task spawns
    expect(before.nodes[TASK]).toBeDefined();

    // a hand edit (another process / a human editor) appends a line to the task's log
    appendFileSync(join(root, '.ann', 'journey', 'legs', TASK, 'events.jsonl'), JSON.stringify({ at: '2026-08-29', type: 'extended', note: 'hand-forged' }) + '\n');

    // write discipline: the CLI REFUSES to build on the unrecognized state
    const append = cli(root, ['append!', TASK, EVENT('extended', { note: 'after' })]);
    expect(append.code).toBe(1);
    expect(out(append)).toContain('store-external edit');
    expect(out(append)).toContain('ann verify');

    // verify: the drift is detected, classified, and localized to the rev ann last wrote
    const v = cli(root, ['verify']);
    expect(v.code).toBe(1);
    expect(out(v)).toContain('store-external:');
    expect(out(v)).toContain('class=append');
    expect(out(v)).toContain('ann wrote rev');
  });
});

describe('e2e — the goal-session lifecycle (v6: seed → docs/goal.md → work → met → archive)', () => {
  let root: string;
  beforeEach(() => { root = newProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const GOAL = '01-goal';
  const WORK = '02-work';
  const TASK = '02-work/01-a';
  /** Hand-seed the goal leg exactly as seedGoal would: node.json (the 1:1 machine
   *  read of the doc), the created+completed seed events, and the authored doc at
   *  docs/goal.md + the regenerated manifest (docs-as-git — no goal-root lock). */
  function seedGoalLeg(r: string): void {
    mkdirSync(join(r, '.ann', 'journey', 'legs', GOAL), { recursive: true });
    writeFileSync(
      join(r, '.ann', 'journey', 'legs', GOAL, 'node.json'),
      JSON.stringify({ id: GOAL, contract: { intent: 'Land the goal session end to end', acceptanceCriteria: ['the seeded goal is realized: docs/goal.md in the manifest', 'a met verdict seals exhaustion'] }, createdAt: '2026-08-29' }, null, 2) + '\n',
    );
    writeFileSync(join(r, '.ann', 'journey', 'legs', GOAL, 'events.jsonl'), [EVENT('created'), EVENT('completed')].join('\n') + '\n');
    const doc = '# Goal\n\nGoal: Land the goal session end to end\n\nSuccess criteria:\n- the seeded goal is realized: docs/goal.md in the manifest\n- a met verdict seals exhaustion\n';
    mkdirSync(join(r, 'docs'), { recursive: true });
    writeFileSync(join(r, 'docs', 'goal.md'), doc);
    writeDocsManifest(r, scanDocsDir(r));
  }
  /** Drive the one task through its gates to done — the session is then exhausted. */
  function driveWorkToDone(r: string): void {
    prep(r, WORK, TASK);
    cli(r, ['spawn!', WORK, CONTRACT('the work leg')]);
    cli(r, ['spawn!', TASK, CONTRACT('do the work')]);
    expect(out(cli(r, ['submit!', TASK, 'grill']))).toContain('submitted grill');
    expect(out(cli(r, ['gate!', TASK, 'grill', 'accept', 'grilled']))).toContain('gate grill: accept');
    expect(out(cli(r, ['submit!', TASK, 'confirm']))).toContain('submitted confirm');
    expect(out(cli(r, ['gate!', TASK, 'confirm', 'accept', 'done']))).toContain('gate confirm: accept');
    expect(out(cli(r, ['append!', TASK, EVENT('completed', { note: 'finished' })]))).toContain('appended');
    expect(out(cli(r, ['status', TASK]))).toContain('done');
  }

  it('goal! seed emits the grill failure EXACTLY ONCE on an empty journey (regression guard — Fix 2 of 186685d)', () => {
    // The grill's provider call fails closed (hermetic baseUrl refuses the connection).
    // Fix 2: the goal-seed provider/gate failure is emitted ONCE — the pre-fix shape
    // console.error'd `${code}: ${blocker}` AND returned it, so the dispatch emit
    // printed it a second time (two stderr lines).
    const seed = cli(root, ['goal!', 'seed', 'land a flying thing']);
    expect(seed.code).toBe(1);
    // stderr carries the single diagnostic — the code: blocker text, byte-parity with the old first line
    const errLines = seed.stderr.trim().split('\n').filter((l) => l.length > 0);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^provider-unavailable: /);
    // text mode: the failure is a stderr diagnostic — stdout stays empty
    expect(seed.stdout).toBe('');
    // fail-closed: nothing was seeded
    expect(out(cli(root, ['goal']))).toContain('GOAL: (none)');
  });

  it('seeds, writes docs/goal.md, works to exhaustion, records the HUMAN verdict, refuses a dirty archive, then archives & reloads', () => {
    // empty journey: the goal consult names grill & seed — never a blind task
    expect(out(cli(root, ['goal']))).toContain('GOAL: (none)');
    expect(out(cli(root, ['next']))).toContain('no goal');

    // seed the goal leg by hand, exactly as seedGoal would
    seedGoalLeg(root);
    const seeded = out(cli(root, ['goal']));
    expect(seeded).toContain('GOAL: 01-goal');
    expect(seeded).toContain('[done]'); // the seed derives done — the first work leg's gate opens
    expect(seeded).toContain('verdict: open');
    expect(seeded).toContain('AC-2: a met verdict seals exhaustion'); // contract = the doc, machine-read
    // the doc rides the goal view at its git home: docs/goal.md (docs-as-git — no root lock)
    expect(seeded).toContain('doc: goal @');
    expect(seeded).toContain('docs/goal.md');
    expect(out(cli(root, ['next']))).toContain('session open'); // a seeded goal alone is not exhausted

    // commit the seeded session so the dirty-guard below has TRACKED changes to see
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'seed the goal']);

    // work → exhausted-unconfirmed
    driveWorkToDone(root);
    const exhausted = out(cli(root, ['goal']));
    expect(exhausted).toContain('verdict: unconfirmed');
    expect(out(cli(root, ['next']))).toContain('goal! met');
    expect(out(cli(root, ['next']))).not.toMatch(/next task:/);

    // the HUMAN verdict (RECORDED_BY=e2e here — the e2e actor) seals the session
    expect(out(cli(root, ['goal!', 'met', 'criteria confirmed']))).toContain('verdict recorded @');
    const metView = out(cli(root, ['goal']));
    expect(metView).toContain('met — session sealed');
    expect(metView).toContain('feedback: criteria confirmed');

    // a post-met spawn is sealed off, and a DIRTY (uncommitted tracked) archive refuses
    expect(cli(root, ['spawn!', '02-work/02-b', CONTRACT('too late')]).code).toBe(1);
    const dirty = cli(root, ['goal!', 'archive']);
    expect(dirty.code).toBe(1);
    expect(out(dirty)).toContain('uncommitted');

    // commit the seal → the archive succeeds
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'seal the session']);
    const arch = cli(root, ['goal!', 'archive']);
    expect(arch.code).toBe(0);
    expect(out(arch)).toContain('session archived');
    const dest = out(arch).match(/session archived → (.+)/)?.[1]?.trim() ?? '';
    expect(dest).toBeTruthy();
    expect(existsSync(join(dest, 'legs', GOAL, 'node.json'))).toBe(true);
    expect(existsSync(join(dest, 'legs', TASK, 'node.json'))).toBe(true);
    expect(existsSync(join(dest, '.ledger.json'))).toBe(true);

    // the live tree reset — an empty journey ready for the next goal; the archived
    // session's goal doc left the live docs/ home (git history + the archive keep it)
    expect(existsSync(join(root, '.ann', 'journey', 'legs', GOAL))).toBe(false);
    expect(existsSync(join(root, 'docs', 'goal.md'))).toBe(false);
    expect(out(cli(root, ['goal']))).toContain('GOAL: (none)');

    // the archived snapshot round-trips through a read-only .ann/journey mount
    const mount = join(root, '_mnt');
    mkdirSync(join(mount, '.ann'), { recursive: true });
    symlinkSync(dest!, join(mount, '.ann', 'journey'), 'dir');
    const loaded = new Store(mount);
    expect(loaded.ids().sort()).toEqual([GOAL, WORK, TASK]);
    expect(loaded.goalLegId()).toBe(GOAL);
    expect(loaded.events(GOAL).some((e) => e.type === 'goal-met')).toBe(true);
  });
});

describe('e2e — the OPERATOR ACTION advance! (F5 approve→execute, leg 07 task 01)', () => {
  let root: string;
  beforeEach(() => { root = newProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Leg 01 driven to a CLEAN close (docs committed, evidence, gates, completed) and an
   *  EMPTY front leg spawned + committed — the state where the derived advance points at
   *  an empty front leg (advance-leg). */
  function driveDoneThenEmptyFront(): void {
    prep(root, LEG, TASK, '02-leg');
    expect(out(cli(root, ['spawn!', LEG, CONTRACT('the first leg')]))).toContain('spawned');
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('do the thing')]))).toContain('spawned');
    expect(out(cli(root, ['submit!', TASK, 'grill']))).toContain('submitted grill');
    expect(out(cli(root, ['gate!', TASK, 'grill', 'accept', 'looks right']))).toContain('gate grill: accept');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe actual deliverable\n');
    expect(out(cli(root, ['docs', '--write']))).toContain('regenerated');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'stage the deliverable']);
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'evidence', note: 'committed', commits: [{ sha, note: 'deliverable' }] })]);
    expect(out(cli(root, ['submit!', TASK, 'confirm']))).toContain('submitted confirm');
    expect(out(cli(root, ['gate!', TASK, 'confirm', 'accept', 'done']))).toContain('gate confirm: accept');
    cli(root, ['append!', TASK, EVENT('completed', { note: 'finished' })]);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'close 01-leg/01-a']);
    // the EMPTY front leg — an advance points AT it but cannot author its task (v7 §5)
    expect(out(cli(root, ['spawn!', '02-leg', CONTRACT('the second leg')]))).toContain('spawned 02-leg');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'spawn the empty front leg']);
  }

  it('advance-leg is NOT machine-executable: the authored-work boundary + stop, zero writes (exit 0)', () => {
    driveDoneThenEmptyFront();
    const boundary = cli(root, ['advance!']);
    expect(boundary.code).toBe(0);
    expect(out(boundary)).toContain('advance-leg');
    expect(out(boundary)).toContain('NOT machine-executable');
    expect(out(boundary)).toContain('02-leg');
    // nothing was authored under the empty front leg and nothing was activated
    expect(existsSync(join(root, '.ann', 'journey', 'legs', '02-leg', '02-a', 'node.json'))).toBe(false);
    expect(out(cli(root, ['status', '02-leg']))).not.toContain('02-leg/02');
  });

  it('a dirty tree refuses FAIL-CLOSED before anything — the uncommitted docs change is the named blocker (exit 1)', () => {
    driveDoneThenEmptyFront();
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n'); // TRACKED + uncommitted
    const dirty = cli(root, ['advance!']);
    expect(dirty.code).toBe(1);
    expect(out(dirty)).toContain('REFUSED');
    expect(out(dirty)).toContain('uncommitted tracked change');
    expect(out(dirty)).toContain('docs/thing.md');
    // nothing executed
    expect(existsSync(join(root, '.ann', 'journey', 'legs', '02-leg', '02-a', 'node.json'))).toBe(false);
  });
});
