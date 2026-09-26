import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * E2E — THE HALF ACCEPT'S ROUTE, OVER REAL HTTP (leg 12 task 13, AC-2/AC-5).
 *
 * The card's third action needs a door the page can knock on, and the door is the ONE named
 * route `POST /api/transfer` over the SAME `gate!` gesture the CLI runs (leg 12/12) — never
 * a second write path. This proves the four things AC-5 asks of it, each against the FILE
 * ON DISK as well as the response:
 *
 *   · the happy path lands the accept AND the move, and the reads after it show the task
 *     closed with the successor NAMED — the AC that moved is no longer an owed gap;
 *   · an UNKNOWN TARGET is refused by the engine's own name with ZERO writes (F-AC16 at
 *     write time — the successor has to be spawned first);
 *   · an EMPTY SCOPE is refused (the shape gate for a bare empty string, the engine for a
 *     whitespace-only one) with zero writes;
 *   · the BOUNDARY STATE: a confirm gate with NO submission cannot transfer (409 —
 *     well-formed request, wrong state) — the route serves the card's third action, and
 *     that action exists only where a decision is in hand.
 *
 * ORDER MATTERS AND IS DELIBERATE: every refusal writes nothing, so they share the one
 * fixture, and the happy path runs LAST because it is the only test that changes the state
 * the others assert on.
 *
 * `npm run build` first — the service is spawned as `node dist/surface/cli.js serve`.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

const LEG = '01-leg';
const TASK = '01-leg/01-a'; // the half accept's subject: two ACs, grill accepted, confirm submitted
const NEXT = '01-leg/02-b'; // the successor the scope moves to (it must EXIST)
const IDLE = '01-leg/03-c'; // grill accepted, NO confirm submission — the boundary state
const SCOPE = 'AC-2: the second thing is done';

interface CliResult { code: number | null; stdout: string; stderr: string }
function cli(root: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json') },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const git = (root: string, args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-xfer-serve-'));
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

const EVENTS = (root: string, id: string) => join(root, '.ann', 'journey', 'legs', id, 'events.jsonl');
const CONTRACT = (intent: string, acs: string[]) => JSON.stringify({ intent, acceptanceCriteria: acs });

/** The journey the route is exercised against: one leg, a task whose confirm gate is LIVE
 *  with an AC it did not meet, a spawned successor, and a task with no submission at all. */
function driveJourney(root: string): void {
  cli(root, ['spawn!', LEG, CONTRACT('the leg', ['the leg is done'])]);
  cli(root, ['spawn!', TASK, CONTRACT('do two things', ['the first thing is done', 'the second thing is done'])]);
  cli(root, ['spawn!', NEXT, CONTRACT('carry the rest', ['the rest is done'])]);
  cli(root, ['spawn!', IDLE, CONTRACT('nothing submitted here', ['it is done'])]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'the fixture journey']);
  // the LIVE exit gate on TASK: the entry gate is settled, the result gate is in hand
  cli(root, ['submit!', TASK, 'grill']);
  cli(root, ['gate!', TASK, 'grill', 'accept', 'the contract is right']);
  cli(root, ['submit!', TASK, 'confirm']);
  // …and IDLE's entry gate is settled too, so its confirm gate is genuinely UNDECIDED
  cli(root, ['submit!', IDLE, 'grill']);
  cli(root, ['gate!', IDLE, 'grill', 'accept', 'the contract is right']);
}

interface Server { url: string; child: ChildProcess; kill(): void }
async function serve(root: string): Promise<Server> {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json'), ANN_HOST: '', ANN_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr?.on('data', (c) => { err += String(c); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve announced no endpoint in 15s — stdout: ${out} · stderr: ${err}`)), 15_000);
    child.stdout?.on('data', (c) => {
      out += String(c);
      const m = out.match(/ann serve: listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited ${code} before listening — stdout: ${out} · stderr: ${err}`));
    });
  });
  return { url, child, kill: () => child.kill() };
}

interface Res { status: number; body: string }
const get = async (url: string): Promise<Res> => {
  const r = await fetch(url);
  return { status: r.status, body: await r.text() };
};
const post = async (url: string, payload: unknown): Promise<Res> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.text() };
};
const err = (body: string): { code: string; message: string } => (JSON.parse(body) as { error: { code: string; message: string } }).error;
/** POST /api/gate's own shape, for the one comparison that matters: the route is the SAME
 *  write, so a body the route cannot take is the only difference there should be. */
const transfer = (server: Server, body: Record<string, unknown>): Promise<Res> => post(server.url + '/api/transfer', body);

describe('e2e — the half accept’s route over real HTTP (AC-2/AC-5)', () => {
  let root: string;
  let server!: Server;

  beforeAll(async () => {
    root = newProject();
    driveJourney(root);
    server = await serve(root);
  }, 60_000);

  afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('AC-2 — the body is validated by NAME: an unknown key, a missing transfer, and empty strings never reach the command layer', { timeout: 30_000 }, async () => {
    const before = readFileSync(EVENTS(root, TASK), 'utf8');
    const cases: Array<{ body: unknown; says: string }> = [
      { body: { id: TASK, gate: 'confirm', decision: 'accept', why: 'x', transfer: { target: NEXT, scope: SCOPE }, extra: 1 }, says: 'unknown key(s) extra' },
      { body: { id: TASK, gate: 'confirm', decision: 'accept', why: 'x' }, says: "'transfer' must be {target, scope}" },
      { body: { id: TASK, gate: 'confirm', decision: 'accept', why: 'x', transfer: { target: NEXT, scope: SCOPE, note: 'no' } }, says: 'transfer.note' },
      { body: { id: TASK, gate: 'confirm', decision: 'accept', why: 'x', transfer: { target: '', scope: SCOPE } }, says: "'transfer.target' must be a non-empty string" },
      { body: { id: '', gate: 'confirm', decision: 'accept', transfer: { target: NEXT, scope: SCOPE } }, says: "'id' must be a non-empty string" },
    ];
    for (const c of cases) {
      const res = await transfer(server, c.body as Record<string, unknown>);
      expect(res.status, `${JSON.stringify(c.body)} → ${res.status}: ${res.body}`).toBe(400);
      expect(err(res.body).message).toContain(c.says);
    }
    // a shape refusal is not a write: the log is byte-identical
    expect(readFileSync(EVENTS(root, TASK), 'utf8')).toBe(before);
  });

  it('AC-5 — an UNKNOWN SUCCESSOR is refused by the engine’s name with ZERO writes (F-AC16 at write time)', { timeout: 30_000 }, async () => {
    const before = readFileSync(EVENTS(root, TASK), 'utf8');
    const res = await transfer(server, { id: TASK, gate: 'confirm', decision: 'accept', why: 'the rest goes on', transfer: { target: '01-leg/ghost', scope: SCOPE } });
    expect(res.status).toBe(500); // the engine's own refusal, not a usage error
    expect(err(res.body).code).toBe('transfer-no-target');
    expect(err(res.body).message).toContain('F-AC16');
    expect(err(res.body).message).toContain('spawn the successor first'); // the gesture that would work
    expect(readFileSync(EVENTS(root, TASK), 'utf8')).toBe(before);
  });

  it('AC-5 — an EMPTY SCOPE is refused twice over: the route’s shape gate, then the engine’s own rule', { timeout: 30_000 }, async () => {
    const before = readFileSync(EVENTS(root, TASK), 'utf8');
    // a bare empty string is what the CLI's own flag parser refuses (exit 2) — the route is a
    // thin binding, so it refuses it the same way rather than passing a value the CLI would not take
    const blank = await transfer(server, { id: TASK, gate: 'confirm', decision: 'accept', why: 'the rest goes on', transfer: { target: NEXT, scope: '' } });
    expect(blank.status).toBe(400);
    expect(err(blank.body).message).toContain("'transfer.scope' must be a non-empty string");
    // …and a WHITESPACE-ONLY scope is a real string, so it reaches the engine, which refuses it
    const spaces = await transfer(server, { id: TASK, gate: 'confirm', decision: 'accept', why: 'the rest goes on', transfer: { target: NEXT, scope: '   \n  ' } });
    expect(spaces.status).toBe(500);
    expect(err(spaces.body).code).toBe('transfer-empty-scope');
    expect(readFileSync(EVENTS(root, TASK), 'utf8')).toBe(before);
  });

  it('AC-5 — the BOUNDARY: a confirm gate with NO submission cannot transfer, and nothing is written', { timeout: 30_000 }, async () => {
    const before = readFileSync(EVENTS(root, IDLE), 'utf8');
    const res = await transfer(server, { id: IDLE, gate: 'confirm', decision: 'accept', why: 'the rest goes on', transfer: { target: NEXT, scope: 'AC-1: it is done' } });
    expect(res.status).toBe(409); // well-formed request, wrong state — the approve's busy class
    expect(err(res.body).code).toBe('transfer-not-live');
    expect(err(res.body).message).toContain('is none');
    expect(err(res.body).message).toContain(`ann submit! ${IDLE} confirm`); // the gesture that makes it legal
    // NOTHING landed — not even the auto-submit a bare `gate!` accept would have written
    expect(readFileSync(EVENTS(root, IDLE), 'utf8')).toBe(before);
    // and the task is untouched by the attempt: still waiting on its exit gate, nothing in hand
    const card = JSON.parse((await get(server.url + `/api/confirm?id=${IDLE}`)).body) as { detail: { gates: Record<string, { state: string }> } };
    expect(card.detail.gates.confirm.state).toBe('none');
  });

  it('AC-4 — the happy path: ONE call lands the accept AND the move, and every read shows the successor', { timeout: 30_000 }, async () => {
    const res = await transfer(server, { id: TASK, gate: 'confirm', decision: 'accept', why: 'the first half landed; the rest moves with it', transfer: { target: NEXT, scope: SCOPE } });
    expect(res.status, res.body).toBe(200);
    const value = JSON.parse(res.body) as { value: { gate: string; decision: string; transferred?: { target: string; scope: string }; pending?: string } };
    expect(value.value.gate).toBe('confirm');
    expect(value.value.decision).toBe('accept');
    expect(value.value.transferred).toEqual({ target: NEXT, scope: SCOPE });
    // the accept and the move are ONE write: the gate lands AND the scope moves in the same call
    expect(value.value.pending).toContain('no-evidence'); // …and the close is still its own honest gesture

    // THE FILE: the accept and the move, in the one order that reads as one act
    const log = readFileSync(EVENTS(root, TASK), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; target?: string; scope?: string });
    const tail = log.slice(-3).map((e) => e.type);
    // NO `completed`: this fixture records no evidence, so the close is refused by name
    // (`no-evidence`) rather than faked by the transfer — a transfer moves scope, it does not
    // manufacture proof. The close stays the separate explicit gesture it has always been.
    expect(tail).toEqual(['submitted', 'confirmed', 'transferred']);
    const moved = log[log.length - 1];
    expect(moved.target).toBe(NEXT);
    expect(moved.scope).toBe(SCOPE); // VERBATIM, exactly as the human wrote it
  });

  it('AC-4 — the reads after it: the moved AC is no longer an owed gap, and the successor is NAMED', { timeout: 30_000 }, async () => {
    const brief = cli(root, ['brief', TASK]).stdout;
    expect(brief).toContain('TRANSFERRED (moved to a successor — not claimed as met): AC-2 → 01-leg/02-b'); // the conclusion credits the move
    // the ONE gap left is the AC nobody claimed and nobody moved — the moved one is NOT a gap
    expect(brief).toContain('UNCLAIMED: AC-1');
    expect(brief).not.toContain('AC-1, AC-2');
    // the choice point carries the successor, so the decision reads as a move, not a bare status
    expect(cli(root, ['decisions', TASK]).stdout).toContain('scope moved to 01-leg/02-b');
    // and the journey's own integrity check is silent: the transfer is a legal record
    expect(cli(root, ['check']).stdout).not.toContain('F-AC16');
  });
});
