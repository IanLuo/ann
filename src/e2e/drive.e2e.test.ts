import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * E2E — THE SEMANTIC DRIVER OVER THE SERVICE (leg 12 task 02): `POST /api/drive`.
 *
 * The loop is exercised END TO END against a TEMP journey and a LOCAL STUB provider (a
 * small http server answering OpenAI-compatible completions with a scripted proposal —
 * no live provider call anywhere in this suite). Proven here, at the service's own
 * contract:
 *   · the model's proposal is VALIDATED against the closed set: an out-of-set name
 *     (`gate!`) comes back as a NAMED refusal and NOTHING in the journey changed;
 *   · a validated `run!` executes through the SAME command layer — the journey advances to
 *     its next human gate (the frame's own writes only: activate + the verify wait);
 *   · an OPTION-level mistake is a usage refusal (400), a GET is 405, a non-exposed name
 *     stays 404, and the body's unknown keys are refused rather than ignored;
 *   · CREDENTIALS (NFR-SEC-1): the apiKey the SERVER was started with appears in NO
 *     response body (the driver's result carries provenance — provider · model · turn ·
 *     run — never a secret) and NEVER reaches the client.
 *
 * `npm run build` first — the service is spawned as `node dist/surface/cli.js serve`.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const SECRET = 'sk-e2e-driver-secret-value';
const OLD = '2026-08-20';
const LEG = '01-alpha';
const TASK = `${LEG}/01-first`;
const CONTRACT = JSON.stringify({ intent: 'do the thing', acceptanceCriteria: ['the thing is done'], workType: 'implementation' });

/* ── the stub provider (no live call, no external network) ────────────────── */

class StubProvider {
  private server: Server;
  /** The OS-assigned port, read back from the listener (never probed for). */
  private boundPort = 0;
  private queue: string[] = [];
  readonly requests: string[] = [];
  private constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        this.requests.push(body);
        const text = this.queue.shift();
        if (text === undefined) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'the stub provider has no scripted response left' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 7, completion_tokens: 5 } }));
      });
    });
  }
  /** Bind on port 0 and READ the OS-assigned port: a probe-then-bind pair races with the
   *  other suites' servers (the workers run in parallel) and made this file flaky. */
  static async start(): Promise<StubProvider> {
    const stub = new StubProvider();
    await new Promise<void>((r) => stub.server.listen(0, '127.0.0.1', () => r()));
    stub.boundPort = (stub.server.address() as { port: number }).port;
    return stub;
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.boundPort}/v1`;
  }
  script(...responses: string[]): void {
    this.queue.push(...responses);
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/* ── the journey fixtures ─────────────────────────────────────────────────── */

const git = (root: string, args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-drive-'));
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

/** A grilled, queued `implementation` task in the front leg — a `continue-leg` derivation
 *  whose frame run needs no provider at all (the empty chain activates and waits). */
function loopJourney(root: string): void {
  const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
  for (const [id, contract, events] of [
    [LEG, JSON.stringify({ intent: 'the alpha leg (the epic)', acceptanceCriteria: ['the leg delivers'], workType: 'implementation' }), []],
    [TASK, CONTRACT, [{ at: '2026-08-27', type: 'created' }, { at: '2026-08-27', type: 'submitted', gate: 'grill' }, { at: '2026-08-27', type: 'confirmed', gate: 'grill' }]],
  ] as const) {
    mkdirSync(dir(id), { recursive: true });
    writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract: JSON.parse(contract), createdAt: '2026-08-27' }));
    if (events.length) writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'the loop fixture journey']);
}

/** Every node's raw event bytes — the zero-writes proof (a drive that wrote changes them). */
function eventsSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const legs = join(root, '.ann', 'journey', 'legs');
  for (const id of [LEG, TASK]) {
    const f = join(legs, id, 'events.jsonl');
    out[id] = existsSync(f) ? readFileSync(f, 'utf8') : '';
  }
  return out;
}

interface Server_ { url: string; child: ChildProcess; kill(): void }
async function serve(root: string, baseUrl: string): Promise<Server_> {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      ANN_PROJECT: root,
      RECORDED_BY: 'e2e',
      ANN_CONFIG: join(root, '.e2e-config.json'),
      ANN_HOST: '',
      ANN_PORT: '',
      ANN_LLM_BASE_URL: baseUrl,
      ANN_LLM_API_KEY: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr?.on('data', (c) => (err += String(c)));
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
const post = async (url: string, payload: unknown): Promise<Res> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.text() };
};

let root: string;
let stub: StubProvider;
let srv: Server_;

beforeAll(async () => {
  stub = await StubProvider.start();
  root = newProject();
  loopJourney(root);
  srv = await serve(root, stub.baseUrl);
});
afterAll(async () => {
  srv?.kill();
  await stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('POST /api/drive — the semantic driver over the service (leg 12 task 02)', () => {
  it('an out-of-set proposal (gate!) is REFUSED BY NAME and the journey is untouched', async () => {
    const before = eventsSnapshot(root);
    stub.script(JSON.stringify({ call: 'gate!', args: { id: TASK, gate: 'grill', decision: 'accept' }, reason: 'accept it for the human' }));
    const r = await post(`${srv.url}/api/drive`, {});
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { ok: boolean; value: { stop: string; refusal: { code: string; call: string; reason: string }; executed: unknown[]; routeReason: string } };
    expect(body.ok).toBe(true);
    expect(body.value.stop).toBe('refused-proposal');
    expect(body.value.refusal.code).toBe('forbidden-call');
    expect(body.value.refusal.call).toBe('gate!');
    expect(body.value.routeReason).toContain('never answer one');
    expect(body.value.executed).toEqual([]); // nothing executed
    expect(eventsSnapshot(root)).toEqual(before); // ZERO journey writes
  });

  it('the model can also just stop, and OPTION mistakes are usage refusals — never ignored', async () => {
    stub.script(JSON.stringify({ stop: 'the runner owns the next move', reason: 'nothing machine-executable' }));
    const stop = await post(`${srv.url}/api/drive`, {});
    expect(stop.status).toBe(200);
    expect((JSON.parse(stop.body) as { value: { stop: string; routeReason: string } }).value.stop).toBe('model-stop');

    expect((await post(`${srv.url}/api/drive`, { nope: 1 })).status).toBe(400);
    expect((await post(`${srv.url}/api/drive`, { maxTurns: 'many' })).status).toBe(400);
    expect((await post(`${srv.url}/api/drive`, { resume: { at: 'x' } })).status).toBe(400);
    const get = await fetch(`${srv.url}/api/drive`);
    expect(get.status).toBe(405);
    const unknown = await fetch(`${srv.url}/api/definitely-not-a-route`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('not exposed');
  });


  it('a validated run! executes through the command layer and lands at the human gate (the runner)', async () => {
    stub.script(JSON.stringify({ call: 'run!', args: { id: TASK }, reason: 'the frontmost-ready is ready and its grill gate is decided' }));
    const r = await post(`${srv.url}/api/drive`, {});
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { value: { stop: string; landing: Record<string, string>; executed: Array<{ call: string }>; checkpoint: Record<string, string>; metrics: { providerCalls: number; writes: string[] } } };
    expect(body.value.stop).toBe('human-gate');
    expect(body.value.landing).toMatchObject({ where: 'awaiting-runner', task: TASK, gate: 'confirm' });
    expect(body.value.executed.map((e) => e.call)).toEqual(['run!']);
    expect(body.value.checkpoint.task).toBe(TASK);
    // the writes are the FRAME's own (activate + the verify wait) — no gate answer, no close
    const events = readFileSync(join(root, '.ann', 'journey', 'legs', TASK, 'events.jsonl'), 'utf8');
    expect(events).toContain('"activated"');
    expect(events).toContain('"waiting"');
    expect(events).not.toContain('"completed"');
    expect((events.match(/"type":"confirmed"/g) ?? []).length).toBe(1); // only the human's grill accept
    expect(body.value.metrics.providerCalls).toBe(1);
  });

  it('the provider key appears in NO response body (NFR-SEC-1) — and the drive really talked to the provider', async () => {
    // the drives above made REAL completions against the stub: the loop is not fake at this layer
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
    // three more drives (one completion each) + every read the client can make
    stub.script(JSON.stringify({ stop: 'done', reason: 'nothing left' }));
    stub.script(JSON.stringify({ stop: 'done', reason: 'nothing left' }));
    stub.script(JSON.stringify({ stop: 'done', reason: 'nothing left' }));
    const bodies: string[] = [];
    for (const payload of [{}, { provider: 'openai-compatible' }, { maxTurns: 1 }]) {
      const r = await post(`${srv.url}/api/drive`, payload);
      expect(r.status).toBe(200);
      bodies.push(r.body);
    }
    const reads = await Promise.all(
      ['/api/journey', '/api/next', '/api/whatsnext', `/api/detail?id=${encodeURIComponent(TASK)}`, '/'].map(async (p) => (await fetch(srv.url + p)).text()),
    );
    for (const b of [...bodies, ...reads]) expect(b).not.toContain(SECRET);
    // the key reached the ADAPTER (server-side) and was never logged: the op log is the
    // run's own metrics (Q1) and carries no credential
    expect(existsSync(join(root, 'logs', 'provider.jsonl'))).toBe(true);
    expect(readFileSync(join(root, 'logs', 'provider.jsonl'), 'utf8')).not.toContain(SECRET);
  });
});
