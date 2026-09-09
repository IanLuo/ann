import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

/**
 * E2E — UNIFORM JSON (uniform-json). Every ann command accepts `--json` and emits
 * EXACTLY ONE structured JSON document on stdout — a read's view value on success,
 * `{ok:true,value}` for a write, or `{error:{code,message}}` for a failure — with the
 * documented exit code (0 ok · 1 store/command/validation error · 2 usage) and NO text
 * before/after the document. The suite drives the REAL binary (`node dist/surface/cli.js`)
 * against an isolated git-backed project and asserts stdout is a single parseable doc
 * for every read, that help/commands/bare emit their JSON forms, that writes return
 * `{ok:true,…}` and still apply, that apiKey is never echoed, that the error document is
 * the ONLY thing on stdout for failures (exit 1/2), and that check/verify keep their
 * exit code while their JSON stdout stays clean. `npm run build` first — we spawn dist.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
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

/** Assert stdout is EXACTLY ONE JSON document (parse fails on stray text) and return it. */
function doc<T = Record<string, unknown>>(r: CliResult): T {
  expect(r.stdout.trim().length).toBeGreaterThan(0);
  const parsed = JSON.parse(r.stdout.trim()) as T; // throws if text rides along the JSON
  return parsed;
}
const expectNoStrayText = (r: CliResult): void => {
  const body = r.stdout.trim();
  expect(body.endsWith('}') || body.endsWith(']')).toBe(true);
};

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/** A fresh ann project: registry data + the legacy root symlinks, git-backed. */
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-json-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
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

const LEG = '01-leg';
const TASK = '01-leg/01-a';
const CONTRACT = (intent: string) => JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`] });
const EVENT = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ at: '2026-08-29', type, ...extra });
function prep(root: string, ...ids: string[]): void {
  for (const id of ids) mkdirSync(join(root, '.ann', 'journey', 'legs', id), { recursive: true });
}

/** Drive one leg + one task to a CLEAN close (docs committed, evidence recorded, gates
 *  confirmed, completed) so check/verify read a clean git — the state every read needs. */
function driveLifecycle(root: string): string {
  prep(root, LEG, TASK);
  cli(root, ['spawn!', LEG, CONTRACT('the leg')]);
  cli(root, ['spawn!', TASK, CONTRACT('do the thing')]);
  cli(root, ['present!', TASK, 'grill']);
  cli(root, ['gate!', TASK, 'grill', 'accept', 'looks right']);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe actual deliverable\n');
  cli(root, ['docs', '--write']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'stage the deliverable']);
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  cli(root, ['append!', TASK, JSON.stringify({ at: '2026-08-29', type: 'evidence', note: 'committed', commits: [{ sha, note: 'deliverable' }] })]);
  cli(root, ['present!', TASK, 'confirm']);
  cli(root, ['gate!', TASK, 'confirm', 'accept', 'done']);
  cli(root, ['append!', TASK, EVENT('completed', { note: 'finished' })]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'close the task']);
  return sha;
}

describe('e2e — uniform JSON across every command', () => {
  let root: string;
  beforeEach(() => { root = newProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('every READ command under --json emits exactly ONE JSON doc on stdout and exits 0', () => {
    driveLifecycle(root);
    const reads: Array<Array<string>> = [
      ['status'], ['journey'], ['ledger'], ['specs'], ['docs'],
      ['providers'], ['config'], ['project'], ['sessions'], ['chain'], ['steps'], ['next'],
      ['goal'], ['rules'], ['validate'],
      ['journey', LEG], ['branch', LEG],
      ['confirm', TASK], ['detail', TASK], ['packet', TASK], ['results', TASK],
      ['read', 'thing'], ['thing'], // read + bare-name path map
    ];
    for (const cmd of reads) {
      const r = cli(root, ['--json', ...cmd]);
      expect(r.code, `--json ${cmd.join(' ')} exited ${r.code} (stderr: ${r.stderr.trim()})`).toBe(0);
      const j = doc(r); // must parse as a single JSON document
      expectNoStrayText(r);
      expect(j).toBeDefined();
      expect(r.stderr).not.toContain('uniform-json bug');
    }
  });

  it('writes under --json return {ok:true,…} as the ONE doc and still apply', () => {
    prep(root, LEG, TASK);
    const s = cli(root, ['--json', 'spawn!', LEG, CONTRACT('the leg')]);
    expect(s.code).toBe(0);
    expect(doc<{ ok: boolean; value: { id: string } }>(s).ok).toBe(true);
    const t = cli(root, ['--json', 'spawn!', TASK, CONTRACT('do it')]);
    expect(doc<{ ok: boolean }>(t).ok).toBe(true);
    // append! is a write — one doc, and the write landed
    const a = cli(root, ['--json', 'append!', TASK, EVENT('activated', { note: 'go' })]);
    expect(a.code).toBe(0);
    expect(doc<{ ok: boolean }>(a).ok).toBe(true);
    expect(out(cli(root, ['status', TASK]))).toContain('active');
    // config! set — apiKey value is NEVER echoed (masked=true), never in the doc
    const cfg = cli(root, ['--json', 'config!', 'set', 'model', 'deepseek-chat']);
    expect(cfg.code).toBe(0);
    expect(doc<{ ok: boolean; value: { key: string; value: string } }>(cfg).ok).toBe(true);
    const key = cli(root, ['--json', 'config!', 'set', 'apiKey', 'sk-super-secret']);
    expect(key.code).toBe(0);
    const keyDoc = doc<{ ok: boolean; value: { masked?: boolean; value?: unknown } }>(key);
    expect(keyDoc.ok).toBe(true);
    expect(keyDoc.value.masked).toBe(true);
    expect(JSON.stringify(keyDoc)).not.toContain('sk-super-secret');
  });

  it('help/commands/bare ann each emit their JSON form (usage doc / the derived rows)', () => {
    // --json help → the usage doc
    const h = cli(root, ['--json', 'help']);
    expect(h.code).toBe(0);
    const usage = doc<{ doc: string; commands: Array<{ name: string; json: boolean }> }>(h);
    expect(usage.doc).toContain('journey CLI');
    expect(usage.commands.length).toBeGreaterThan(10);
    // bare ann --json → the same usage doc (never "no doc/artifact for 'undefined'")
    const bare = cli(root, ['--json']);
    expect(bare.code).toBe(0);
    expect(doc<{ doc: string }>(bare).doc).toContain('journey CLI');
    // --json commands → the derived table as an array, every row marked json
    const c = doc<Array<{ name: string; desc: string; json: boolean }>>(cli(root, ['--json', 'commands']));
    expect(Array.isArray(c)).toBe(true);
    expect(c.length).toBeGreaterThan(10);
    for (const row of c) expect(row.json).toBe(true);
    expect(c.some((r) => r.name === 'status')).toBe(true);
    // the commands MARKDOWN row mentions --json support
    expect(cli(root, ['commands']).stdout).toContain('| Command | Args | What it does | --json |');
    expect(cli(root, ['commands']).stdout).toContain('| `yes` |');
    // bare ann (text) prints help, not an error
    const text = cli(root, []);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('journey CLI');
  });

  it('failures under --json put the error document on stdout (exit 1/2) and nothing else', () => {
    driveLifecycle(root);
    // a read that cannot resolve → error doc, exit 1
    const miss = cli(root, ['--json', 'read', 'not-a-doc']);
    expect(miss.code).toBe(1);
    const e = doc<{ error: { code: string; message: string } }>(miss);
    expect(typeof e.error.code).toBe('string');
    expect(e.error.message.length).toBeGreaterThan(0);
    // an unknown id on an id command → the resolveId error doc
    const nid = cli(root, ['--json', 'results', '99-nope']);
    expect(nid.code).toBe(1);
    expect(doc<{ error: { code: string } }>(nid).error.code).toBeTruthy();
    // a usage failure → exit 2, code 'usage'
    const u = cli(root, ['--json', 'gate!', TASK, 'grill', 'maybe']);
    expect(u.code).toBe(2);
    expect(doc<{ error: { code: string } }>(u).error.code).toBe('usage');
    // a WRITE refused by L1 (duplicate spawn) → error doc, exit 1, still one doc
    const dup = cli(root, ['--json', 'spawn!', LEG, CONTRACT('again')]);
    expect(dup.code).toBe(1);
    expect(doc<{ error: { code: string; message: string } }>(dup).error.message).toContain('already exists');
  });

  it('check and verify keep their exit code under --json while stdout is the clean doc', () => {
    driveLifecycle(root);
    const chk = cli(root, ['--json', 'check']);
    expect(chk.code).toBe(0);
    const clean = doc<{ problems: unknown[]; warnings: unknown[]; notes: unknown[]; docs: number; state: string }>(chk);
    expect(Array.isArray(clean.problems)).toBe(true);
    expect(clean.docs).toBeGreaterThanOrEqual(1);
    expect(clean.state).toContain('State:');
    // verify clean → exit 0, {drifts:[],count:0}
    const v = cli(root, ['--json', 'verify']);
    expect(v.code).toBe(0);
    expect(doc<{ drifts: unknown[]; count: number }>(v).count).toBe(0);

    // a store-external edit → BOTH drift (exit 1) and check problems (exit 1), and in each
    // the stdout doc is still the ONLY document (the report is data, not trailing text)
    appendFileSync(join(root, '.ann', 'journey', 'legs', TASK, 'events.jsonl'), JSON.stringify({ at: '2026-08-29', type: 'extended', note: 'hand-forged' }) + '\n');
    const dirty = cli(root, ['--json', 'verify']);
    expect(dirty.code).toBe(1);
    const drift = doc<{ drifts: unknown[]; count: number }>(dirty);
    expect(drift.count).toBeGreaterThan(0);
    expectNoStrayText(dirty);
  });

  it('run! under --json refuses up-front (it drives an interactive terminal — JSON cannot; a JSON doc would only ever catch an early failure)', () => {
    prep(root, LEG, '01-leg/02-a');
    cli(root, ['spawn!', LEG, CONTRACT('l')]);
    cli(root, ['spawn!', '01-leg/02-a', CONTRACT('run me')]);
    const run = cli(root, ['--json', 'run!', '01-leg/02-a']);
    expect(run.code).toBe(1);
    const j = doc<{ error: { code: string; message: string } }>(run);
    expect(j.error.code).toBe('run-interactive'); // the interactive driver refuses JSON up-front
    expect(j.error.message).toContain('INTERACTIVE terminal session');
    expectNoStrayText(run);
  });

  it('spec! under --json refuses up-front (it drives an interactive terminal grilling session — JSON cannot)', () => {
    // refuses BEFORE any provider/goal read — a bare project suffices, no goal seeded
    const spec = cli(root, ['--json', 'spec!', 'requirements']);
    expect(spec.code).toBe(1);
    const j = doc<{ error: { code: string; message: string } }>(spec);
    expect(j.error.code).toBe('spec-interactive'); // the interactive carve-out refuses JSON up-front
    expect(j.error.message).toContain('INTERACTIVE grilling session');
    expectNoStrayText(spec);
  });

  it('advance! under --json refuses up-front (the ADVANCE card approve drives an interactive terminal — JSON cannot)', () => {
    // the operator action (F5 approve→execute) refuses before ANY store/derive read
    const adv = cli(root, ['--json', 'advance!']);
    expect(adv.code).toBe(1);
    const j = doc<{ error: { code: string; message: string } }>(adv);
    expect(j.error.code).toBe('advance-interactive'); // the interactive carve-out refuses JSON up-front
    expect(j.error.message).toContain('INTERACTIVE terminal session');
    expectNoStrayText(adv);
  });
});
