import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, symlinkSync, lstatSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

/**
 * E2E — the real CLI binary (`node dist/surface/cli.js`) driven as a subprocess
 * against an isolated, git-backed temp project. The unit suite drives Store/Commands
 * in-process; this suite proves the whole binary works the way a user invokes it:
 * argv parsing, the `!` write-marker, id/decision validation, project resolution, and
 * a full task lifecycle ending in a clean `check`.
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
  // Mirror the real repo's docs-migration view: root journey/ docs/ rules/ are symlinks onto .ann/.
  // cmdCheck verifies on-disk hashes via join(ROOT, l.path) — the legacy path resolves through
  // the journey symlink, so the integrity loop runs instead of skipping.
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/docs', join(root, 'docs'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function writeDraft(root: string, id: string, name: string, content: string): void {
  mkdirSync(join(root, '.ann', 'journey', 'legs', id, 'artifacts'), { recursive: true });
  writeFileSync(join(root, '.ann', 'journey', 'legs', id, 'artifacts', `${name}.md`), content);
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
    expect(out(cli(root, ['spawn!', LEG, CONTRACT('the first leg')]))).toContain('spawned 01-leg (leg)');
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('do the thing')]))).toContain('spawned 01-leg/01-a (task)');
    expect(out(cli(root, ['status']))).toContain('queued');

    // provenance: RECORDED_BY lands on the create event
    expect(out(cli(root, ['journey', TASK]))).toContain('e2e');

    // write discipline: a bare write name is refused with a hint
    const bare = cli(root, ['append', TASK, '{}']);
    expect(bare.code).toBe(1);
    expect(out(bare)).toContain("writes are marked with '!'");

    // evidence with a resolvable ref (F-AC18 traceability)
    mkdirSync(join(root, '.ann', 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, '.ann', 'docs', 'specs', 'thing.md'), '# Thing\n');
    expect(out(cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'evidence', refs: ['docs/specs/thing.md'] })]))).toContain('appended');

    // gate ①: submit alone blocks, the decision releases it
    expect(out(cli(root, ['submit!', TASK, 'grill']))).toContain('submitted grill');
    expect(out(cli(root, ['status', TASK]))).toContain('blocked');
    expect(out(cli(root, ['gate!', TASK, 'grill', 'accept', 'looks right']))).toContain('gate grill: accept');
    expect(out(cli(root, ['status', TASK]))).not.toContain('blocked');

    // the deliverable: draft on disk, then lock! (the one-current-per-name write)
    writeDraft(root, TASK, 'thing', 'the actual deliverable\n');
    expect(out(cli(root, ['lock!', TASK, 'thing', 'spec']))).toContain('locked thing @');
    const symlink = join(root, '.ann', 'docs', 'specs', 'thing-v1.md');
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(out(cli(root, ['read', 'thing']))).toContain('the actual deliverable');

    // gate ②: confirm is not 'done' on its own — completed event closes it
    expect(out(cli(root, ['submit!', TASK, 'confirm']))).toContain('submitted confirm');
    expect(out(cli(root, ['gate!', TASK, 'confirm', 'accept', 'done']))).toContain('gate confirm: accept');
    expect(out(cli(root, ['status', TASK]))).not.toContain('done');
    expect(out(cli(root, ['append!', TASK, EVENT('completed', { note: 'finished' })]))).toContain('appended');
    expect(out(cli(root, ['status', TASK]))).toContain('done');

    // commit the produced artifact so the hash-integrity path resolves, then check clean
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'close 01-leg/01-a']);
    const chk = cli(root, ['check']);
    expect(chk.code).toBe(0);
    expect(out(chk)).toContain('OK — 1 current artifacts');
    expect(out(chk)).toContain('State: 01-leg done');
  });

  it('enforces the write discipline and the gates through the CLI', () => {
    cli(root, ['spawn!', LEG, CONTRACT('l')]);
    cli(root, ['spawn!', TASK, CONTRACT('t')]);

    // duplicate id, bad JSON, bad id, sibling prefix clash — all refused by spawn!
    expect(cli(root, ['spawn!', TASK, CONTRACT('x')]).code).toBe(1);
    expect(out(cli(root, ['spawn!', TASK, CONTRACT('x')]))).toContain('already exists');
    expect(out(cli(root, ['spawn!', '01-leg/01-b', '{nope']))).toContain('bad contract JSON');
    expect(out(cli(root, ['spawn!', '01-leg/9', CONTRACT('x')]))).toContain('id-naming');
    expect(out(cli(root, ['spawn!', '01-leg/01-b', CONTRACT('x')]))).toContain('prefix-clash');

    // a composite-owned event kind cannot be appended around the mutator
    expect(out(cli(root, ['append!', TASK, EVENT('confirmed', { gate: 'grill' })]))).toContain('composite-owned');

    // lock! requires a decided grill gate and a draft on disk. With a draft present the gate
    // gap surfaces first; with no draft at all the missing working file fires instead.
    writeDraft(root, TASK, 'thing', 'x\n');
    expect(out(cli(root, ['lock!', TASK, 'thing', 'spec']))).toContain('GATE-1 GAP');
    cli(root, ['spawn!', '01-leg/02-a', CONTRACT('x')]);
    expect(out(cli(root, ['lock!', '01-leg/02-a', 'thing', 'spec']))).toContain('no-working-file');

    // gate! validates its decision vocabulary
    expect(cli(root, ['gate!', TASK, 'grill', 'maybe']).code).toBe(2);
    expect(out(cli(root, ['gate!', TASK, 'grill', 'maybe']))).toContain('usage:');
  });

  it('run! fails closed with no reachable provider', () => {
    cli(root, ['spawn!', LEG, CONTRACT('l')]);
    cli(root, ['spawn!', '01-leg/02-a', CONTRACT('run me')]);

    const run = cli(root, ['run!', '01-leg/02-a']);
    expect(run.code).toBe(1);
    expect(out(run)).toContain('FAILED');
    expect(out(run)).toContain('provider-unavailable');
    expect(out(cli(root, ['status', '01-leg/02-a']))).toContain('failed');
  });

  it('detects a store change made outside the CLI, refuses to write over it, and reasons about it', () => {
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
