import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * E2E — THE OPERATE LOOP (leg 11): the WHAT'S NEXT card's read + its APPROVE, over real
 * HTTP against a TEMP journey, with the served page's own requests.
 *
 * PROVEN HERE (AC-1..AC-4):
 *   · the card's read (`GET /api/whatsnext`): the derived advance + frontmost-ready + leg
 *     gate + pending gates + the integrity blockers, and whether the approve can execute;
 *   · the approve (`POST /api/approve`): the frontmost-ready runs THROUGH THE FRAME (the
 *     operator action's continue-leg path — no second write path) and lands at its next
 *     human decision; the card then reflects the new derived state (a re-read, never an
 *     optimistic local edit); the run's writes are exactly the frame's (activate + the
 *     verify wait), never a gate answer, never a self-close;
 *   · the DIRTY state refuses with the NAMED blockers carried through (AC-2, care c);
 *   · the BOUNDARY derivations (advance-leg · closure-needed · none) present and STOP —
 *     200, nothing executed, zero writes (the authored-work boundary, flow-control v7 §5);
 *   · a STALE proposal refuses (nothing executed);
 *   · the NO-SUBMISSION gate refuses fail-closed with the named message — the daemon never
 *     prompts (care a), zero writes;
 *   · the SINGLE-FLIGHT: two concurrent approves cannot interleave frames — one runs, the
 *     other is refused by name (`approve-busy`) (care b);
 *   · the served page renders the card's words and issues exactly these requests.
 *
 * HARNESS LEVEL (the same as the service e2e, never assumed): the UI is driven at ITS HTTP
 * CONTRACT — the requests the served page makes — not in a DOM. The journey fixtures are
 * TEMP projects (git-backed, hermetic: the LLM base URL points nowhere and the empty
 * `implementation` chain never calls a provider).
 *
 * `npm run build` first — the service is spawned as `node dist/surface/cli.js serve`.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };
/** Pre-v9 createdAt → grandfathered at CHECK-REPORTING (the fixture journeys' concluded
 *  tasks carry no v18 conclusion; the cutoff is a store rule, not a fixture's). */
const OLD = '2026-08-20';

const LEG = '01-alpha';
const FIRST = `${LEG}/01-first`;
const SECOND = `${LEG}/02-second`;

/** An `implementation` task: the EMPTY chain (flow 2) — the runner does the work, the
 *  frame walks the lifecycle. A contract without `workType` would select the SHAPING
 *  default chain (idea-validate + spec → a provider call), which is not what a daemon
 *  e2e may execute. */
const CONTRACT = (intent: string) => JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`], workType: 'implementation' });

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
const commit = (root: string, message: string): void => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
};

/** A fresh ann project: registry data + the legacy root symlinks, git-backed. */
function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-whatsnext-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);
  commit(root, 'baseline');
  return root;
}

/**
 * The LOOP journey: leg 01 ACTIVE with TWO ready tasks — each grilled (gate① confirmed) and
 * nothing else, so each derives `queued` and is the frontmost-ready in turn. Committed, so
 * the integrity re-check is clean: the approve is executable.
 */
function driveLoopJourney(root: string): void {
  cli(root, ['spawn!', LEG, CONTRACT('the alpha leg')]);
  for (const task of [FIRST, SECOND]) {
    cli(root, ['spawn!', task, CONTRACT('do the thing')]);
    cli(root, ['submit!', task, 'grill']);
    cli(root, ['gate!', task, 'grill', 'accept', 'the contract is right']);
  }
  commit(root, 'the loop fixture journey');
}

/** The DIRTY-STATE journey: one ACTIVE leg with one task whose grill gate was REJECTED (a
 *  DECIDED gate, so the integrity check is clean — and the frame's own gate is the one the
 *  daemon must not prompt for, care a), plus a committed doc the test dirties. */
function driveOpenJourney(root: string): void {
  cli(root, ['spawn!', LEG, CONTRACT('the alpha leg')]);
  cli(root, ['spawn!', FIRST, CONTRACT('do the thing')]);
  cli(root, ['submit!', FIRST, 'grill']);
  cli(root, ['gate!', FIRST, 'grill', 'reject', 'the contract is not right yet — rework it']);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe committed bytes\n');
  cli(root, ['docs', '--write']);
  commit(root, 'the open fixture journey');
}

/** A FIXTURE-ONLY journey (no CLI drive): the boundary SHAPES are pre-states, not states a
 *  drive reaches (an empty front leg after a done one; every spawned leg done). */
function fixtureProject(nodes: Record<string, { contract: unknown; createdAt: string; events: Array<Record<string, unknown>> }>): string {
  const root = newProject();
  for (const [id, n] of Object.entries(nodes)) {
    const dir = join(root, '.ann', 'journey', 'legs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract: n.contract, createdAt: n.createdAt }));
    if (n.events.length) writeFileSync(join(dir, 'events.jsonl'), n.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  commit(root, 'the fixture journey');
  return root;
}

interface Server { url: string; child: ChildProcess; kill(): void }

/** Start `ann serve` and resolve once it announces its bound endpoint. */
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
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: r.status, body: await r.text() };
};
const post = async (url: string, payload: unknown): Promise<Res> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.text() };
};

/** The WHAT'S NEXT card's read, parsed. */
interface WhatsNext {
  advance: { leg: string; action: string; detail: string };
  frontmost?: { leg: string; task: string; status: string };
  legGate: { met: boolean; blocker?: string };
  pendingGates: Array<{ task: string; gate: string }>;
  integrity: { clean: boolean; blockers: string[] };
  executable: boolean;
}
const card = async (s: Server): Promise<WhatsNext> => {
  const r = await get(s.url + '/api/whatsnext');
  expect(r.status, `GET /api/whatsnext → ${r.status}: ${r.body.slice(0, 200)}`).toBe(200);
  return JSON.parse(r.body) as WhatsNext;
};
/** The propose the approve is bound to — exactly what the page sends. */
const boundTo = (v: WhatsNext) => ({ proposal: { action: v.advance.action, detail: v.advance.detail } });
/** A node's log as `[type]` — the zero-writes / frame-writes proof. */
const logTypes = async (s: Server, id: string): Promise<string[]> => {
  const r = await get(s.url + '/api/events?id=' + encodeURIComponent(id));
  expect(r.status, r.body.slice(0, 200)).toBe(200);
  return (JSON.parse(r.body) as { events: Array<{ type: string }> }).events.map((e) => e.type);
};
const taskStatus = async (s: Server, id: string): Promise<string | undefined> => {
  const r = await get(s.url + '/api/journey');
  const j = JSON.parse(r.body) as { legs: Array<{ id: string; tasks: Array<{ id: string; status: string }> }> };
  return j.legs.find((l) => l.id === id.split('/')[0])?.tasks.find((t) => t.id === id)?.status;
};

interface ApproveResult {
  stop: string;
  phase: string;
  derivation: { leg: string; action: string; detail: string };
  frontmost?: { task: string };
  frame?: { stop: string; phase: string };
  landing?: { task: string; where: string; gate?: string; frameStop: string };
}

describe('e2e — the operate loop: the WHAT\'S NEXT card + the approve (leg 11)', () => {
  let root: string;
  let server!: Server;

  beforeAll(async () => {
    root = newProject();
    driveLoopJourney(root);
    server = await serve(root);
  }, 60_000);
  afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('the card reads the derived proposal + the integrity state it can act on', { timeout: 30_000 }, async () => {
    const v = await card(server);
    expect(v.advance).toEqual({ leg: LEG, action: 'continue-leg', detail: `next task: ${FIRST} (queued)` });
    expect(v.frontmost).toEqual({ leg: LEG, task: FIRST, status: 'queued' });
    expect(v.legGate.met).toBe(true); // leg 01 has no predecessor
    expect(v.pendingGates).toEqual([]);
    expect(v.integrity).toEqual({ clean: true, blockers: [] });
    expect(v.executable).toBe(true);
  });

  it('a STALE proposal refuses — nothing executed', { timeout: 30_000 }, async () => {
    const before = await logTypes(server, FIRST);
    const r = await post(server.url + '/api/approve', { proposal: { action: 'continue-leg', detail: `next task: ${LEG}/99-ghost (queued)` } });
    expect(r.status).toBe(409);
    const doc = JSON.parse(r.body) as { error: { code: string; message: string }; derivation: { detail: string }; reDerivation: { detail: string } };
    expect(doc.error.code).toBe('stale-proposal');
    expect(doc.error.message).toContain('nothing executed');
    expect(doc.derivation.detail).toBe(`next task: ${LEG}/99-ghost (queued)`); // what the human approved
    expect(doc.reDerivation.detail).toBe(`next task: ${FIRST} (queued)`); // what the logs derive now
    expect(await logTypes(server, FIRST)).toEqual(before); // zero writes
  });

  it('the approve runs the frontmost-ready THROUGH THE FRAME and lands at its next human decision', { timeout: 30_000 }, async () => {
    const v = await card(server);
    const before = await logTypes(server, FIRST);
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status, r.body.slice(0, 400)).toBe(200);
    const doc = JSON.parse(r.body) as { value: ApproveResult; presented: string[] };
    expect(doc.value.stop).toBe('advanced');
    expect(doc.value.phase).toBe('execute');
    expect(doc.value.derivation.action).toBe('continue-leg');
    expect(doc.value.frontmost?.task).toBe(FIRST);
    // the action presented the ADVANCE card to the (absent) human — echoed, not prompted
    expect(doc.presented.join('\n')).toContain('ADVANCE');
    expect(doc.presented.join('\n')).toContain(`will run the frontmost-ready through the frame (run!): ${FIRST}`);
    // the RUN is the frame's: it stopped at the verify wait (the empty chain's own work
    // channel) — the runner's evidence commit precedes the confirm-result gate
    expect(doc.value.frame?.stop).toBe('blocked-waiting');
    expect(doc.value.landing).toEqual({ task: FIRST, where: 'awaiting-runner', gate: 'confirm', frameStop: 'blocked-waiting' });
    // the writes that landed are exactly the frame's — activate + the verify wait: never a
    // gate answer, never a completed, never a self-close
    expect(await logTypes(server, FIRST)).toEqual([...before, 'activated', 'waiting']);
    // …and the derived state moved: the task waits on the runner, not on the machine
    expect(await taskStatus(server, FIRST)).toBe('blocked');
    // the frame's writes are UNCOMMITTED work — the card must say so instead of claiming
    // the journey can advance: the operator's step is the commit (care c, on the loop)
    const dirty = await card(server);
    expect(dirty.advance.action).toBe('continue-leg');
    expect(dirty.integrity.clean).toBe(false);
    expect(dirty.integrity.blockers.some((b) => b.includes('uncommitted tracked change'))).toBe(true);
    expect(dirty.executable).toBe(false);
    commit(root, 'the runner owes the evidence');
    // the CARD reflects the new derivation (a re-read, never an optimistic local edit)
    const after = await card(server);
    expect(after.advance.detail).toBe(`next task: ${SECOND} (queued)`);
    expect(after.frontmost?.task).toBe(SECOND);
    expect(after.integrity).toEqual({ clean: true, blockers: [] });
    expect(after.executable).toBe(true);
  });

  it('the SINGLE-FLIGHT: two concurrent approves cannot interleave frames (care b)', { timeout: 30_000 }, async () => {
    const v = await card(server);
    expect(v.frontmost?.task).toBe(SECOND);
    const before = await logTypes(server, SECOND);
    const body = boundTo(v);
    const [a, b] = await Promise.all([post(server.url + '/api/approve', body), post(server.url + '/api/approve', body)]);
    const results = [a, b].sort((x, y) => x.status - y.status); // [200, 409]
    // ONE approve ran; the other was refused BY NAME before it touched the store
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    const ran = JSON.parse(results[0].body) as { value: ApproveResult };
    const refused = JSON.parse(results[1].body) as { error: { code: string; message: string } };
    expect(ran.value.stop).toBe('advanced');
    expect(ran.value.landing?.task).toBe(SECOND);
    expect(refused.error.code).toBe('approve-busy');
    expect(refused.error.message).toContain('ONE at a time');
    // ONE frame ran over the journey — the second never wrote anything
    expect(await logTypes(server, SECOND)).toEqual([...before, 'activated', 'waiting']);
    expect(await taskStatus(server, SECOND)).toBe('blocked');
    commit(root, 'the runner owes the evidence (both tasks)');
  });

  it('the BOUNDARY derivation (closure-needed) is PRESENTED and STOPS — no machine action', { timeout: 30_000 }, async () => {
    // both tasks now wait on the runner: nothing ready, the leg gate unmet → the authored
    // work is to CLOSE the leg (a gated human move), never a machine close
    const v = await card(server);
    expect(v.advance.action).toBe('closure-needed');
    expect(v.advance.detail).toContain('leg gate UNMET');
    expect(v.executable).toBe(false);
    const before = [await logTypes(server, FIRST), await logTypes(server, SECOND)];
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status, r.body.slice(0, 400)).toBe(200); // a designed stop, not a refusal
    const doc = JSON.parse(r.body) as { value: ApproveResult; presented: string[] };
    expect(doc.value.stop).toBe('boundary');
    expect(doc.value.phase).toBe('derive');
    expect(doc.value.derivation.action).toBe('closure-needed');
    expect(doc.presented).toEqual([]); // nothing was presented, nothing approved, nothing run
    expect([await logTypes(server, FIRST), await logTypes(server, SECOND)]).toEqual(before); // zero writes
    expect((await card(server)).advance.action).toBe('closure-needed'); // the state is unchanged
  });

  it('the served page renders the card and issues exactly these requests', { timeout: 30_000 }, async () => {
    const page = await get(server.url + '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain("What's next"); // the card
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    for (const route of ['/api/whatsnext', '/api/approve', '/api/journey', '/api/gates', '/api/confirm?id=', '/api/gate', '/api/packet?id=', '/api/detail?id=', '/api/next']) expect(script).toContain(route);
    // the card's own words: the machine-executable derivation, the presented-and-stopped
    // boundary, how to clear a blocker, the approve affordance, and the DRILL-INS
    for (const word of ['MACHINE-EXECUTABLE', 'PRESENTED AND STOPPED', 'NOT machine-executable', 'the authored-work boundary', 'uncommitted tracked journey changes — commit them', 'frontmost-ready', 'leg gate', 'UNMET — ', 'pending gates', 'drillTask', 'drillLeg', 'drillBlocker', 'drillAdvance', 'wn-fact', 'drill in'])
      expect(script, `the served page lost '${word}'`).toContain(word);
    expect(page.body).toContain('Approve'); // the approve affordance itself
    expect(page.body).not.toContain('innerHTML'); // data is rendered as text, never as markup
    const checkDir = mkdtempSync(join(tmpdir(), 'ann-ui-wn-check-'));
    const checkFile = join(checkDir, 'ui-page.js');
    writeFileSync(checkFile, script);
    const checked = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
    expect(checked.status, `the served page script does not parse: ${checked.stderr}`).toBe(0);
    rmSync(checkDir, { recursive: true, force: true });
  });

  it('every item on the card has a DRILL READ over real HTTP (the pane the page opens)', { timeout: 30_000 }, async () => {
    // the rejection asked to drill into each item; each drill is one EXISTING read, and
    // each carries the data the drill renders — no new route, no new state
    const task = await get(server.url + `/api/confirm?id=${encodeURIComponent(FIRST)}`);
    expect(task.status).toBe(200);
    expect((JSON.parse(task.body) as { detail: { contract: { intent: string } } }).detail.contract.intent).toBe('do the thing');

    const packet = await get(server.url + `/api/packet?id=${encodeURIComponent(FIRST)}`);
    expect(packet.status).toBe(200);
    const p = JSON.parse(packet.body) as { readiness: { ready: boolean; blockers: string[] }; dependencies: unknown[]; openQuestions: unknown[] };
    expect(p.readiness.ready).toBe(true); // what the frame will materialize for this step
    expect(Array.isArray(p.dependencies)).toBe(true);
    expect(Array.isArray(p.openQuestions)).toBe(true);

    const leg = await get(server.url + `/api/detail?id=${encodeURIComponent(LEG)}`);
    expect(leg.status).toBe(200);
    const d = JSON.parse(leg.body) as { isLeg: boolean; tasks: Array<{ id: string; status: string }> };
    expect(d.isLeg).toBe(true);
    expect(d.tasks.map((t) => t.id)).toEqual([FIRST, SECOND]); // the leg's tasks, each drillable further

    const next = await get(server.url + '/api/next');
    expect(next.status).toBe(200);
    const n = JSON.parse(next.body) as { advance: { action: string }; lookBack: { activeLeg: string } };
    expect(n.advance.action).toBe('closure-needed'); // the state at this point in the suite: no ready task, the leg gate unmet
    expect(n.lookBack.activeLeg).toBe(LEG);
  });
});

describe('e2e — the approve FAILS CLOSED: no submission (care a) and a dirty state (care c)', () => {
  let root: string;
  let server!: Server;

  beforeAll(async () => {
    root = newProject();
    driveOpenJourney(root);
    server = await serve(root);
  }, 60_000);
  afterAll(() => {
    server?.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('a gate with NO submission refuses by NAME — the daemon never prompts (care a)', { timeout: 30_000 }, async () => {
    const v = await card(server);
    expect(v.advance.action).toBe('continue-leg'); // the rejected-gate task IS the frontmost-ready
    expect(v.integrity.clean).toBe(true);
    expect(v.executable).toBe(true);
    const before = await logTypes(server, FIRST);
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status).toBe(409);
    const doc = JSON.parse(r.body) as { error: { code: string; message: string } };
    expect(doc.error.code).toBe('daemon-prompt');
    expect(doc.error.message).toContain('this gate has no submission — the UI must submit first; the daemon never prompts');
    expect(doc.error.message).toContain("decide gate 'grill'"); // which gate the frame wanted to decide live
    // FAIL-CLOSED with ZERO WRITES: no activation, no gate answer, no fabricated decision
    expect(await logTypes(server, FIRST)).toEqual(before);
    expect(await taskStatus(server, FIRST)).toBe('queued');
  });

  it('a DIRTY state refuses with the NAMED blockers, carried through — and the card says so (care c)', { timeout: 30_000 }, async () => {
    // a TRACKED docs edit is uncommitted work: ann does not advance on a tree whose
    // recorded reality it does not own (the operator commits)
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    const v = await card(server);
    expect(v.integrity.clean).toBe(false);
    expect(v.executable).toBe(false);
    expect(v.integrity.blockers.some((b) => b.includes('uncommitted tracked change') && b.includes('docs/thing.md'))).toBe(true);

    const before = await logTypes(server, FIRST);
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status).toBe(409);
    const doc = JSON.parse(r.body) as { error: { code: string; message: string }; blockers: string[]; derivation: { action: string } };
    // the INTEGRITY re-check is FIRST: it refuses here although the grill gate ALSO has no
    // submission — the dirty state is the earlier, named refusal
    expect(doc.error.code).toBe('refused-integrity');
    expect(doc.error.message).toContain('nothing executed');
    expect(doc.blockers.length).toBeGreaterThan(0);
    expect(doc.blockers.some((b) => b.includes('uncommitted tracked change') && b.includes('docs/thing.md'))).toBe(true);
    expect(doc.derivation.action).toBe('continue-leg');
    expect(await logTypes(server, FIRST)).toEqual(before); // zero writes

    // …and with the tree clean again the SAME approve is executable (the blocker was the
    // only reason it refused): the card reflects that, and the approve reaches the gate
    git(root, ['checkout', '--', 'docs/thing.md']);
    const clean = await card(server);
    expect(clean.integrity).toEqual({ clean: true, blockers: [] });
    expect(clean.executable).toBe(true);
    const again = await post(server.url + '/api/approve', boundTo(clean));
    expect(again.status).toBe(409);
    expect((JSON.parse(again.body) as { error: { code: string } }).error.code).toBe('daemon-prompt'); // care a — never a prompt
  });
});

describe('e2e — the boundary derivations that are NOT machine-executable (advance-leg · none)', () => {
  const servers: Array<{ server: Server; root: string }> = [];
  const boot = async (nodes: Parameters<typeof fixtureProject>[0]): Promise<Server> => {
    const root = fixtureProject(nodes);
    const server = await serve(root);
    servers.push({ server, root });
    return server;
  };
  afterAll(() => {
    for (const { server, root } of servers) {
      server.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('advance-leg (an EMPTY front leg) presents the authored-work boundary and stops', { timeout: 30_000 }, async () => {
    const server = await boot({
      '01-leg': { contract: { intent: 'the done leg', acceptanceCriteria: ['done'] }, createdAt: '2026-08-27', events: [] },
      '01-leg/01-a': { contract: { intent: 'the done work', acceptanceCriteria: ['done'], workType: 'implementation' }, createdAt: OLD, events: [{ at: OLD, type: 'created' }, { at: OLD, type: 'completed' }] },
      '02-leg': { contract: { intent: 'the front leg, not yet authored', acceptanceCriteria: ['authored'] }, createdAt: '2026-08-27', events: [] },
    });
    const v = await card(server);
    expect(v.advance.action).toBe('advance-leg');
    expect(v.advance.detail).toContain('02-leg');
    expect(v.executable).toBe(false);
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status).toBe(200);
    const doc = JSON.parse(r.body) as { value: ApproveResult; presented: string[] };
    expect(doc.value.stop).toBe('boundary');
    expect(doc.value.derivation.action).toBe('advance-leg');
    expect(doc.presented).toEqual([]);
    const log = await logTypes(server, '01-leg/01-a');
    expect(log).toEqual(['created', 'completed']); // zero writes
  });

  it('none (every spawned leg done) presents the goal consult and stops', { timeout: 30_000 }, async () => {
    const server = await boot({
      '01-goal': { contract: { intent: 'the seeded goal', acceptanceCriteria: ['the goal is met'] }, createdAt: '2026-08-27', events: [{ at: '2026-08-27', type: 'created' }, { at: '2026-08-27', type: 'completed' }] },
      '02-work': { contract: { intent: 'the work leg', acceptanceCriteria: ['done'] }, createdAt: '2026-08-27', events: [] },
      '02-work/01-a': { contract: { intent: 'the work', acceptanceCriteria: ['done'], workType: 'implementation' }, createdAt: OLD, events: [{ at: OLD, type: 'created' }, { at: OLD, type: 'completed' }] },
    });
    const v = await card(server);
    expect(v.advance.action).toBe('none');
    expect(v.advance.detail).toContain('goal! met'); // the human move, named
    expect(v.executable).toBe(false);
    const r = await post(server.url + '/api/approve', boundTo(v));
    expect(r.status).toBe(200);
    const doc = JSON.parse(r.body) as { value: ApproveResult };
    expect(doc.value.stop).toBe('boundary');
    expect(doc.value.derivation.action).toBe('none');
    expect(await logTypes(server, '02-work/01-a')).toEqual(['created', 'completed']); // zero writes
  });
});
