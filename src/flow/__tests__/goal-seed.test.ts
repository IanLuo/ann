import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { runGoalSeed } from '../goal-seed.js';

/**
 * The `goal! seed` MATERIALIZE PATH (flow/goal-seed) — the interactive grill at SESSION
 * scope → on a HUMAN solid, the deterministic goal.md synthesis → L1 seedGoal + the
 * goal.md artifact-lock. Same scripted-abilities pattern as the idea-validation session
 * tests: the abilities SET is injected, so the driver runs headless.
 */

/** A scripted human — FIFO answers/decisions. Running out is the ABORT (the human
 *  walked away), except `decide`, which falls back per-call. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly findings: ResearchFinding[] = [],
    private readonly decisions: string[] = ['solid', 'light'],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(_question: string): Promise<string> {
    const a = this.answers.shift();
    if (a === undefined) throw new InteractAbort('scripted interactor ran out of answers');
    return a;
  }
  async research(_topics: string[]): Promise<ResearchFinding[]> {
    return this.findings;
  }
  async decide(_question: string, _options: string[]): Promise<string> {
    const d = this.decisions.shift();
    if (d === undefined) throw new InteractAbort('scripted interactor ran out of decisions');
    return d;
  }
}

/** A fake llm — sequential grill completions (the session grills per round; the last
 *  repeats). Counts calls so the guard/provider tests can assert WHEN the model ran. */
const fakeLlm = (responses: string[]): { llm: LlmAbility; calls: { n: number } } => {
  const calls = { n: 0 };
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      calls.n += 1;
      return responses[Math.min(calls.n - 1, responses.length - 1)];
    },
  };
  return { llm, calls };
};

/** Provider-absent: the llm ability itself fails (the adapter turns this into the
 *  session's ok:false provider-unavailable value — nothing is fabricated). */
const throwingLlm = (message: string): { llm: LlmAbility; calls: { n: number } } => {
  const calls = { n: 0 };
  const llm: LlmAbility = {
    async complete() {
      calls.n += 1;
      throw new Error(message);
    },
  };
  return { llm, calls };
};

const grill = (validation: unknown[], questions: unknown[] = [], summary = 'A working goal! seed command.') =>
  JSON.stringify({ summary, validation, questions });

const cleanGrill = () =>
  grill([
    { verdict: 'ok', claim: 'goal.md locks on the goal root when the human confirms', basis: ['goal-session-design'], confidence: 'high' },
  ]);

const GOAL_IDEA = 'Build a working goal! seed command that grills the goal at session scope.';

let root: string;
const legs = () => join(root, '.ann', 'journey', 'legs');
const goalDoc = () => join(legs(), '01-goal', 'artifacts', 'goal.md');

/** A fresh EMPTY store-backed command surface (a goal seeds the first leg only). */
const fresh = (): Commands => {
  root = mkdtempSync(join(tmpdir(), 'ann-goalseed-'));
  mkdirSync(legs(), { recursive: true });
  return new Commands(new Store(root), 'test');
};

describe('runGoalSeed — the goal! seed materialize path (flow/goal-seed)', () => {
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('GO: a solid human verdict seeds the goal leg AND artifact-locks goal.md on the goal root', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const r = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor() }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    if (!r.seeded) return;
    expect(r.goalId).toBe('01-goal');
    expect(r.contract.intent).toBe('A working goal! seed command.');
    // the deterministic doc→contract: the realized-goal bullet + the validated claim
    expect(r.contract.acceptanceCriteria).toContain('goal.md locks on the goal root when the human confirms');
    expect(r.contract.acceptanceCriteria[0]).toBe('The validated goal is realized: A working goal! seed command.');

    // the authored doc is on disk + the LOCK is on the goal root (no D4 orphan goal.md)
    const md = readFileSync(goalDoc(), 'utf8');
    expect(md).toContain('Goal: A working goal! seed command.');
    expect(md).toContain('- goal.md locks on the goal root when the human confirms');
    const lock = commands.events('01-goal').find((e) => e.type === 'artifact-locked');
    expect(lock?.artifact).toMatchObject({ name: 'goal' });
    const verify = new Store(root).verify();
    expect(verify.some((d) => d.includes('artifact-orphan') && d.includes('goal.md'))).toBe(false);

    // the seeded session reads back: present · generated contract · OPEN (a bare seed is never exhausted)
    const g = commands.goal();
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.present).toBe(true);
    expect(g.value.contract?.intent).toBe('A working goal! seed command.');
    expect(g.value.verdict).toBe('open');
  });

  it('REJECT: a human verdict that is NOT solid seeds NOTHING', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const r = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor([], [], ['reject']) }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok || r.seeded) return;
    expect(r.verdict).toBe('reject');
    expect(existsSync(goalDoc())).toBe(false);
    expect(new Store(root).ids()).toEqual([]);
  });

  it('REVISE: a revise verdict seeds nothing and points the user at refining + retrying', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const r = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor([], [], ['revise']) }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok || r.seeded) return;
    expect(r.verdict).toBe('revise');
    expect(r.note).toContain("goal! seed '<goal>'");
    expect(new Store(root).ids()).toEqual([]);
  });

  it('GUARD: a NON-EMPTY journey refuses BEFORE any provider call (dogfoodable without a provider)', async () => {
    // a real leg node on disk BEFORE the store is constructed — nodes load at Store()
    root = mkdtempSync(join(tmpdir(), 'ann-goalseed-'));
    mkdirSync(join(legs(), '01-leg', 'artifacts'), { recursive: true });
    writeFileSync(join(legs(), '01-leg', 'node.json'), JSON.stringify({ id: '01-leg', contract: {} }));
    const commands = new Commands(new Store(root), 'test');
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor() }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('not-empty');
    expect(r.error.blocker).toContain('goal! archive for a new session');
    expect(calls.n).toBe(0); // the guard precedes the grill — no provider wiring needed to refuse
  });

  it('provider-absent fails CLOSED — the session returns ok:false and nothing is created', async () => {
    const commands = fresh();
    const { llm, calls } = throwingLlm('no provider reachable');
    const r = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor() }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('provider-unavailable');
    expect(calls.n).toBeGreaterThan(0); // the grill really tried the model
    expect(existsSync(goalDoc())).toBe(false);
    expect(new Store(root).ids()).toEqual([]);
  });

  it('GATHER: a blank argv idea asks the human channel before grilling', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([GOAL_IDEA]);
    const r = await runGoalSeed(commands, { llm, interact }, {}); // no idea → the human channel provides it

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    expect(interact.presented.some((p) => p.includes('Idea validation'))).toBe(true);
  });

  it('RE-SEED: goal! seed again on the SOLE UNCONSUMED goal re-grills and REPLACES goal.md + the regenerated contract + the lock', async () => {
    const commands = fresh();
    const grillWith = (summary: string) =>
      grill([{ verdict: 'ok', claim: 'buildable scope', basis: ['goal-session-design'], confidence: 'high' }], [], summary);
    const first = await runGoalSeed(commands, { llm: fakeLlm([grillWith('The FIRST goal framing.')]).llm, interact: new ScriptedInteractor() }, { idea: 'a first framing' });
    expect(first.ok && first.seeded).toBe(true);
    if (!first.ok || !first.seeded) return;

    // goal! seed AGAIN — the goal leg is still the journey's ONLY node and unconsumed → reseed replaces it
    const second = await runGoalSeed(commands, { llm: fakeLlm([grillWith('The REFINED goal framing.')]).llm, interact: new ScriptedInteractor() }, { idea: 'a sharper framing' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.seeded).toBe(true);
    if (!second.seeded) return;
    expect(second.goalId).toBe('01-goal'); // replaced IN PLACE — no second leg
    expect(second.contract.intent).toBe('The REFINED goal framing.');
    // the reseed overwrote goal.md — only the refined doc remains
    const md = readFileSync(goalDoc(), 'utf8');
    expect(md).toContain('The REFINED goal framing.');
    expect(md).not.toContain('The FIRST goal framing.');
    // still exactly one leg; the goal re-locked @ the new sha; the store reloads D2/D4-clean
    const verify = new Store(root).verify();
    expect(verify.some((d) => (d.includes('artifact-orphan') || d.includes('locksha')) && d.includes('goal'))).toBe(false);
    expect(new Store(root).ids()).toEqual(['01-goal']);
    // the goal view reads back reseedable — the refined sole goal is STILL re-seedable until consumed
    const g = commands.goal();
    expect(g.ok && g.value.reseed?.reseedable).toBe(true);
  });

  it('RE-SEED GUARD: once a work leg spawns AFTER the goal, goal! seed refuses (consumed → archive path) BEFORE any provider call', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const r1 = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor() }, { idea: GOAL_IDEA });
    expect(r1.ok && r1.seeded).toBe(true);

    // the first work leg spawned after the goal consumes goal.md → the goal is sealed
    expect(commands.spawn('02-work', { intent: 'build a work leg', acceptanceCriteria: ['it is done'] }).ok).toBe(true);

    const { llm: l2, calls } = throwingLlm('should never be reached');
    const r2 = await runGoalSeed(commands, { llm: l2, interact: new ScriptedInteractor() }, { idea: GOAL_IDEA });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe('not-empty');
    expect(r2.error.blocker).toContain('consumed by 02-work'); // the WHY names the consumer
    expect(r2.error.blocker).toContain('goal! archive'); // the change path is archive → new goal
    expect(calls.n).toBe(0); // the gate precedes the grill — dogfoodable without a provider
    expect(new Store(root).ids()).toEqual(['01-goal', '02-work']); // nothing was re-seeded
  });
});
