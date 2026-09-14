import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

/**
 * E2E — THE MINIMAL SERVICE + UI (the goal's AC-1). The service is a THIN BINDING over
 * the SAME command layer the CLI uses, so the proof is a comparison: for each exposed
 * read, the HTTP body is BYTE-IDENTICAL to what `ann <cmd> --json` prints for the same
 * journey state (one state, two bindings, zero drift). Then: the whole-journey gate
 * queue covers undecided submissions the active-leg look-back scopes away; the
 * configured LLM apiKey appears in NO response body; the request path assumes no host
 * (remote-capable in shape); the non-slice commands are not exposed; and a gate decision
 * made through the UI's OWN HTTP contract lands as the journey's gate event (the same L1
 * `gate!` write) with the view reflecting it after a re-read.
 *
 * HARNESS LEVEL (recorded on the task, never assumed): the UI round-trip is proven at
 * THE PAGE'S HTTP CONTRACT — the exact requests the served page makes (`GET /api/journey`
 * · `/api/gates` · `/api/confirm?id=` · `POST /api/gate`), driven here with real HTTP
 * against the served script, whose syntax is checked with `node --check`. NOT a DOM run
 * (no browser/happy-dom): the page's rendering is not asserted, only that the requests it
 * issues are the ones that land the decision and that the re-read reflects it.
 *
 * `npm run build` first — the service is spawned as `node dist/surface/cli.js serve`.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };
/** The credential we plant server-side: it must never reach a response body. */
const API_KEY = 'sk-e2e-service-must-not-leak-0123456789';

const LEG1 = '01-alpha';
const T1 = '01-alpha/01-a'; // done, and carrying a STRAY undecided grill submission
const LEG2 = '02-beta';
const T2 = '02-beta/01-a'; // the UI's round-trip target: submitted at grill, undecided
const T3 = '02-beta/02-b'; // the CLI's write-parity target: the same gate, undecided
const CONTRACT = (intent: string) => JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`] });

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
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-serve-'));
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

/**
 * The journey the assertions share: leg 01 COMPLETE (task done, docs committed,
 * evidence recorded) and then carrying a stray undecided grill submission — a done task
 * never re-derives blocked, so leg 01 stays done and that gate is INVISIBLE to the
 * active-leg look-back; leg 02 ACTIVE with two tasks submitted at the grill gate.
 */
function driveJourney(root: string): void {
  cli(root, ['spawn!', LEG1, CONTRACT('the alpha leg')]);
  cli(root, ['spawn!', T1, CONTRACT('do the alpha thing')]);
  cli(root, ['submit!', T1, 'grill']);
  cli(root, ['gate!', T1, 'grill', 'accept', 'looks right']);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe actual deliverable\n');
  cli(root, ['docs', '--write']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'stage the deliverable']);
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // v18 + leg 12/03: complete! requires a structured conclusion — a claim per AC MAPPED to
  // a check the log holds, and at least one CAPTURED pass bound to the cited commit (the
  // capture really RUNS `ann verify` against the fixture journey)
  cli(root, ['capture!', T1, 'ann verify']);
  cli(root, [
    'evidence!',
    T1,
    sha,
    '--note',
    'committed',
    '--claims',
    JSON.stringify([{ ac: 'AC-1', check: 'ann verify', evidence: [sha] }]),
  ]);
  cli(root, ['submit!', T1, 'confirm']);
  cli(root, ['gate!', T1, 'confirm', 'accept', 'done']); // the accept closes it — the evidence is already in the log
  // the STRAY submission that hides in a done leg (status stays `done`)
  cli(root, ['submit!', T1, 'grill']);
  // leg 02 — the active leg, with two undecided grill submissions
  cli(root, ['spawn!', LEG2, CONTRACT('the beta leg')]);
  cli(root, ['spawn!', T2, CONTRACT('do the beta thing')]);
  cli(root, ['submit!', T2, 'grill']);
  cli(root, ['spawn!', T3, CONTRACT('do the other beta thing')]);
  cli(root, ['submit!', T3, 'grill']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'the fixture journey']);
}

interface Server { url: string; host: string; port: number; child: ChildProcess; kill(): void }

/** Start `ann serve` and resolve once it announces its bound endpoint. */
async function serve(root: string, args: string[] = [], env: Record<string, string> = {}): Promise<Server> {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...HERMETIC,
      ANN_PROJECT: root,
      RECORDED_BY: 'e2e',
      ANN_CONFIG: join(root, '.e2e-config.json'),
      ANN_LLM_API_KEY: API_KEY,
      // the bind's env layer is BLANKED unless a caller sets it — the dev shell's
      // ANN_HOST/ANN_PORT must not decide what this suite proves
      ANN_HOST: '',
      ANN_PORT: '',
      ...env,
    },
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
  const parsed = new URL(url);
  return { url, host: parsed.hostname, port: Number(parsed.port), child, kill: () => child.kill() };
}

interface Res { status: number; body: string }
const get = async (url: string, headers: Record<string, string> = {}): Promise<Res> => {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.text() };
};
const post = async (url: string, payload: unknown): Promise<Res> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.text() };
};
/** A raw http.request — used where `fetch` refuses a header (Host is forbidden there). */
const rawRequest = (url: string, headers: Record<string, string>): Promise<Res> =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('e2e — the minimal service + UI (AC-1: the thin binding over the command layer)', () => {
  let root: string;
  let server!: Server;

  beforeAll(async () => {
    root = newProject();
    driveJourney(root);
    server = await serve(root, ['--port', '0']); // port 0 → the OS picks; the handle reports it
  }, 60_000);

  afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('every exposed read is byte-identical to the CLI --json value for the same state', { timeout: 30_000 }, async () => {
    const matrix: Array<{ route: string; argv: string[] }> = [
      { route: '/api/journey', argv: ['journey'] },
      { route: '/api/status', argv: ['status'] },
      { route: '/api/status?filter=02-beta', argv: ['status', '02-beta'] },
      { route: '/api/next', argv: ['next'] },
      { route: `/api/detail?id=${T2}`, argv: ['detail', T2] },
      { route: `/api/confirm?id=${T2}`, argv: ['confirm', T2] },
      { route: `/api/results?id=${T2}`, argv: ['results', T2] },
      { route: `/api/results?id=${T1}&n=1`, argv: ['results', T1, '1'] }, // the DRILL index (a commit's `git show`)
      { route: `/api/packet?id=${T2}`, argv: ['packet', T2] },
      { route: `/api/events?id=${T2}`, argv: ['events', T2] },
      { route: `/api/events?id=${T2}&n=2`, argv: ['events', T2, '2'] },
    ];
    for (const { route, argv } of matrix) {
      const cliJson = cli(root, ['--json', ...argv]);
      expect(cliJson.code, `ann --json ${argv.join(' ')} exited ${cliJson.code}: ${cliJson.stderr.trim()}`).toBe(0);
      const res = await get(server.url + route);
      expect(res.status, `GET ${route} → ${res.status}: ${res.body.slice(0, 200)}`).toBe(200);
      // BYTE-identical: the service answers the document the CLI prints, not a near-miss
      expect(res.body, `GET ${route} !== ann --json ${argv.join(' ')}`).toBe(cliJson.stdout);
      expect(JSON.parse(res.body)).toEqual(JSON.parse(cliJson.stdout));
    }
  });

  it('the whole-journey gate queue covers what the active-leg look-back scopes away', { timeout: 30_000 }, async () => {
    const gates = await get(server.url + '/api/gates');
    expect(gates.status).toBe(200);
    const rows = JSON.parse(gates.body) as Array<{ task: string; gate: string; role: string; leg: string; intent: string; delivered: { commits: number; claims: number; checks: number; bound: number } }>;
    expect(rows.map((r) => `${r.task}@${r.gate}`)).toEqual([`${T1}@grill`, `${T2}@grill`, `${T3}@grill`]); // T1 hidden: leg 01 derives done, the task stays done
    // every row says WHICH STEP it is: the role, the leg, the task's own intent, what is delivered
    for (const r of rows) {
      expect(r.role).toBe('entry'); // the grill gate is the entry step
      expect(r.leg).toBe(r.task.split('/')[0]);
      expect(r.intent.length).toBeGreaterThan(0);
    }
    // …and what is DELIVERED at that gate: T1 was completed (a full v18 conclusion on the
    // log), T2/T3 are merely submitted — so the queue can tell "review the contract" from
    // "the work is already here"
    expect(rows[0].delivered).toEqual({ commits: 1, claims: 1, unclaimed: 0, checks: 1, bound: 1 });
    expect(rows[1].delivered).toEqual({ commits: 0, claims: 0, unclaimed: 1, checks: 0, bound: 0 });
    // the CLI's own look-back sees only the ACTIVE leg's — the reason /api/gates exists
    const next = JSON.parse(cli(root, ['--json', 'next']).stdout) as { lookBack: { activeLeg: string; pendingGates: unknown[] } };
    expect(next.lookBack.activeLeg).toBe(LEG2);
    expect(next.lookBack.pendingGates).toEqual([{ task: T2, gate: 'grill' }, { task: T3, gate: 'grill' }]);
  });

  it('the configured apiKey appears in NO response body — and the credential-bearing reads are not exposed (NFR-SEC-1)', { timeout: 30_000 }, async () => {
    // The key the SERVER was started with (plus any already in this process's env, so the
    // sweep cannot be defeated by an inherited value).
    const secrets = [API_KEY, process.env.ANN_LLM_API_KEY].filter((s): s is string => !!s);
    expect(secrets).toContain(API_KEY);
    const bodies: Array<{ what: string; body: string }> = [];
    for (const route of ['/', '/api/journey', '/api/status', '/api/next', '/api/gates', `/api/confirm?id=${T2}`, `/api/detail?id=${T2}`, `/api/results?id=${T2}`, `/api/packet?id=${T2}`, `/api/events?id=${T2}`, '/api/run', '/api/config', '/api/providers']) {
      const res = await get(server.url + route);
      bodies.push({ what: `GET ${route}`, body: res.body });
    }
    bodies.push({ what: 'POST /api/gate (usage)', body: (await post(server.url + '/api/gate', {})).body });
    for (const { what, body } of bodies) {
      for (const secret of secrets) expect(body, `${what} leaked the configured apiKey`).not.toContain(secret);
    }
    // the reads that CARRY settings (masked or not) are outside the slice: refused by name
    for (const route of ['/api/run', '/api/config', '/api/providers', '/api/spawn!', '/api/advance!']) {
      const res = await get(server.url + route);
      expect(res.status, `${route} must not be exposed`).toBe(404);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('not-exposed');
    }
  });

  it('binds 127.0.0.1 by default, takes host/port from ANN_HOST/ANN_PORT, and assumes no host in the request path', { timeout: 30_000 }, async () => {
    expect(server.host).toBe('127.0.0.1'); // no --host, no ANN_HOST → the default
    // a Host header naming a remote server changes nothing (nothing in the path reads it)
    const remote = await rawRequest(server.url + '/api/journey', { Host: 'ann.example.com:443' });
    expect(remote.status).toBe(200);
    expect(remote.body).toBe(cli(root, ['--json', 'journey']).stdout);
    // the env knobs: ANN_HOST/ANN_PORT win over the defaults (0 = the OS picks the port)
    const fromEnv = await serve(root, [], { ANN_HOST: '0.0.0.0', ANN_PORT: '0' });
    try {
      expect(fromEnv.host).toBe('0.0.0.0');
      expect(fromEnv.port).toBeGreaterThan(0);
      expect(fromEnv.port).not.toBe(8787);
      const res = await get(`http://127.0.0.1:${fromEnv.port}/api/status`);
      expect(res.status).toBe(200);
    } finally {
      fromEnv.kill();
    }
  });

  it('the BIND also comes from the GENERAL CONFIG class (project registry · user overlay · config!)', { timeout: 30_000 }, async () => {
    const cfgRoot = newProject();
    const registry = join(cfgRoot, '.ann', 'rules', 'config', 'default.json');
    try {
      // 1. the PROJECT registry (rules/config/default.json) sets the bind — no flags, no env
      writeFileSync(
        registry,
        JSON.stringify({ flow: { conditionals: true, verifyFailCycles: 1 }, preferences: { askVsAssume: 'ask', defaults: {} }, server: { host: '127.0.0.1', port: 0 } }, null, 2) + '\n',
      );
      const fromRegistry = await serve(cfgRoot, []);
      try {
        expect(fromRegistry.host).toBe('127.0.0.1');
        expect(fromRegistry.port).toBeGreaterThan(0);
        expect(fromRegistry.port).not.toBe(8787); // 0 = the OS picked it, not the builtin floor
        expect((await get(`http://127.0.0.1:${fromRegistry.port}/api/journey`)).status).toBe(200);
      } finally {
        fromRegistry.kill();
      }
      const resolved = JSON.parse(cli(cfgRoot, ['--json', 'config']).stdout) as { config: { server: { host: string; port: number } }; provenance: Record<string, string> };
      expect(resolved.config.server).toEqual({ host: '127.0.0.1', port: 0 });
      expect(resolved.provenance['server.port']).toBe('project');

      // 2. the USER overlay (the fixture's ANN_CONFIG) overrides the registry leaf
      writeFileSync(join(cfgRoot, '.e2e-config.json'), JSON.stringify({ server: { port: 0 } }));
      const overlaid = JSON.parse(cli(cfgRoot, ['--json', 'config']).stdout) as { provenance: Record<string, string> };
      expect(overlaid.provenance['server.port']).toBe('user');

      // 3. `ann config! set server.port` writes that overlay — the knob is user-settable,
      //    and a bad value is refused BY NAME (fail-closed, never clamped)
      const set = cli(cfgRoot, ['--json', 'config!', 'set', 'server.port', '9123']);
      expect(set.code, set.stderr).toBe(0);
      const after = JSON.parse(cli(cfgRoot, ['--json', 'config']).stdout) as { config: { server: { port: number } }; provenance: Record<string, string> };
      expect(after.config.server.port).toBe(9123);
      expect(after.provenance['server.port']).toBe('user');
      const bad = cli(cfgRoot, ['--json', 'config!', 'set', 'server.port', 'sea']);
      expect(bad.code).toBe(1);
      expect((JSON.parse(bad.stdout) as { error: { code: string } }).error.code).toBe('config-value');

      // 4. and an unusable bind fails CLOSED at serve (named), never a silent fall-back
      writeFileSync(registry, JSON.stringify({ server: { host: 'http://0.0.0.0:8787' } }) + '\n');
      const refused = cli(cfgRoot, ['serve', '--port', '0']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('serve refuses');
      expect(refused.stderr).toContain('no scheme, port, or path');
    } finally {
      rmSync(cfgRoot, { recursive: true, force: true });
    }
  });

  it('the UI page is served, its script is valid JS, and it names the routes it uses', { timeout: 30_000 }, async () => {
    const page = await get(server.url + '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Waiting on you'); // the gate-queue view
    expect(page.body).toContain('The journey'); // the journey view
    expect(page.body).toContain('Gate card'); // the gate card
    expect(page.body).not.toContain('innerHTML'); // data is rendered as text, never as markup
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(0);
    for (const route of ['/api/journey', '/api/gates', '/api/confirm?id=', '/api/gate']) expect(script).toContain(route);
    // …and the page names the STEP each gate is (the reason /api/gates carries role/intent/delivered)
    for (const word of ['ENTRY', 'EXIT', 'the contract gate', 'the result gate', 'delivered: ', 'NO CLAIM RECORDED', 'PASS  ']) expect(script, `the served page lost '${word}'`).toContain(word);
    // …and the card tells the TRUTH about the node: the decision UI exists only for a
    // gate that is genuinely submitted, a stale click is refused before it writes, the
    // card always says what the task waits for, and the view refreshes itself
    for (const word of ['card-decide', 'stale — the ', 'nothing was written', 'next: ', 'as of ', 'Refresh', 'decided already', 'the entry (grill) gate has not been submitted yet'])
      expect(script, `the served page lost its state-truth guard: '${word}'`).toContain(word);
    // the page must be runnable JS: `node --check` parses it (no browser needed)
    const checkDir = mkdtempSync(join(tmpdir(), 'ann-ui-check-'));
    const checkFile = join(checkDir, 'ui-page.js');
    writeFileSync(checkFile, script);
    const checked = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
    expect(checked.status, `the served page script does not parse: ${checked.stderr}`).toBe(0);
    rmSync(checkDir, { recursive: true, force: true });
    // a non-API path is a plain 404, and an unknown method on a read is refused
    expect((await get(server.url + '/nope')).status).toBe(404);
    expect((await post(server.url + '/api/status', {})).status).toBe(405);
  });

  it('a decision made through the page\'s own HTTP contract lands as the journey\'s gate event', { timeout: 30_000 }, async () => {
    // the state BEFORE: T2 waits at the grill gate (the queue + the node's derived status)
    expect((JSON.parse((await get(server.url + '/api/gates')).body) as Array<{ task: string }>).map((r) => r.task)).toEqual([T1, T2, T3]);
    const before = JSON.parse((await get(server.url + `/api/journey`)).body) as { legs: Array<{ id: string; tasks: Array<{ id: string; status: string }> }> };
    expect(before.legs.find((l) => l.id === LEG2)?.tasks.find((t) => t.id === T2)?.status).toBe('blocked');

    // the card the page loads for the queue row it clicked
    const card = await get(server.url + `/api/confirm?id=${encodeURIComponent(T2)}`);
    expect(card.status).toBe(200);
    expect((JSON.parse(card.body) as { detail: { contract: { intent: string } } }).detail.contract.intent).toBe('do the beta thing');

    // the CLI's own write of the SAME decision on the sibling task — the write-doc parity baseline
    const cliWrite = cli(root, ['--json', 'gate!', T3, 'grill', 'accept', 'ui card decision']);
    expect(cliWrite.code).toBe(0);

    // …and the page's write, exactly as its script issues it
    const posted = await post(server.url + '/api/gate', { id: T2, gate: 'grill', decision: 'accept', feedback: 'ui card decision' });
    expect(posted.status).toBe(200);
    expect(posted.body).toBe(cliWrite.stdout); // the SAME write document the CLI printed
    expect(JSON.parse(posted.body)).toEqual({ ok: true, value: { gate: 'grill', decision: 'accept', escalated: false } });

    // the DECISION LANDED AS THE GATE EVENT (read back through the CLI's own walk of the log)
    const walk = JSON.parse(cli(root, ['--json', 'journey', T2]).stdout) as { events: Array<{ type: string; gate?: string; feedback?: string }> };
    const confirmed = walk.events.find((e) => e.type === 'confirmed' && e.gate === 'grill');
    expect(confirmed?.feedback).toBe('ui card decision');

    // …and the VIEW reflects it after the re-read (the queue loses the row; the status moves)
    const after = JSON.parse((await get(server.url + '/api/gates')).body) as Array<{ task: string; gate: string }>;
    expect(after.map((r) => `${r.task}@${r.gate}`)).toEqual([`${T1}@grill`]); // T2 decided, T3 decided by the CLI — only the hidden one waits
    const journey = JSON.parse((await get(server.url + '/api/journey')).body) as { legs: Array<{ id: string; tasks: Array<{ id: string; status: string }> }> };
    expect(journey.legs.find((l) => l.id === LEG2)?.tasks.find((t) => t.id === T2)?.status).toBe('queued');
    const cardAfter = JSON.parse((await get(server.url + `/api/confirm?id=${T2}`)).body) as { detail: { gates: { grill: { state: string } } } };
    expect(cardAfter.detail.gates.grill.state).toBe('accepted');
  });

  it('serve refuses --json (a daemon has no one-document answer)', () => {
    const r = cli(root, ['--json', 'serve']);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout.trim()) as { error: { code: string; message: string } };
    expect(doc.error.code).toBe('serve-daemon');
    expect(doc.error.message).toContain('LONG-RUNNING');
  });

  it('the journey the service served stayed CLEAN — the flow is check/verify-clean (AC-5 context)', { timeout: 30_000 }, () => {
    const check = cli(root, ['--json', 'check']);
    expect(check.code, check.stderr).toBe(0);
    const verify = cli(root, ['--json', 'verify']);
    expect(verify.code, verify.stderr).toBe(0);
    expect(JSON.parse(verify.stdout)).toEqual({ drifts: [], count: 0 });
  });
});

/**
 * E2E — THE DEFERRED SURFACE OVER HTTP (leg 12 task 01). A deferred task closes its leg,
 * so it is neither a ready task nor a gate: the service's journey route must still carry
 * the obligation, and the served page must ship the section it renders into. The route is
 * the page's OWN read (the `ahead.deferred` rows), so the page shows what is outstanding
 * rather than only what is gated; the DOM rendering of those rows is pinned in the
 * ui-drill unit (this suite asserts the HTTP contract, never a DOM).
 */
describe('e2e — the DEFERRED surface in the service + the served page (leg 12 task 01)', () => {
  let root!: string;
  let server!: Server;
  const DLEG = '01-spec-fidelity';
  const DTASK = '01-spec-fidelity/01-validate-decision-forks';
  const REASON =
    "deferred: the goal's server/UI slice takes priority — the D1-D11 design-fidelity decisions remain recorded in .agents/plan/design-fidelity-plan.md; this leg's work returns as its own later epic";

  beforeAll(async () => {
    root = newProject();
    cli(root, ['spawn!', DLEG, CONTRACT('the fidelity leg')]);
    cli(root, ['spawn!', DTASK, CONTRACT('decide the forks')]);
    cli(root, ['append!', DTASK, JSON.stringify({ at: '2026-09-11', type: 'deferred', reason: REASON, note: 'deferred by the operator' })]);
    // the journey moves ON — a later leg with a queued task (so the state line is not empty)
    cli(root, ['spawn!', LEG2, CONTRACT('the beta leg')]);
    cli(root, ['spawn!', T2, CONTRACT('do the beta thing')]);
    server = await serve(root, ['--port', '0']);
  }, 60_000);

  afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('the journey + next routes carry the deferred rows, byte-equal to the CLI --json', { timeout: 30_000 }, async () => {
    const expected = [{ task: DTASK, leg: DLEG, since: '2026-09-11', reason: REASON, plan: '.agents/plan/design-fidelity-plan.md' }];
    for (const [route, argv] of [['/api/journey', 'journey'], ['/api/next', 'next']] as const) {
      const res = await get(server.url + route);
      expect(res.status, `GET ${route} → ${res.status}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(res.body).toBe(cli(root, ['--json', argv]).stdout); // one state, two bindings, zero drift
    }
    const j = JSON.parse((await get(server.url + '/api/journey')).body) as { ahead: { deferred: unknown[]; activeLeg: string } };
    expect(j.ahead.deferred).toEqual(expected);
    expect(j.ahead.activeLeg).toBe(LEG2); // the deferred leg derived done — the next leg is the active one
    const n = JSON.parse((await get(server.url + '/api/next')).body) as { lookBack: { deferred: unknown[] } };
    expect(n.lookBack.deferred).toEqual(expected);
    // the deferred SEMANTICS are unchanged: the task closed its leg, and it is no gate
    const status = JSON.parse(cli(root, ['--json', 'status', DLEG]).stdout) as Array<{ id: string; status: string }>;
    expect(status).toEqual([
      { id: DLEG, status: 'done', superseded: false },
      { id: DTASK, status: 'deferred', superseded: false },
    ]);
    expect(JSON.parse((await get(server.url + '/api/gates')).body)).toEqual([]);
  });

  it('the served page ships the deferred section and renders it from the journey route', { timeout: 30_000 }, async () => {
    const page = await get(server.url + '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="deferred"'); // the list the rows render into
    expect(page.body).toContain('id="deferred-head"'); // the heading, shown only when rows exist
    expect(page.body).toContain('Deferred — still owing');
    expect(page.body).toContain('renderDeferred((r[0].doc.ahead || {}).deferred)'); // fed by the journey route
  });
});
