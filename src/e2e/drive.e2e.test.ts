import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
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
/** A SECOND ready task — never activated by the other tests, so the frame RUNS and WRITES
 *  (activate + the verify wait) when the multi-layer test drives it. */
const TASK2 = `${LEG}/02-second`;
/** A THIRD ready task — driven only by the PAGE-FLOW test (declared last, so every earlier
 *  test reads the journey it was written against). It keeps a continuable, executable card
 *  available to the page's own flow: once the runs above have written, the other two tasks
 *  wait on the runner and the derivation is no longer machine-executable. */
const TASK3 = `${LEG}/03-third`;
const CONTRACT = JSON.stringify({ intent: 'do the thing', acceptanceCriteria: ['the thing is done'], workType: 'implementation' });

/* ── the stub provider (no live call, no external network) ────────────────── */

class StubProvider {
  private server: Server;
  /** The OS-assigned port, read back from the listener (never probed for). */
  private boundPort = 0;
  private queue: string[] = [];
  /** The OPT-IN REPLY BRAKE, in ms (0 = no delay: every test that does not ask for it is
   *  unaffected). Set by `hold()` so a caller can keep a run INSIDE its provider call. */
  private holdMs = 0;
  readonly requests: string[] = [];
  private constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        void this.reply(body, res);
      });
    });
  }
  /** The reply, after the brake. The RECEIPT (`requests`) is recorded FIRST: a caller
   *  waiting on it proves the request reached the provider, so the run that made it is in
   *  flight over there whatever the scheduler is doing. */
  private async reply(body: string, res: ServerResponse): Promise<void> {
    this.requests.push(body);
    const text = this.queue.shift();
    if (this.holdMs) await new Promise((r) => setTimeout(r, this.holdMs));
    if (text === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'the stub provider has no scripted response left' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 7, completion_tokens: 5 } }));
  }
  /** THE BRAKE (the drive-busy probe's fixture, not a timing hope): the stub's replies wait
   *  `ms` before they are written, so a run can be held awaiting the PROVIDER while a second
   *  request lands — long enough that the overlap is a fact of the fixture. Reset to 0 by
   *  whoever set it (the brake is a property of the stub, so it is never left on). */
  hold(ms: number): void {
    this.holdMs = ms;
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
    [TASK2, CONTRACT, [{ at: '2026-08-27', type: 'created' }, { at: '2026-08-27', type: 'submitted', gate: 'grill' }, { at: '2026-08-27', type: 'confirmed', gate: 'grill' }]],
    [TASK3, CONTRACT, [{ at: '2026-08-27', type: 'created' }, { at: '2026-08-27', type: 'submitted', gate: 'grill' }, { at: '2026-08-27', type: 'confirmed', gate: 'grill' }]],
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
const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  expect(r.status, `GET ${url} → ${r.status}`).toBe(200);
  return JSON.parse(await r.text()) as T;
};
/** Poll a condition until it holds. The concurrency probe waits on a FACT (the provider
 *  RECEIVED the call), never on a sleep: the poll only bounds how long that fact may take. */
const waitFor = async (cond: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return cond();
};

/** EVERY node's raw event bytes under a journey — the zero-writes proof for the SECOND
 *  fixtures, whose node ids this file does not name up front (the shared `eventsSnapshot`
 *  covers the loop fixture's own two ids). Keys are journey-relative, so a node that
 *  APPEARED also shows up as a new key, not only as changed bytes. */
function allEventBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const legs = join(root, '.ann', 'journey', 'legs');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, 'node.json'))) {
        const f = join(p, 'events.jsonl');
        out[p.slice(legs.length + 1)] = existsSync(f) ? readFileSync(f, 'utf8') : '';
      }
      walk(p);
    }
  };
  walk(legs);
  return out;
}

/** A HAND-WRITTEN fixture journey (the whats-next file's own pattern, `fixtureProject`): the
 *  boundary SHAPES are PRE-STATES a drive cannot reach (an empty front leg after a done one),
 *  and the tree is COMMITTED with no ledger and no docs — so `GET /api/integrity` reads it
 *  clean, which is what the dirty-state test needs as its baseline. */
function fixtureProject(nodes: Record<string, { contract: unknown; createdAt: string; events: Array<Record<string, unknown>> }>): string {
  const root = newProject();
  for (const [id, n] of Object.entries(nodes)) {
    const dir = join(root, '.ann', 'journey', 'legs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract: n.contract, createdAt: n.createdAt }));
    if (n.events.length) writeFileSync(join(dir, 'events.jsonl'), n.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'the fixture journey']);
  return root;
}

/** The WHAT'S NEXT card's read, narrowed to what the page's drive affordance reads off it
 *  (`driveEnablement` in ui.ts: the derivation, the frontmost, `executable`). */
interface WhatsNext {
  advance: { leg: string; action: string; detail: string };
  frontmost?: { leg: string; task: string; status: string };
  executable: boolean;
}

/** The LAZY integrity snapshot (`GET /api/integrity`) — the SAME fail-closed pre-check the
 *  approve refuses on, which the card's `dirty` state and its blocker list come from. */
interface IntegritySnapshot {
  clean: boolean;
  blockers: string[];
}

/** The driver's own result, as `POST /api/drive` returns it in `value` — the fields the page
 *  renders (`renderDrive` · `renderDraft` in ui.ts) plus the draft's declared shape. */
interface DriveValue {
  stop: string;
  routeReason: string;
  turns: number;
  provider: string;
  model?: string;
  runId: string;
  executed: Array<{ turn: number; call: string; wrote: string[] }>;
  refusal?: { code: string; call: string; reason: string };
  draft?: {
    label: string;
    provenance: { model: string; provider: string; turn: number; runId: string; at: string };
    kind: string;
    id: string;
    contract: Record<string, unknown>;
    groundedOn: string[];
    rationale: string;
    approve: { act: string; id: string; contract: Record<string, unknown>; then: string };
  };
  presented: string[];
}

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
    const opLog = readFileSync(join(root, 'logs', 'provider.jsonl'), 'utf8');
    expect(opLog).not.toContain(SECRET);
    // …and every model call carries the DRIVER RUN's correlation id (leg 12/05), so the
    // provider view joins the operational view: one `--run` spans turns, phases and calls
    const opLines = opLog.trim().split('\n').map((l) => JSON.parse(l) as { runId?: string });
    expect(opLines.length).toBeGreaterThan(0);
    expect(opLines.every((l) => /^drive-/.test(String(l.runId)))).toBe(true);
  });
});

describe('THE MULTI-LAYER TRACE (leg 12/05 rework) — one chain, every layer, in order', () => {
  /** The CLI's own `ann log` read — the timeline a reader sees, not a test-side assembly. */
  const readTrace = (traceId: string, extra: string[] = []): { lines: LogLine[]; traces: number; filtered: number } =>
    JSON.parse(
      spawnSync(process.execPath, [CLI, 'log', '--json', '--trace', traceId, ...extra, '--tail', '1000'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ANN_PROJECT: root, ANN_CONFIG: join(root, '.e2e-config.json') },
      }).stdout,
    ) as { lines: LogLine[]; traces: number; filtered: number };

  it('reconstructs request → drive turn → frame phases → writes → the provider call, by traceId + layer + seq', async () => {
    // ONE drive whose `run!` executes the frame on a task NEVER activated before, so the
    // frame really writes — the chain is real, not assembled by hand
    stub.script(JSON.stringify({ call: 'run!', args: { id: TASK2 }, reason: 'the frontmost-ready is ready' }));
    const r = await post(`${srv.url}/api/drive`, {});
    expect(r.status).toBe(200);

    const raw = readFileSync(join(root, 'logs', 'operation.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine);
    const req = raw.filter((l) => l.command === 'POST /api/drive').pop()!;
    const traceId = String(req.traceId);
    const page = readTrace(traceId);
    const chain = page.lines;

    // ONE CHAIN: everything the request caused is inside it, and the read agrees
    expect(page.traces).toBe(1);
    expect(chain.length).toBeGreaterThan(10); // request + turn + phases + writes + store
    expect(chain.length).toBeLessThan(raw.length); // …and it is not the whole file

    // WHICH LAYER · WHICH COMPONENT: the surface took the request, flow drove and ran the
    // frame, the command layer wrote, the store committed — all four layers, ONE chain
    expect(new Set(chain.map((l) => l.layer))).toEqual(new Set(['L3', 'L2', 'L1', 'L0']));
    const components = new Set(chain.map((l) => String(l.component)));
    expect(components).toContain('surface/service');
    expect(components).toContain('flow/semantic-driver#turn');
    expect([...components].some((c) => c.startsWith('flow/frame'))).toBe(true);
    expect(components).toContain('commands');
    expect(components).toContain('store');

    // WHERE IN TIME: the read is the chain's own order — 1..N, no gap, no repeat — and it
    // is a CAUSE→EFFECT order: the entry (its place reserved when the request opened, its
    // line written when it closed) first, then the turn, the phases, the writes, the store
    expect(chain.map((l) => Number(l.seq))).toEqual(Array.from({ length: chain.length }, (_, i) => i + 1));
    const story = chain.map((l) => `${l.layer}:${String(l.component)}${l.phase ? `#${String(l.phase)}` : ''}`);
    expect(story[0]).toBe('L3:surface/service');
    const turnAt = story.findIndex((o) => o.startsWith('L2:flow/semantic-driver#turn'));
    const firstPhase = story.findIndex((o) => o.startsWith('L2:flow/frame'));
    const firstWrite = story.findIndex((o) => o === 'L1:commands');
    const firstStore = story.findIndex((o) => o === 'L0:store');
    expect(turnAt).toBeGreaterThan(0);
    expect(turnAt).toBeLessThan(firstPhase); // the turn asked for the call…
    expect(firstPhase).toBeLessThan(firstWrite); // …the frame ran its phases…
    expect(firstPhase).toBeLessThan(firstStore); // …and only then did bytes land
    expect(firstWrite).toBeGreaterThan(-1);
    expect(story).toContain('L2:flow/frame#verify'); // the phases are named, not just counted
    expect(chain.some((l) => l.event === 'stop' && String(l.component) === 'flow/frame')).toBe(true);

    // THE NESTING: spanId/parentSpanId link the chain as a tree — the request is the root,
    // the drive span its child, every span id in the trace belongs to a line in the trace
    const bySpan = new Map(chain.map((l) => [String(l.spanId), l]));
    expect(req.parentSpanId).toBeUndefined(); // the request is the chain's root span
    const driveSpan = chain.find((l) => l.event === 'stop' && l.component === 'flow/semantic-driver')!;
    const turnSpan = chain.find((l) => l.event === 'turn')!;
    const frameSpan = chain.find((l) => l.event === 'stop' && l.component === 'flow/frame')!;
    const phaseSpan = chain.find((l) => String(l.component).startsWith('flow/frame#'))!;
    // request → the drive → the turn → the frame → its phases: each nested in its cause
    expect(driveSpan.parentSpanId).toBe(String(req.spanId));
    expect(turnSpan.parentSpanId).toBe(String(driveSpan.spanId));
    expect(frameSpan.parentSpanId).toBe(String(turnSpan.spanId));
    expect(phaseSpan.parentSpanId).toBe(String(frameSpan.spanId));
    // every parent span id belongs to a line in the chain — no dangling links
    for (const l of chain) if (l.parentSpanId !== undefined) expect(bySpan.has(String(l.parentSpanId))).toBe(true);

    // THE PROVIDER CALL joins the SAME chain: the op-log line carries this traceId, so the
    // model call is the leaf of this timeline (the abilities layer's own record)
    const opLines = readFileSync(join(root, 'logs', 'provider.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { traceId?: string; at: string });
    expect(opLines[opLines.length - 1].traceId).toBe(traceId);

    // THE LAYER FILTER narrows the same chain: L2 only, still in order
    const flowOnly = readTrace(traceId, ['--layer', 'L2']);
    expect(flowOnly.lines.length).toBeGreaterThan(0);
    expect(flowOnly.lines.length).toBeLessThan(chain.length);
    expect(flowOnly.lines.every((l) => l.layer === 'L2')).toBe(true);
  });
});

describe('THE DRIVE-BUSY REFUSAL — the ONE operate-loop slot, claimed before the first await (leg 12/04)', () => {
  it('two concurrent POST /api/drive: exactly one 200 and one 409 drive-busy, the refusal INSIDE the first run', async () => {
    const before = stub.requests.length;
    // THE OVERLAP IS THE FIXTURE, NOT THE SCHEDULER. The stub's brake holds the reply to the
    // first drive's provider call for a second, and the second request is fired only after
    // the stub has RECEIVED that call — its receipt proves the loop is inside the provider
    // call, so the route's synchronous claim is already taken. No sleep decides the race.
    stub.hold(1_000);
    stub.script(JSON.stringify({ stop: 'nothing machine-executable', reason: 'the slot probe reached the provider' }));
    const first = post(`${srv.url}/api/drive`, {});
    try {
      expect(await waitFor(() => stub.requests.length > before)).toBe(true); // the run is IN the provider call
      const second = await post(`${srv.url}/api/drive`, {});
      expect(second.status).toBe(409);
      // the refusal is the route's own error doc: `{error: {code, message}}` — the daemon's
      // named refusal, the same shape every refused command ships
      const refused = JSON.parse(second.body) as { error: { code: string; message: string } };
      expect(refused.error.code).toBe('drive-busy');
      expect(refused.error.message).toContain('ONE operate-loop action at a time');
      // the refused drive never reached the provider: ONE completion for TWO requests
      expect(stub.requests.length).toBe(before + 1);
      const ran = await first; // the holder finishes normally when the brake lifts
      expect(ran.status).toBe(200);
      expect((JSON.parse(ran.body) as { value: { stop: string } }).value.stop).toBe('model-stop');
    } finally {
      stub.hold(0); // the brake is opt-in per test — never left on for the tests below
      // …and no run is left IN FLIGHT across a test boundary: the slot is one, and a holder
      // abandoned by a failing assertion would refuse the NEXT test's drive, not its own.
      await first.catch(() => {});
    }
  });
});

describe("THE PAGE'S OWN DRIVE FLOW over real HTTP (leg 12/04) — the ids it renders, the card it enables, the run it makes", () => {
  it("GET / → whatsnext → POST /api/drive {} → the re-read reports the journey the drive moved", async () => {
    // 1. THE PAGE the drive runs from: the affordance's OWN element ids (read from ui.ts —
    //    drive-why/drive-cost/drive-state/drive-turns/drive-draft), so the served HTML the
    //    browser gets is the one whose handler makes the request below.
    const page = await fetch(`${srv.url}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const id of ['drive-why', 'drive-cost', 'drive-state', 'drive-turns', 'drive-draft']) {
      expect(html, `the served page must carry #${id}`).toContain(`id="${id}"`);
    }

    // 2. THE CARD the page enables the button from (`driveEnablement`): a machine-executable
    //    derivation with a frontmost-ready task — here this test's own TASK3, because the
    //    drives above have already sent the other two to the runner.
    const card = await getJson<WhatsNext>(`${srv.url}/api/whatsnext`);
    expect(card.advance.action).toBe('continue-leg');
    expect(card.frontmost?.task).toBe(TASK3);
    expect(card.executable).toBe(true);

    // 3. THE DRIVE THE PAGE MAKES — the body is EXACTLY `{}` (ui.ts's `drive()`), and the
    //    value that comes back carries the fields `renderDrive` reads.
    stub.script(JSON.stringify({ call: 'run!', args: { id: TASK3 }, reason: 'the frontmost-ready is ready and its grill gate is decided' }));
    const r = await post(`${srv.url}/api/drive`, {});
    expect(r.status).toBe(200);
    const value = (JSON.parse(r.body) as { ok: boolean; value: DriveValue }).value;
    expect(value.stop).toBe('human-gate');
    expect(value.routeReason).toContain('landed at the next human decision');
    expect(value.turns).toBe(1);
    expect(typeof value.provider).toBe('string'); // the resolved default, named in the head
    expect(value.runId).toMatch(/^drive-/);
    expect(value.executed.map((e) => e.call)).toEqual(['run!']);
    expect(value.executed[0].wrote.some((w) => w.includes('activated'))).toBe(true);

    // 4. THE RE-READ the page makes next (`refresh()` after a 200) — the journey state it now
    //    reports: the run's writes are IN it (the task waits on the runner), so the card the
    //    page re-renders no longer proposes a machine move.
    const after = await getJson<WhatsNext>(`${srv.url}/api/whatsnext`);
    expect(after.advance.leg).toBe(LEG);
    expect(after.advance.action).toBe('closure-needed');
    expect(after.frontmost).toBeUndefined();
    expect(after.executable).toBe(false);
    // …and the log agrees: the frame's own writes (activate + the verify wait), never a gate
    // answer and never a self-close
    const events = readFileSync(join(root, '.ann', 'journey', 'legs', TASK3, 'events.jsonl'), 'utf8');
    expect(events).toContain('"activated"');
    expect(events).toContain('"waiting"');
    expect(events).not.toContain('"completed"');
    expect((events.match(/"type":"confirmed"/g) ?? []).length).toBe(1); // only the human's grill accept
  });
});

describe('THE BOUNDARY AND BLOCKER STATES the page’s enablement reads (leg 12/04)', () => {
  /** The SECOND fixtures (their own roots + servers, the whats-next file's `boot` pattern):
   *  each is a pre-state, committed, so nothing a test does here can reach the loop fixture. */
  const boots: Array<{ project: string; server: Server_ }> = [];
  const boot = async (nodes: Parameters<typeof fixtureProject>[0]): Promise<{ project: string; server: Server_ }> => {
    const project = fixtureProject(nodes);
    const server = await serve(project, stub.baseUrl);
    const entry = { project, server };
    boots.push(entry);
    return entry;
  };
  afterAll(() => {
    for (const { project, server } of boots) {
      server.kill();
      rmSync(project, { recursive: true, force: true });
    }
  });

  const DRAFT_ID = '02-leg/01-implementation-the-front-work';
  const LEG2 = '01-leg';

  it('GET /api/integrity: clean on a committed tree — dirty, with its NAMED blocker, when a TRACKED journey file is edited outside ann', async () => {
    const { project, server } = await boot({
      [LEG2]: { contract: { intent: 'the alpha leg (the epic)', acceptanceCriteria: ['the leg delivers'], workType: 'implementation' }, createdAt: '2026-08-27', events: [] },
      [`${LEG2}/01-first`]: {
        contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'], workType: 'implementation' },
        createdAt: '2026-08-27',
        events: [
          { at: '2026-08-27', type: 'created' },
          { at: '2026-08-27', type: 'submitted', gate: 'grill' },
          { at: '2026-08-27', type: 'confirmed', gate: 'grill' },
        ],
      },
    });
    // THE BASELINE the page's `checking` state resolves to: everything is committed, so the
    // affordance's `dirty` branch is not the one that shows.
    expect(await getJson<IntegritySnapshot>(`${server.url}/api/integrity`)).toEqual({ clean: true, blockers: [] });

    // THE DIRTY TREE: a TRACKED journey file edited outside ann — the exact class the guard
    // exists for (the goal! archive guard's own, extended to the journey tree). One byte the
    // repo does not own is enough: the content stays valid JSON, so the JOURNEY is unchanged
    // and the verdict is about the arbiter, not about a broken read.
    const file = join(project, '.ann', 'journey', 'legs', LEG2, '01-first', 'node.json');
    const committed = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, `${committed}\n`);
      const dirty = await getJson<IntegritySnapshot>(`${server.url}/api/integrity`);
      expect(dirty.clean).toBe(false);
      expect(
        dirty.blockers.some((b) => b.includes('uncommitted tracked change') && b.includes('.ann/journey/legs/01-leg/01-first/node.json')),
        `the blocker must NAME the file: ${JSON.stringify(dirty.blockers)}`,
      ).toBe(true);
    } finally {
      writeFileSync(file, committed); // RESTORE the committed bytes — nothing here is left behind
    }
    expect(await getJson<IntegritySnapshot>(`${server.url}/api/integrity`)).toEqual({ clean: true, blockers: [] });
  });

  it('a drive at the authored-work boundary DRAFTS a contract (GENERATED · spawn! is the human’s) and writes NOTHING', async () => {
    const { project, server } = await boot({
      [LEG2]: { contract: { intent: 'the done leg', acceptanceCriteria: ['done'] }, createdAt: '2026-08-27', events: [] },
      [`${LEG2}/01-a`]: {
        contract: { intent: 'the done work', acceptanceCriteria: ['done'], workType: 'implementation' },
        createdAt: OLD,
        events: [{ at: OLD, type: 'created' }, { at: OLD, type: 'completed' }],
      },
      '02-leg': { contract: { intent: 'the front leg, not yet authored', acceptanceCriteria: ['authored'] }, createdAt: '2026-08-27', events: [] },
    });
    // the DERIVATION is the boundary (the page's `driveEnablement` reads it and offers no
    // machine move) — the empty front leg is authored work, never a machine spawn
    const card = await getJson<WhatsNext>(`${server.url}/api/whatsnext`);
    expect(card.advance.action).toBe('advance-leg');
    expect(card.advance.leg).toBe('02-leg'); // the EMPTY front leg is what is drafted for
    expect(card.executable).toBe(false);

    const before = allEventBytes(project);
    // the proposal the stub returns for the BOUNDARY prompt (draftPrompt asks for exactly
    // this shape): the next free NN in the front leg, a workType the project's chains carry,
    // and the contract fields spawn! checks — a draft that failed one is never offered.
    stub.script(
      JSON.stringify({
        id: DRAFT_ID,
        intent: 'the first task of the front leg',
        acceptanceCriteria: ['the task deliverable exists'],
        workType: 'implementation',
        targetAreas: ['src/e2e'],
        rationale: 'the front leg is empty: nothing carries the epic goal yet',
      }),
    );
    const r = await post(`${server.url}/api/drive`, {});
    expect(r.status).toBe(200);
    const v = (JSON.parse(r.body) as { ok: boolean; value: DriveValue }).value;
    expect(v.stop, `the draft must PASS the spawn! checklist: ${v.routeReason}`).toBe('boundary-drafted');
    expect(v.routeReason).toContain('the authored-work boundary');
    expect(v.turns).toBe(1); // ONE model call: the draft itself
    expect(v.executed).toEqual([]); // nothing EXECUTED — a draft is a proposal
    expect(v.runId).toMatch(/^drive-/);

    const draft = v.draft!;
    expect(draft.label).toBe('GENERATED');
    expect(draft.id).toBe(DRAFT_ID);
    expect(draft.kind).toBe('task');
    expect(draft.contract).toMatchObject({ intent: 'the first task of the front leg', workType: 'implementation' });
    expect(draft.groundedOn).toContain('epic:02-leg');
    expect(draft.rationale).toContain('the front leg is empty');
    // the PROVENANCE the page prints: which model, through which provider, on which turn, in
    // which run — never a secret (the key is the server's and stays there)
    expect(draft.provenance.model).toBe('default'); // the resolved default: the body named no model
    expect(draft.provenance.provider).toBe('default');
    expect(draft.provenance.turn).toBe(1);
    expect(draft.provenance.runId).toBe(v.runId);
    expect(draft.provenance.at).toBeTruthy();
    // THE HUMAN ACT it points at (`renderDraft` prints it; the service exposes no spawn! route)
    expect(draft.approve.act).toBe('spawn!');
    expect(draft.approve.id).toBe(DRAFT_ID);
    expect(draft.approve.contract).toEqual(draft.contract);
    expect(draft.approve.then).toBe(`submit! ${DRAFT_ID} grill`);
    expect(v.presented).toHaveLength(1);
    expect(v.presented[0]).toContain('AUTHORED-WORK DRAFT — GENERATED');

    // THE ZERO-WRITES PROOF: the run drafted and stopped — every node's bytes are as they
    // were, no node appeared, and the derivation still stands at the boundary
    expect(allEventBytes(project)).toEqual(before);
    expect((await getJson<WhatsNext>(`${server.url}/api/whatsnext`)).advance.action).toBe('advance-leg');
  });
});

/** The operational-log line, as the READ returns it (the fields this suite asserts on). */
interface LogLine {
  seq: number;
  ts: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  layer: string;
  component: string;
  event: string;
  level: string;
  actor: string;
  runId: string;
  taskId?: string;
  turn?: number;
  command?: string;
  phase?: string;
  outcome: string;
  durationMs?: number;
}
