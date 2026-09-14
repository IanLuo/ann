import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { OpLog, logPath, readOpLog } from '../abilities/obs/log.js';
import { startService } from '../surface/service.js';

/**
 * E2E — THE OPERATIONAL LOG (leg 12 task 05). The design record
 * (`.agents/plan/self-driving-design.md`) asks for a DETAILED, structured log of what ann
 * is doing, why, and how it ended — the third view beside the op-log (model calls) and the
 * transcript (step records). This suite drives the REAL binary and asserts the OPERATOR's
 * experience of it:
 *
 *   · a REAL command leaves a real line (`ann status`) — wall-clock ts, actor, outcome,
 *     durationMs, REDACTED argv — and a REAL write leaves its own, under the SAME runId;
 *   · a whole run reconstructs from that runId (the write's line, then the command's), in
 *     file order, with the ts non-decreasing;
 *   · a REFUSED write is as visible as a successful one (its code, at warn);
 *   · REDACTION holds end to end: a secret planted in the environment (and passed on the
 *     command line) NEVER appears in the file;
 *   · FAIL-OPEN: with an unwritable log the command still succeeds (exit 0, the normal
 *     stdout) and only WARNS — observability never breaks the engine;
 *   · the log is SCRATCH: `<project>/logs/operation.jsonl`, gitignored, never the record;
 *   · the DEBUG READ (`ann log` tail/filters) and the SERVICE route (`GET /api/log`) are
 *     derived views over the same file — no raw-file spelunking needed.
 *
 * `npm run build` first — we spawn dist.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };
/** The secret we plant: an env var that LOOKS like a key (the knownSecrets registry). */
const SECRET = 'sk-e2e-planted-must-not-appear-0123456789';
const LEG = '01-alpha';
const TASK = '01-alpha/01-a';

interface CliResult { code: number | null; stdout: string; stderr: string }

function cli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json'), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const git = (root: string, args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};

/** A fresh ann project: registry data + the legacy root symlinks, git-backed. */
function newProject(prefix = 'ann-e2e-log-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);
  return root;
}

/** A queued task in a live leg — enough for a read, a write and a refusal. */
function seedJourney(root: string): void {
  const legs = join(root, '.ann', 'journey', 'legs');
  mkdirSync(join(legs, LEG), { recursive: true });
  writeFileSync(
    join(legs, LEG, 'node.json'),
    JSON.stringify({ id: LEG, contract: { intent: 'the alpha leg (the epic)', acceptanceCriteria: ['the leg delivers'] }, createdAt: '2026-09-14' }),
  );
  const dir = join(legs, TASK);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id: TASK, contract: { intent: 'the first task', acceptanceCriteria: ['it is done'] }, createdAt: '2026-09-14' }));
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: '2026-09-14', type: 'created' }) + '\n');
}

const linesOf = (root: string): Array<Record<string, unknown>> =>
  existsSync(logPath(root))
    ? readFileSync(logPath(root), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

let root: string;
beforeEach(() => {
  root = newProject();
  seedJourney(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a REAL command leaves a real line — and the run reconstructs from its id', () => {
  it('records the invocation (outcome · durationMs · redacted argv) at the same runId as its writes', () => {
    const read = cli(root, ['status']);
    expect(read.code).toBe(0);

    const write = cli(root, ['append!', TASK, JSON.stringify({ at: '2026-09-14', type: 'waiting', note: 'waiting for the runner' })]);
    expect(write.code).toBe(0);

    const lines = linesOf(root);
    // the invocation line: what ran, how it ended, how long it took, with the argv
    const statusLine = lines.find((l) => l.command === 'status');
    expect(statusLine).toMatchObject({ event: 'command', actor: 'e2e', outcome: 'ok' });
    expect(typeof statusLine?.durationMs).toBe('number');
    expect(statusLine?.inputs).toEqual({ argv: [], json: false });
    expect(String(statusLine?.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // ONE run = the write's line, then the command's, all under one runId
    const runId = lines.find((l) => l.command === 'append!')?.runId;
    expect(typeof runId).toBe('string');
    const run = lines.filter((l) => l.runId === runId);
    expect(run.map((l) => [l.event, l.command, l.outcome])).toEqual([
      ['write', 'append!', 'ok'],
      ['command', 'append!', 'ok'],
    ]);
    // the write line addresses the node it wrote, and carries its redacted args
    expect(run[0].taskId).toBe(TASK);
    expect(JSON.stringify(run[0].inputs)).toContain('waiting for the runner');
    // file order IS the order things happened (the log is append-only, ts non-decreasing)
    const ts = lines.map((l) => Date.parse(String(l.ts)));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('records a REFUSED write as visibly as a successful one — the refusal code, at warn', () => {
    // a composite-owned event through the general append is refused BY NAME (the kind
    // belongs to gate!), and the refusal writes nothing
    const r = cli(root, ['append!', TASK, JSON.stringify({ at: '2026-09-14', type: 'confirmed', gate: 'grill' })]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('composite-owned');
    const refused = linesOf(root).find((l) => l.event === 'write');
    expect(refused?.command).toBe('append!');
    expect(refused?.level).toBe('warn');
    expect(String(refused?.outcome)).toMatch(/^refused:/);
    expect(refused?.error).toMatchObject({ code: expect.any(String) });
    // and the command line records the same failure (exit 1) with the error doc
    const cmd = linesOf(root).find((l) => l.event === 'command');
    expect(cmd?.level).toBe('warn');
    expect(String(cmd?.outcome)).toMatch(/^refused:/);
  });
});

describe('the invariants hold through the real binary', () => {
  it('REDACTION: a planted secret never appears — not from the env, not from the argv', () => {
    // the secret rides BOTH channels: a secret-looking env var and a command-line value
    const r = cli(root, ['log', '--task', SECRET], { ANTHROPIC_API_KEY: SECRET, ANN_TEST_TOKEN: SECRET });
    expect(r.code).toBe(0);
    const raw = readFileSync(logPath(root), 'utf8');
    expect(raw.length).toBeGreaterThan(0); // the line WAS written
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('Bearer');
    expect(raw).toContain('[redacted]');
    // the line still says what happened
    expect(linesOf(root)[0]).toMatchObject({ event: 'command', command: 'log', outcome: 'ok' });
  });

  it('FAIL-OPEN: an unwritable log WARNS and the command still succeeds with its normal output', () => {
    const broken = newProject('ann-e2e-log-broken-');
    try {
      seedJourney(broken);
      writeFileSync(join(broken, 'logs'), 'a FILE where the log dir should be'); // → ENOTDIR on append
      const r = cli(broken, ['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('01-alpha');
      expect(r.stderr).toContain('operational log write failed');
      expect(r.stderr).toContain('continuing');
      expect(existsSync(logPath(broken))).toBe(false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('SCRATCH, NEVER THE RECORD: the log lives in the project’s logs/, gitignored, outside the store', () => {
    cli(root, ['status']);
    expect(existsSync(logPath(root))).toBe(true);
    expect(logPath(root)).toBe(join(root, 'logs', 'operation.jsonl'));
    expect(existsSync(join(root, '.ann', 'journey', 'legs', LEG, 'logs'))).toBe(false);
    // the repo's .gitignore keeps logs/ out of the record (a real ignore check, not a grep)
    execFileSync('git', ['-C', REPO, 'check-ignore', '-q', 'logs/operation.jsonl']);
    // …and the scratch home ignores ITSELF, so a `git add -A` in ANY ann project cannot
    // sweep the log into the record (a tracked log would dirty the tree under the
    // engine's own clean-tree guards — capture! — and grow the repo unboundedly)
    execFileSync('git', ['-C', root, 'check-ignore', '-q', 'logs/operation.jsonl']);
    git(root, ['add', '-A']);
    const porcelain = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(porcelain).not.toContain('logs/');
    // the journey store is untouched by the logging: the task's events are exactly its own
    const events = readFileSync(join(root, '.ann', 'journey', 'legs', TASK, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).type).toBe('created');
  });
});

describe('the debug read — `ann log`, no raw-file spelunking', () => {
  it('tails and filters by run · task · level · since · tail (value-canonical)', () => {
    cli(root, ['status']);
    cli(root, ['append!', TASK, JSON.stringify({ at: '2026-09-14', type: 'waiting', note: 'x' })]);
    cli(root, ['append!', TASK, JSON.stringify({ at: '2026-09-14', type: 'confirmed', gate: 'grill' })]); // a refusal at warn
    const lines = linesOf(root);
    const runId = String(lines[0].runId);

    const page = JSON.parse(cli(root, ['log', '--json', '--tail', '100']).stdout) as { total: number; shown: number; lines: Array<Record<string, unknown>> };
    expect(page.total).toBe(5); // 3 invocations + the write + the refused write
    expect(page.lines.map((l) => l.event)).toEqual(['command', 'write', 'command', 'write', 'command']);

    const oneRun = JSON.parse(cli(root, ['log', '--json', '--run', runId]).stdout) as { shown: number; lines: Array<Record<string, unknown>> };
    expect(oneRun.shown).toBe(1);
    expect(oneRun.lines[0].command).toBe('status');

    // --task matches the WRITES that address the node AND the invocations that name it
    const byTask = JSON.parse(cli(root, ['log', '--json', '--task', TASK]).stdout) as { lines: Array<Record<string, unknown>> };
    expect(byTask.lines.map((l) => [l.event, l.command])).toEqual([
      ['write', 'append!'],
      ['command', 'append!'],
      ['write', 'append!'],
      ['command', 'append!'],
    ]);
    expect(byTask.lines.every((l) => l.taskId === TASK)).toBe(true);

    const warn = JSON.parse(cli(root, ['log', '--json', '--level', 'warn']).stdout) as { lines: Array<Record<string, unknown>> };
    expect(warn.lines).toHaveLength(2); // the refused write + the failed command
    expect(warn.lines.every((l) => l.level === 'warn')).toBe(true);

    // --tail is the LAST n of what matches: the refused run's own two lines, tailed to one
    const refusedRun = String(lines.find((l) => l.outcome === 'refused:composite-owned')?.runId);
    const tail1 = JSON.parse(cli(root, ['log', '--json', '--run', refusedRun, '--tail', '1']).stdout) as { shown: number; lines: Array<Record<string, unknown>> };
    expect(tail1.shown).toBe(1);
    expect(tail1.lines[0]).toMatchObject({ event: 'command', outcome: 'refused:composite-owned' });
    const noTail = JSON.parse(cli(root, ['log', '--json', '--run', refusedRun, '--tail', '100']).stdout) as { shown: number };
    expect(noTail.shown).toBe(2); // the write, then the invocation

    // --since is a real window (a 1h window includes everything just written)
    const since = JSON.parse(cli(root, ['log', '--json', '--since', '1h']).stdout) as { shown: number; total: number };
    expect(since.shown).toBe(since.total);

    // the TEXT form shows the correlation id and the duration (the operator's view)
    const text = cli(root, ['log', '--tail', '100']);
    expect(text.stdout).toContain(runId); // the correlation id is on every line
    expect(text.stdout).toContain('write'); // the write lines are in the same tail
    expect(text.stdout).toContain('refused:composite-owned');
  });

  it('a bad filter is a NAMED usage error (exit 2), and an empty log is an empty page', () => {
    const bad = cli(root, ['log', '--since', 'yesterday']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--since must be an ISO instant');
    expect(cli(root, ['log', '--level', 'loud']).code).toBe(2);
    expect(cli(root, ['log', '--tail', '0']).code).toBe(2);
    const empty = JSON.parse(cli(root, ['log', '--json', '--run', 'never-ran']).stdout) as { total: number; lines: unknown[] };
    // the read itself logs a command line, so total is the log's own content, never a crash
    expect(empty.lines).toEqual([]);
  });
});

describe('the service route — GET /api/log, the same file, one reader', () => {
  it('serves the operational log over HTTP with the CLI’s own handler', async () => {
    cli(root, ['status']);
    const runId = String(linesOf(root)[0].runId);
    const svc = await startService({ root, host: '127.0.0.1', port: 0, log: new OpLog(root, 'run-serve-test', 'server', { secrets: [] }) });
    try {
      const res = await fetch(`${svc.url}/api/log?run=${runId}&tail=5`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lines: Array<Record<string, unknown>>; file: string };
      expect(body.file).toBe(logPath(root));
      expect(body.lines.map((l) => l.command)).toEqual(['status']);
      // the request itself is recorded — server actor, its OWN http runId, status + duration
      const served = readOpLog(root, {}).lines.find((l) => String(l.command).startsWith('GET /api/log'));
      expect(served).toMatchObject({ actor: 'server', outcome: 'http-200' });
      expect(String(served?.runId)).toMatch(/^http-/);
      expect(typeof served?.durationMs).toBe('number');
      // and a bad filter is the CLI's own usage error, over HTTP 400
      expect((await fetch(`${svc.url}/api/log?since=yesterday`)).status).toBe(400);
    } finally {
      await svc.close();
    }
  });
});
