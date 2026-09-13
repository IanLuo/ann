import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import {
  DRIVER_MAX_TURNS_CEILING,
  DriverDeps,
  DriverResult,
  runSemanticDriver,
  validateProposal,
} from '../semantic-driver.js';
import { StepLookup } from '../chain.js';
import { LlmAbility } from '../types.js';

/**
 * THE SEMANTIC DRIVER (flow/semantic-driver, leg 12 task 02) — the LLM loop whose
 * proposals are validated against a CLOSED SET before anything executes.
 *
 * Pinned here: the loop's happy path (read → run! → land); an out-of-set proposal
 * REFUSED BY NAME (a gate decision, a claim of fact, a completion, a spawn, an unknown
 * name) — never clamped, never executed; the turn bound; the present-only refinement (a
 * `run!` whose entry gate is undecided PRESENTS and lands, and no gate is ever answered);
 * the authored-work boundary draft (GENERATED + labeled, `spawn!` never executed); the
 * `none` consult (present + stop); a provider failure (a NAMED stop with ZERO writes);
 * and resume by RE-DERIVATION (a stale checkpoint is recorded, never replayed).
 */

let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
/** Pre-v9 createdAt → grandfathered (a done task without evidence/gates is check-clean). */
const OLD = '2026-08-20';
const TASK = '01-leg/01-a';
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['the thing is done'], workType: 'implementation' };

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = CONTRACT, createdAt = '2026-08-27') {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract, createdAt }));
  if (events.length) writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const commands = () => new Commands(new Store(root), 'test');

/** A grilled, queued `implementation` task in a live leg — the frontmost-ready. */
function readyTask() {
  writeNode('01-leg', [], { intent: 'the alpha leg (the epic)', acceptanceCriteria: ['the leg delivers'] });
  writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
}
/** A done predecessor leg + an EMPTY front leg → the `advance-leg` boundary. */
function emptyFrontLeg() {
  writeNode('01-leg', []);
  writeNode('01-leg/01-a', [ev('created'), ev('completed')], CONTRACT, OLD);
  writeNode('02-leg', [], { intent: 'the beta leg (the epic to draft into)', acceptanceCriteria: ['the beta leg delivers'], workType: 'implementation' });
}
/** A leg that cannot continue → the `closure-needed` boundary. */
function closureNeededLeg() {
  writeNode('01-leg', []);
  writeNode('01-leg/01-a', [ev('created'), ev('completed')], CONTRACT, OLD);
  writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' })]);
}
/** An exhausted, unsealed goal session → the `none` boundary (the goal consult). */
function exhaustedJourney() {
  writeNode('01-goal', [ev('created'), ev('completed')]);
  writeNode('02-work', []);
  writeNode('02-work/01-a', [ev('created'), ev('completed')], CONTRACT, OLD);
}

/** A scripted model — one response per turn, prompts recorded. Running out is LOUD (an
 *  under-scripted test must never silently re-use a response). */
function fakeLlm(responses: string[]): { llm: LlmAbility; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const llm: LlmAbility = {
    async complete(req) {
      prompts.push(req.prompt);
      const next = responses[i++];
      if (next === undefined) throw new Error('fake llm ran out of scripted responses');
      return next;
    },
  };
  return { llm, prompts };
}
const failingLlm = (message = 'provider-unavailable: connection refused'): LlmAbility => ({
  async complete() {
    throw new Error(message);
  },
});

const registryOf = (): StepLookup => ({ has: () => false, get: (id) => { throw new Error(`unregistered step ${id}`); } });
const drive = (c: Commands, llm: LlmAbility, over: Partial<DriverDeps> = {}): Promise<DriverResult> =>
  runSemanticDriver({ commands: c, root, registry: registryOf(), llm, recordedBy: 'test', runId: 'run-1', provider: 'openai-compatible', model: 'gpt-test', ...over });

/** Every node's events as one comparable map — the zero-writes proof for a stop. */
function logSnapshot(c: Commands): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of c.ids()) out[id] = JSON.stringify(c.events(id));
  return out;
}
const typesOf = (c: Commands, id: string) => c.events(id).map((e) => e.type);
const call = (name: string, args: Record<string, string> = {}) => JSON.stringify({ call: name, args, reason: 'because the derived state says so' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-driver-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('AC-1 — the loop: read → propose → validate → execute through the command layer', () => {
  it('a read, then run!, then the model stops: the run lands at the runner, and the writes are the FRAME\'s', async () => {
    readyTask();
    const c = commands();
    const { llm, prompts } = fakeLlm([
      call('detail', { id: TASK }),
      call('run!', { id: TASK }),
      JSON.stringify({ stop: 'the runner commits evidence next', reason: 'the confirm gate is human' }),
    ]);
    const r = await drive(c, llm);

    // the loop executed the two calls it proposed — nothing else ran
    expect(r.executed.map((e) => e.call)).toEqual(['detail', 'run!']);
    expect(prompts.length).toBe(2); // the third scripted turn was never reached (the run landed)
    expect(r.stop).toBe('human-gate');
    expect(r.landing).toMatchObject({ where: 'awaiting-runner', task: TASK, gate: 'confirm' });
    // a checkpoint at the human gate, and the derivation at the stop is FRESH
    expect(r.checkpoint?.task).toBe(TASK);
    expect(r.checkpoint?.action).toBe('closure-needed'); // the task is blocked now — re-derived, not assumed
    expect(r.derivation.action).toBe('closure-needed');
    // the writes are exactly the frame's: activate + the verify wait — no gate answer, no close
    expect(typesOf(c, TASK)).toEqual(['created', 'submitted', 'confirmed', 'activated', 'waiting']);
    expect(r.metrics.writes).toEqual([`${TASK}: activated`, `${TASK}: waiting`]);
    // the observation the model got carried the derived state, not a plan
    expect(prompts[0]).toContain('"action": "continue-leg"');
    expect(prompts[1]).toContain('"call": "detail"'); // the earlier read's output is the loop's own memory
  });

  it('the reads re-execute the same derived commands the CLI reads', async () => {
    readyTask();
    const c = commands();
    const { llm } = fakeLlm([call('next'), call('gates'), call('goal'), call('check'), call('verify'), JSON.stringify({ stop: 'nothing left', reason: 'done' })]);
    const r = await drive(c, llm);
    expect(r.executed.map((e) => e.call)).toEqual(['next', 'gates', 'goal', 'check', 'verify']);
    expect(r.stop).toBe('model-stop');
    expect(r.executed[0].output).toMatchObject({ action: 'continue-leg', leg: '01-leg' });
    expect(logSnapshot(c)).toEqual(Object.fromEntries(c.ids().map((id) => [id, JSON.stringify(c.events(id))]))); // reads wrote nothing
  });

  it('a model stop ends the loop with its own reason as the route reason', async () => {
    readyTask();
    const { llm } = fakeLlm([JSON.stringify({ stop: 'the human reviews the runner output', reason: 'nothing machine-executable' })]);
    const r = await drive(commands(), llm);
    expect(r.stop).toBe('model-stop');
    expect(r.routeReason).toContain('the human reviews the runner output');
    expect(r.turns).toBe(1);
  });
});

describe('AC-1 + the present-only refinement — an out-of-set proposal is REFUSED BY NAME', () => {
  const forbidden = ['gate!', 'evidence!', 'capture!', 'complete!', 'spawn!', 'spec!', 'append!', 'goal!', 'advance!'];
  for (const name of forbidden) {
    it(`'${name}' is refused by name — never clamped, never executed, zero writes`, async () => {
      readyTask();
      const c = commands();
      const before = logSnapshot(c);
      const { llm } = fakeLlm([call(name, { id: TASK, gate: 'confirm' })]);
      const r = await drive(c, llm);
      expect(r.stop).toBe('refused-proposal');
      expect(r.refusal?.code).toBe('forbidden-call');
      expect(r.refusal?.call).toBe(name);
      expect(r.routeReason).toContain(name);
      expect(logSnapshot(c)).toEqual(before); // ZERO writes — nothing executed
      expect(typesOf(c, TASK)).not.toContain('completed');
      expect(typesOf(c, TASK)).not.toContain('evidence');
    });
  }

  it('an invented name is refused as UNKNOWN, naming the closed set', async () => {
    readyTask();
    const { llm } = fakeLlm([call('bash', { cmd: 'rm -rf /' })]);
    const r = await drive(commands(), llm);
    expect(r.stop).toBe('refused-proposal');
    expect(r.refusal?.code).toBe('unknown-call');
    expect(r.routeReason).toContain('not in the closed set');
  });

  it('unparseable output and a malformed shape are refusals with the right code', async () => {
    readyTask();
    for (const [text, code] of [
      ['I think we should run the task next!', 'unparseable-proposal'],
      ['{"stop": ""}', 'unparseable-proposal'],
      ['{"args": {"id": "x"}}', 'unparseable-proposal'],
    ] as const) {
      const { llm } = fakeLlm([text]);
      const r = await drive(commands(), llm);
      expect(r.stop).toBe('refused-proposal');
      expect(r.refusal?.code).toBe(code);
    }
  });

  it('bad arguments are refusals: an unknown arg, a missing arg, an unknown node, a closed task', async () => {
    readyTask();
    const bad = [
      JSON.stringify({ call: 'detail', args: {}, reason: '' }),
      JSON.stringify({ call: 'detail', args: { id: TASK, n: '1' }, reason: '' }),
      JSON.stringify({ call: 'submit!', args: { id: TASK, gate: 'nope' }, reason: '' }),
      JSON.stringify({ call: 'detail', args: { id: '01-leg/99-nope' }, reason: '' }),
    ];
    for (const text of bad) {
      const { llm } = fakeLlm([text]);
      const r = await drive(commands(), llm);
      expect(r.stop).toBe('refused-proposal');
      expect(r.refusal?.code).toBe('bad-args');
    }
  });

  it('run! on a closed task is refused (a sibling keeps the leg runnable)', async () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')], CONTRACT, OLD); // closed
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]); // ready
    const c = commands();
    expect(c.advance().action).toBe('continue-leg');
    const { llm } = fakeLlm([call('run!', { id: '01-leg/01-a' })]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('refused-proposal');
    expect(r.refusal?.code).toBe('bad-args');
    expect(r.refusal?.reason).toContain('closed');
  });

  it('validateProposal is the ONE validator: the table is closed and the reasons are named', () => {
    readyTask();
    const c = commands();
    const ctx = { commands: c, advance: c.advance() };
    expect(validateProposal(call('run!'), ctx)).toMatchObject({ ok: true, proposal: { kind: 'call', call: 'run!' } });
    expect(validateProposal(call('evidence!', { id: TASK }), ctx)).toMatchObject({ ok: false, refusal: { code: 'forbidden-call' } });
    expect(validateProposal('nope', ctx)).toMatchObject({ ok: false, refusal: { code: 'unparseable-proposal' } });
  });
});

describe('AC-1 — bounded: the turn bound, and an out-of-range bound is REFUSED', () => {
  it('the turn bound stops the loop with a route reason, after exactly that many calls', async () => {
    readyTask();
    const c = commands();
    const { llm } = fakeLlm([call('detail', { id: TASK }), call('detail', { id: TASK }), call('detail', { id: TASK })]);
    const r = await drive(c, llm, { maxTurns: 2 });
    expect(r.stop).toBe('turn-bound');
    expect(r.turns).toBe(2);
    expect(r.executed.length).toBe(2);
    expect(r.routeReason).toContain('turn bound (2)');
  });

  it('an out-of-range maxTurns is refused, never clamped', async () => {
    readyTask();
    const { llm } = fakeLlm([]);
    for (const maxTurns of [0, -1, DRIVER_MAX_TURNS_CEILING + 1, 2.5]) {
      const r = await drive(commands(), llm, { maxTurns });
      expect(r.stop).toBe('invalid-config');
      expect(r.turns).toBe(0);
    }
  });
});

describe('AC-2 — it NEVER answers a gate and never self-closes', () => {
  it('run! on an unsubmitted entry gate PRESENTS it (submit!) and lands there — no decision is written', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created')]); // the grill gate is not even submitted yet
    const c = commands();
    const { llm } = fakeLlm([call('run!', { id: TASK })]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('human-gate');
    expect(r.landing).toMatchObject({ where: 'gate', task: TASK, gate: 'grill' });
    expect(r.routeReason).toContain('PRESENTED');
    // the PRESENT act wrote the submission (with the driver's provenance) — nothing else
    expect(typesOf(c, TASK)).toEqual(['created', 'submitted']);
    expect(String(c.events(TASK)[1].note)).toContain('RECORDED_BY=test');
    expect(c.status(TASK)).not.toBe('done');
  });

  it('a rejected entry gate is the human\'s: run! lands with ZERO writes', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill' })]);
    const c = commands();
    const before = logSnapshot(c);
    const { llm } = fakeLlm([call('run!', { id: TASK })]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('human-gate');
    expect(r.routeReason).toContain("'rejected'");
    expect(logSnapshot(c)).toEqual(before);
  });

  it('submit! is the driver\'s present act: it opens the gate and lands, and the note carries the provenance', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created')]);
    const c = commands();
    const { llm } = fakeLlm([call('submit!', { id: TASK, gate: 'grill' })]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('human-gate');
    expect(r.executed[0].call).toBe('submit!');
    expect(typesOf(c, TASK)).toEqual(['created', 'submitted']);
    expect(String(c.events(TASK)[1].note)).toContain('RECORDED_BY=test');
    expect(c.gateState(TASK, 'grill')).toBe('submitted');
  });

  it('no run of ANY shape writes a gate decision or a completion the human did not make', async () => {
    readyTask();
    const c = commands();
    const { llm } = fakeLlm([call('run!', { id: TASK })]);
    await drive(c, llm);
    const decided = c.events(TASK).filter((e) => e.type === 'confirmed' || e.type === 'rejected');
    expect(decided.map((e) => e.gate)).toEqual(['grill']); // only the human's earlier grill accept
    expect(typesOf(c, TASK)).not.toContain('completed');
  });
});

describe('AC-3 — the authored-work boundary DRAFTS (GENERATED), and spawn! is not executed', () => {
  it('advance-leg → a GENERATED task draft, grounded on the epic and the goal, zero writes', async () => {
    emptyFrontLeg();
    const c = commands();
    const before = logSnapshot(c);
    const { llm, prompts } = fakeLlm([
      JSON.stringify({
        id: '02-leg/01-implementation-the-beta-slice',
        workType: 'implementation',
        intent: 'implement the beta slice the epic names',
        acceptanceCriteria: ['the beta slice works'],
        targetAreas: ['src'],
        rationale: 'the epic asks for the beta behaviour',
      }),
    ]);
    const r = await drive(c, llm);

    expect(r.stop).toBe('boundary-drafted');
    expect(r.draft?.label).toBe('GENERATED');
    expect(r.draft?.provenance).toMatchObject({ model: 'gpt-test', provider: 'openai-compatible', turn: 1, runId: 'run-1' });
    expect(r.draft?.kind).toBe('task');
    expect(r.draft?.id).toBe('02-leg/01-implementation-the-beta-slice');
    expect(r.draft?.validated.problems).toEqual([]);
    expect(r.draft?.groundedOn).toContain('epic:02-leg');
    expect(r.draft?.approve).toMatchObject({ act: 'spawn!', id: '02-leg/01-implementation-the-beta-slice', then: 'submit! 02-leg/01-implementation-the-beta-slice grill' });
    // the draft is grounded → the prompt carried the epic and the goal
    expect(prompts[0]).toContain('the beta leg (the epic to draft into)');
    expect(prompts[0]).toContain('THE GOAL');
    // SPAWN IS NOT EXECUTED: zero writes anywhere in the journey
    expect(logSnapshot(c)).toEqual(before);
    expect(c.ids()).not.toContain('02-leg/01-implementation-the-beta-slice');
  });

  it('closure-needed → a GENERATED closure draft (the worktype grammar holds)', async () => {
    closureNeededLeg();
    const c = commands();
    const before = logSnapshot(c);
    const { llm, prompts } = fakeLlm([
      JSON.stringify({
        id: '01-leg/03-closure-transfer-the-remaining-scope',
        workType: 'closure',
        intent: 'close the leg by transferring the blocked scope',
        acceptanceCriteria: ['the leg gate is met'],
        rationale: 'the remaining task is blocked on a human',
      }),
    ]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('boundary-drafted');
    expect(r.draft?.kind).toBe('closure');
    expect(r.draft?.validated.problems).toEqual([]);
    expect(prompts[0]).toContain('THE AUTHORED-WORK BOUNDARY (closure-needed)');
    expect(logSnapshot(c)).toEqual(before);
  });

  it('a draft that fails the contract checklist is REFUSED — nothing is offered for approval', async () => {
    emptyFrontLeg();
    const c = commands();
    const before = logSnapshot(c);
    const { llm } = fakeLlm([JSON.stringify({ id: '02-leg/07-implementation-wrong-prefix', workType: 'implementation', intent: '', acceptanceCriteria: [] })]);
    const r = await drive(c, llm);
    expect(r.stop).toBe('draft-invalid');
    expect(r.draft).toBeUndefined();
    expect(r.routeReason).toContain('next free prefix in 02-leg is 01');
    expect(r.routeReason).toContain('intent missing/empty');
    expect(logSnapshot(c)).toEqual(before);
  });

  it('none → the goal consult is PRESENTED and the loop stops: no draft, no provider call, zero writes', async () => {
    exhaustedJourney();
    const c = commands();
    const before = logSnapshot(c);
    const { llm, prompts } = fakeLlm([]); // would throw if the loop asked the model
    const r = await drive(c, llm);
    expect(r.stop).toBe('boundary-none');
    expect(prompts.length).toBe(0);
    expect(r.draft).toBeUndefined();
    expect(r.consult?.verdict).toBe('unconfirmed');
    expect(r.routeReason).toContain('goal! met');
    expect(r.presented.join('\n')).toContain('HUMAN moves');
    expect(logSnapshot(c)).toEqual(before);
  });
});

describe('AC-4 — a provider failure is a NAMED stop with ZERO writes, and no credential is in the result', () => {
  it('the provider throwing stops the loop by name and writes nothing', async () => {
    readyTask();
    const c = commands();
    const before = logSnapshot(c);
    const r = await drive(c, failingLlm('provider-unavailable: connect ECONNREFUSED'));
    expect(r.stop).toBe('provider-failure');
    expect(r.routeReason).toContain('ECONNREFUSED');
    expect(r.routeReason).toContain('ZERO writes');
    expect(logSnapshot(c)).toEqual(before);
    expect(r.executed).toEqual([]);
  });

  it('the boundary draft fails the same way — no fabricated contract', async () => {
    emptyFrontLeg();
    const c = commands();
    const before = logSnapshot(c);
    const r = await drive(c, failingLlm('bad-response: no choices in the body'));
    expect(r.stop).toBe('provider-failure');
    expect(r.draft).toBeUndefined();
    expect(logSnapshot(c)).toEqual(before);
  });

  it('no credential reaches the result (the adapter holds it; the e2e asserts the response body)', async () => {
    process.env.ANN_LLM_API_KEY = 'sk-driver-unit-secret';
    try {
      readyTask();
      const { llm } = fakeLlm([JSON.stringify({ stop: 'done', reason: 'nothing to do' })]);
      const r = await drive(commands(), llm);
      expect(JSON.stringify(r)).not.toContain('sk-driver-unit-secret');
      expect(JSON.stringify(r)).not.toContain('ANN_LLM_API_KEY');
    } finally {
      delete process.env.ANN_LLM_API_KEY;
    }
  });
});

describe('AC-1 — resume by RE-DERIVATION (a stale checkpoint is recorded, never replayed)', () => {
  it('a matching checkpoint continues from the FRESH derivation', async () => {
    readyTask();
    const c = commands();
    const fresh = c.advance();
    const { llm, prompts } = fakeLlm([JSON.stringify({ stop: 'waiting for the runner', reason: 'nothing to run' })]);
    const r = await drive(c, llm, { resume: { at: '2026-08-27', action: fresh.action, detail: fresh.detail, task: TASK } });
    expect(r.resumed?.matched).toBe(true);
    expect(prompts[0]).toContain(`"detail": ${JSON.stringify(fresh.detail)}`);
    expect(r.stop).toBe('model-stop');
  });

  it('a stale checkpoint is NAMED as mismatched and the run follows the current logs', async () => {
    readyTask();
    const c = commands();
    const stale = { at: '2026-08-27', action: 'continue-leg' as const, detail: 'next task: 01-leg/09-gone (queued)' };
    const { llm, prompts } = fakeLlm([JSON.stringify({ stop: 'nothing to do', reason: 'x' })]);
    const r = await drive(c, llm, { resume: stale });
    expect(r.resumed?.matched).toBe(false);
    expect(r.resumed?.note).toContain('RE-DERIVED');
    expect(r.resumed?.note).toContain('replayed nothing');
    // the model was given the CURRENT derivation — the stale plan is nowhere in the loop
    expect(prompts[0]).toContain(`"task": "${TASK}"`);
    expect(prompts[0]).not.toContain('01-leg/09-gone');
  });
});
