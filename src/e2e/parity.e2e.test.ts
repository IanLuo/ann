import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

import { createContext, HANDLERS, resolveDispatch, bareNameHandler, type Outcome } from '../surface/handlers.js';
import { RENDERS, renderPacketById } from '../surface/command-renderers.js';

/**
 * HANDLER-LEVEL PARITY (value-canonical). Every command is a PURE handler(ctx) → Outcome
 * and the default text is a RENDER of the SAME value `--json` emits. This suite proves
 * the invariant end-to-end by running the handler IN-PROCESS on a hermetic fixture ctx
 * and asserting that (a) `RENDERS[key](value)` — the text — byte-equals the REAL spawned
 * binary's default stdout, and (b) `JSON.stringify(value)` byte-equals the spawned
 * `--json` stdout — for a representative set including the composed offenders `next` and
 * `confirm` plus the results-listing fix. Both sides share `resolveDispatch`, so the
 * in-process path is the binary's dispatch, never a re-implementation. `npm run build`
 * first — we spawn dist.
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

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/** A fresh ann project: registry data + the legacy root symlinks, git-backed. */
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-parity-'));
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
function prep(root: string, ...ids: string[]): void {
  for (const id of ids) mkdirSync(join(root, '.ann', 'journey', 'legs', id), { recursive: true });
}

/** Drive one leg + one task to a CLEAN close (docs committed, evidence recorded, gates
 *  confirmed, completed) — the deterministic state every read in the matrix renders. */
function driveLifecycle(root: string): void {
  prep(root, LEG, TASK);
  cli(root, ['spawn!', LEG, CONTRACT('the leg')]);
  cli(root, ['spawn!', TASK, CONTRACT('do the thing')]);
  cli(root, ['submit!', TASK, 'grill']);
  cli(root, ['gate!', TASK, 'grill', 'accept', 'looks right']);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe actual deliverable\n');
  cli(root, ['docs', '--write']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'stage the deliverable']);
  cli(root, ['evidence!', TASK, 'abc1234']);
  cli(root, ['submit!', TASK, 'confirm']);
  cli(root, ['gate!', TASK, 'confirm', 'accept', 'done']);
  cli(root, ['complete!', TASK]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'close the task']);
}

/**
 * Run ONE command through the handler path exactly as the binary dispatches it: build
 * the ctx, resolve handler + render key via resolveDispatch, produce BOTH the default
 * text (the RENDER of the value) and the --json text (stringify of the SAME value).
 * Returns nothing on stdout/stderr that the binary would not — pure value → both forms.
 */
async function runHandler(root: string, argv: string[]): Promise<{ text: string; json: string }> {
  const ctx = createContext(root, argv, { json: false });
  const env = ctx.renderEnv();
  const canonical = argv[0] ?? 'help';
  const { handler, renderKey } = resolveDispatch(ctx, canonical);
  const h = handler ?? bareNameHandler; // the bare-name read path map
  const key = handler ? renderKey : 'bare';
  const outcome: Outcome = await h(ctx);
  if (!outcome.ok) throw new Error(`handler failed (${outcome.error.code}): ${outcome.error.message}`);
  const value = outcome.value;
  const json = JSON.stringify(value, null, 2) + '\n';
  const text = key === 'packet' ? renderPacketById(value, env) : RENDERS[key]?.(value, env) ?? '';
  return { text, json };
}

describe('handler-level parity — in-process value === the spawned binary', () => {
  let root: string;
  const envKeys = ['ANN_PROJECT', 'ANN_CONFIG', 'RECORDED_BY', 'ANN_LLM_BASE_URL'];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let savedCwd = REPO;

  beforeEach(() => {
    root = newProject();
    // mirror the spawn env so in-process handlers read the SAME config/registry as the binary
    for (const [k, v] of Object.entries({ ...HERMETIC, ANN_PROJECT: root, ANN_CONFIG: join(root, '.e2e-config.json'), RECORDED_BY: 'e2e' })) process.env[k] = v;
    savedCwd = process.cwd();
    process.chdir(root); // store/vocab/results reads are cwd-rooted in-process, as the binary is post-chdir
  });
  afterEach(() => {
    process.chdir(savedCwd);
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  // The matrix spawns the real binary ~50×: this is a process-bound test, so it takes an
  // explicit budget instead of the 5s default (under the suite's parallel files the
  // default times out on a loaded machine — the same spawn-bound shape as uniform-json).
  it('text(render(value)) and json(stringify(value)) each byte-match the spawned binary', { timeout: 30_000 }, async () => {
    driveLifecycle(root);
    // representative read set incl. the composed offenders next + confirm, the
    // journey-with-id branch (journeyOne), the results-listing value, bare + doc forms
    const matrix: Array<string[]> = [
      [], ['help'], ['commands'],
      ['status'], ['journey'], ['journey', LEG], ['branch', LEG], ['ledger'], ['goal'],
      ['next'], ['confirm', TASK], ['detail', TASK], ['results', TASK], ['packet', TASK],
      ['read', 'thing'], ['thing'], ['docs'], ['specs'], ['rules'], ['validate'], ['chain'], ['steps'],
    ];
    for (const argv of matrix) {
      const label = argv.join(' ') || '(bare ann)';
      const spawned = cli(root, argv);
      expect(spawned.code, `spawn ${label} exited ${spawned.code} (${spawned.stderr.trim()})`).toBe(0);
      const spawnedJson = cli(root, ['--json', ...argv]);
      expect(spawnedJson.code, `spawn --json ${label} exited ${spawnedJson.code}`).toBe(0);
      const ip = await runHandler(root, argv);
      // the RENDER of the in-process value byte-equals the binary's DEFAULT stdout…
      expect(ip.text, `text parity: ${label}`).toBe(spawned.stdout);
      // …and stringify of the SAME value byte-equals the binary's --json stdout
      expect(ip.json, `json parity: ${label}`).toBe(spawnedJson.stdout);
      expect(JSON.parse(ip.json), `json doc equals: ${label}`).toEqual(JSON.parse(spawnedJson.stdout));
    }
  });
});
