import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { runOperatorAction, operatorIntegrityBlockers, OperatorActionResult } from '../operator-action.js';
import { StepLookup } from '../chain.js';
import { Abilities, ResearchFinding } from '../types.js';

/**
 * THE OPERATOR ACTION `advance!` (functional-spec v2 F5 — flow-control-spec v7 §2/§5).
 * These tests pin the FOUR DETERMINISTIC RULES:
 *   1. integrity re-check fail-closed (store drift · uncommitted tracked journey/docs
 *      changes · gate gaps · a stale manifest — each REFUSES with its named blocker);
 *   2. the advance is re-derived at execution — a stale proposal executes nothing;
 *   3. continue-leg executes ONLY through the frame (run!) — the writes that land are
 *      exactly the frame's (activate/waiting or the human-decided gates), never an
 *      advance!-owned write, never a self-close;
 *   4. land at the next human gate, never silently past one.
 * Plus the per-derivation stops (AC-4): advance-leg / closure-needed / none are NOT
 * machine-executable — boundary + stop, zero writes.
 */

let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
/** Pre-v9 createdAt → grandfathered at CHECK-REPORTING (a done task with no evidence /
 *  gates is check-clean — the F-AC18/19 + gate rules skip it, store.ts V9_CUTOFF). */
const OLD = '2026-08-20';

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = { intent: 'Build the thing', acceptanceCriteria: ['AC-1'] }, createdAt = '2026-08-27') {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract, createdAt }));
  if (events.length) writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const commands = () => new Commands(new Store(root), 'test');
const TASK = '01-leg/01-a';

/** A grill-accepted queued task — the frontmost-ready this suite's continue-legs run. */
function readyTask(over: string[] = []) {
  writeNode('01-leg', []);
  writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ...over.map((t) => ev(t))]);
}

/** A done predecessor leg (pre-cutoff completed task) + an EMPTY front leg → advance-leg. */
function emptyFrontLeg() {
  writeNode('01-leg', []);
  writeNode('01-leg/01-a', [ev('created'), ev('completed')], undefined, OLD);
  writeNode('02-leg', []);
}

/** A scripted human — present/ask recorded; decide answers from the queue (a mutation
 *  hook lets a test change the store between the approve and the re-derivation). */
class ScriptedInteract {
  readonly presented: string[] = [];
  readonly asked: string[] = [];
  constructor(private readonly answers: string[] = [], private readonly onDecide: () => void = () => {}) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(q: string) {
    this.asked.push(q);
    return this.answers.shift() ?? '';
  }
  async research(_topics: string[]): Promise<ResearchFinding[]> {
    return [];
  }
  async decide(q: string, options: string[]) {
    this.asked.push(q);
    this.onDecide();
    return this.answers.shift() ?? options[0];
  }
}

const abilities = (human: ScriptedInteract): Abilities => ({ llm: { complete: async () => 'a completion' }, interact: human });
const registryOf = (): StepLookup => ({ has: () => false, get: (id) => { throw new Error(`unregistered step ${id}`); } });
const act = (c: Commands, human = new ScriptedInteract()): Promise<OperatorActionResult> =>
  runOperatorAction({ commands: c, root, registry: registryOf(), abilities: abilities(human) });

/** The empty-chain run is the frame's own work — assert the run wrote exactly what the
 *  frame writes (activated + the verify wait), never a completed, never a gate answer. */
const frameWrites = (c: Commands) => c.events(TASK).map((e) => e.type);

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-advance-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('rule 1 — integrity re-check FIRST, fail closed (AC-1)', () => {
  it('a GATE gap refuses with the named blocker — nothing executes', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('completed')]); // no confirm gate
    const c = commands();
    const r = await act(c);
    expect(r.stop).toBe('refused-integrity');
    expect(r.phase).toBe('integrity');
    expect(r.blockers.some((b) => b.includes('GATE-2 GAP'))).toBe(true);
    expect(c.events(TASK).map((e) => e.type)).not.toContain('activated'); // nothing executed
  });

  it('store drift (verify) refuses with the drift named', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created')]);
    // a hand-written node.json whose id disagrees with its directory — D4 drift
    writeFileSync(join(dir(TASK), 'node.json'), JSON.stringify({ id: '99-other', contract: { intent: 'x', acceptanceCriteria: ['y'] }, createdAt: '2026-08-27' }));
    const c = commands();
    expect(operatorIntegrityBlockers(c, root).some((b) => b.includes('node-id-mismatch'))).toBe(true);
    const r = await act(c);
    expect(r.stop).toBe('refused-integrity');
    expect(r.blockers.some((b) => b.includes('node-id-mismatch'))).toBe(true);
  });

  it('a stale docs manifest refuses (a doc file the manifest does not name)', async () => {
    readyTask();
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n');
    const c = commands();
    const r = await act(c);
    expect(r.stop).toBe('refused-integrity');
    expect(r.blockers.some((b) => b.includes('docs manifest out of sync'))).toBe(true);
  });

  it('an uncommitted TRACKED docs change refuses; untracked scratch never refuses', async () => {
    readyTask();
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n');
    writeFileSync(join(root, 'docs', 'manifest.json'), JSON.stringify({ thing: 'docs/thing.md' }, null, 2) + '\n');
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 't']);
    git(root, ['config', 'user.email', 't@ann.test']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'baseline']);
    const c = commands();
    // clean → the action proceeds to the approve (a continue-leg is derived)
    expect(operatorIntegrityBlockers(c, root)).toEqual([]);
    // a TRACKED docs edit is a dirty state — refuse before anything executes
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    expect(operatorIntegrityBlockers(commands(), root).some((b) => b.includes('uncommitted tracked change:') && b.includes('docs/thing.md'))).toBe(true);
    const r = await act(commands());
    expect(r.stop).toBe('refused-integrity');
    expect(r.blockers.some((b) => b.includes('uncommitted tracked change'))).toBe(true);
  });
});

describe('rule 3 + 4 — continue-leg executes through the frame and lands at a gate (AC-3)', () => {
  it('approve → the frontmost-ready runs through the frame; its next human decision is NAMED, never silent', async () => {
    readyTask();
    const c = commands();
    const human = new ScriptedInteract(['approve']);
    const r = await act(c, human);
    expect(r.stop).toBe('advanced');
    expect(r.derivation.action).toBe('continue-leg');
    expect(r.frontmost?.task).toBe(TASK);
    // the ADVANCE card was presented + the ONE approve asked
    expect(human.presented[0]).toContain('derivation: continue-leg');
    expect(human.presented[0]).toContain(TASK);
    expect(human.asked[0]).toContain('approve');
    // the run's writes are exactly the frame's — activate + the verify wait, never a
    // completed, never a gate answer written by advance! itself
    expect(frameWrites(c)).toEqual(['created', 'submitted', 'confirmed', 'activated', 'waiting']);
    expect(r.frame?.stop).toBe('blocked-waiting');
    expect(c.status(TASK)).toBe('blocked'); // the run stopped — the journey is not past it
    // landing: the runner's evidence precedes the confirm-result gate (a human gate)
    expect(r.landing).toMatchObject({ task: TASK, where: 'awaiting-runner', gate: 'confirm' });
  });

  it('a fresh task (no grill yet) is run only when the HUMAN channel decides its gate — never silently passed', async () => {
    writeNode('01-leg', []);
    writeNode(TASK, [ev('created')]); // gate① not yet submitted
    const c = commands();
    const human = new ScriptedInteract(['approve', 'accept']); // the human accepts gate①
    const r = await act(c, human);
    expect(r.stop).toBe('advanced');
    // the grill decision came from the human channel through the frame's gate! writer
    const types = frameWrites(c);
    expect(types).toContain('submitted');
    expect(types).toContain('confirmed');
    expect(c.events(TASK).filter((e) => e.type === 'confirmed').every((e) => e.gate === 'grill')).toBe(true);
    expect(human.asked[1]).toContain('decide gate');
  });

  it('declining the approve stops with NO writes', async () => {
    readyTask();
    const c = commands();
    const human = new ScriptedInteract(['decline']);
    const r = await act(c, human);
    expect(r.stop).toBe('declined');
    expect(r.phase).toBe('approve');
    expect(frameWrites(c)).toEqual(['created', 'submitted', 'confirmed']); // untouched
    expect(c.status(TASK)).toBe('queued');
  });
});

describe('rule 2 — the advance is RE-DERIVED at execution (AC-2)', () => {
  it('a proposal the logs no longer match executes NOTHING (stale)', async () => {
    readyTask();
    const c = commands();
    // the human approves — but by the time the approve lands, the store changed (a
    // concurrent submission blocks the approved task): the re-derivation contradicts it
    const human = new ScriptedInteract(['approve'], () => {
      c.submit(TASK, 'confirm');
    });
    const r = await act(c, human);
    expect(r.stop).toBe('stale-proposal');
    expect(r.phase).toBe('re-derive');
    expect(r.derivation.action).toBe('continue-leg'); // the APPROVED proposal
    expect(r.reDerivation?.action).toBe('closure-needed'); // the logs no longer match it
    // the approved task was NOT run — no activated, no waiting; only the injected submit
    expect(frameWrites(c)).toEqual(['created', 'submitted', 'confirmed', 'submitted']);
  });
});

describe('AC-4 — advance-leg / closure-needed / none are NOT machine-executable', () => {
  it('advance-leg (an empty front leg) → the authored-work boundary, zero writes', async () => {
    emptyFrontLeg();
    const c = commands();
    const before = logSnapshot(c);
    const r = await act(c);
    expect(r.stop).toBe('boundary');
    expect(r.derivation.action).toBe('advance-leg');
    expect(r.derivation.detail).toContain('02-leg');
    expect(logSnapshot(c)).toEqual(before); // zero writes
  });

  it('closure-needed → the gated-closure boundary, zero writes', async () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')], undefined, OLD); // done
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' })]); // blocked on the human
    const c = commands();
    const before = logSnapshot(c);
    const r = await act(c);
    expect(r.stop).toBe('boundary');
    expect(r.derivation.action).toBe('closure-needed');
    expect(r.derivation.detail).toContain('closure');
    expect(logSnapshot(c)).toEqual(before); // zero writes
  });

  it('none → the goal consult (a seeded exhausted session is never sealed by a machine)', async () => {
    writeNode('01-goal', [ev('created'), ev('completed')]); // the seeded goal leg
    writeNode('02-work', []);
    writeNode('02-work/01-a', [ev('created'), ev('completed')], undefined, OLD); // the work
    const c = commands();
    const before = logSnapshot(c);
    const r = await act(c);
    expect(r.stop).toBe('boundary');
    expect(r.derivation.action).toBe('none');
    expect(r.derivation.detail).toContain('goal! met'); // the consult names the HUMAN moves
    expect(r.goal?.verdict).toBe('unconfirmed');
    expect(logSnapshot(c)).toEqual(before); // zero writes
  });
});

/** Every node's events as one comparable map — the zero-writes proof for a stop. */
function logSnapshot(c: Commands): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of c.ids()) out[id] = JSON.stringify(c.events(id));
  return out;
}
