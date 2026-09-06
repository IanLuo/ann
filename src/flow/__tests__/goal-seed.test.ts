import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { runGoalSeed } from '../goal-seed.js';

/**
 * The `goal! seed` MATERIALIZE PATH (flow/goal-seed) — the goal grill at SESSION scope →
 * on a HUMAN GO, the deterministic goal.md synthesis → L1 seedGoal + the goal.md
 * artifact-lock. Same scripted-abilities pattern as the goal-grill session tests: the
 * ability SET is injected, so the driver runs headless. The grill semantics themselves
 * (the v4 ANSWER → LLM RESPONSE → DISCUSS → DECISION loop, dedupe, discussion-advised
 * research) are proven in goal-grill.test; here the SEED and its guards are proven
 * through the store.
 */

/** A scripted human — FIFO answers/decisions (running out is the ABORT), FIFO research
 *  findings per call, and it RECORDS every ask so tests can prove nothing was re-asked. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly asked: string[] = [];
  readonly researchCalls: string[][] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly findingsQueue: ResearchFinding[][] = [],
    private readonly decisions: string[] = ['GO'],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(question: string): Promise<string> {
    this.asked.push(question);
    const a = this.answers.shift();
    if (a === undefined) throw new InteractAbort('scripted interactor ran out of answers');
    return a;
  }
  async research(topics: string[]): Promise<ResearchFinding[]> {
    this.researchCalls.push(topics);
    return this.findingsQueue.shift() ?? [];
  }
  async decide(_question: string, _options: string[]): Promise<string> {
    const d = this.decisions.shift();
    if (d === undefined) throw new InteractAbort('scripted interactor ran out of decisions');
    return d;
  }
}

/** A fake llm — sequential grill completions (one per round); counts calls so the
 *  guard/provider tests can assert WHEN the model ran. */
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

const grill = (summary: string, validation: unknown[] = [], questions: unknown[] = []) =>
  JSON.stringify({ summary, validation, questions });

const cleanGrill = (summary = 'A working goal! seed command.') =>
  grill(summary, [{ verdict: 'ok', claim: 'goal.md locks on the goal root when the human confirms', basis: [], confidence: 'high' }]);

const GOAL_IDEA = 'Build a working goal! seed command that grills the goal at session scope.';
const BOUND_Q = 'What round bound must the grill honor?';

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

  it('GO on a clean grill seeds once: the refined goal is criterion 1, the validated claim a criterion, goal.md locked', async () => {
    const commands = fresh();
    const { llm, calls } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], ['GO']);
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    if (!r.seeded) return;
    expect(calls.n).toBe(1); // one grill, one round, one GO
    expect(r.goalId).toBe('01-goal');
    expect(r.contract.intent).toBe('A working goal! seed command.');
    // REAL criteria: the refined outcome sentence first (not the vacuous wrapper) …
    expect(r.contract.acceptanceCriteria[0]).toBe('A working goal! seed command.');
    // … then the validated-ok commitment the realized goal must keep true
    expect(r.contract.acceptanceCriteria).toContain('goal.md locks on the goal root when the human confirms');

    // the authored doc is on disk + the LOCK is on the goal root (no D4 orphan goal.md)
    const md = readFileSync(goalDoc(), 'utf8');
    expect(md).toContain('Goal: A working goal! seed command.');
    expect(md).toContain('- goal.md locks on the goal root when the human confirms');
    const lock = commands.events('01-goal').find((e) => e.type === 'artifact-locked');
    expect(lock?.artifact).toMatchObject({ name: 'goal' });
    const verify = new Store(root).verify();
    expect(verify.some((d) => d.includes('artifact-orphan') && d.includes('goal.md'))).toBe(false);

    const g = commands.goal();
    expect(g.ok && g.value.present && g.value.verdict === 'open').toBe(true);
  });

  it('refine reshapes the goal in-session and GO seeds the REFINED goal (≥2 grills, no question asked twice, the read-back shown)', async () => {
    const commands = fresh();
    const refined = 'A goal! seed command that re-grills a revised goal and reseeds a sole unconsumed goal.';
    const r1 = grill('A goal! seed command.', [{ verdict: 'ok', claim: 'grill bound needed', basis: [], confidence: 'high' }], [
      { question: BOUND_Q, reason: 'bounds the loop', impact: 'high', options: ['2', '3', '5'], default: '3' },
    ]);
    // round 2 re-raises the SAME question — the session must not ask it again
    const r2 = cleanGrill(refined);
    const { llm, calls } = fakeLlm([
      r1,
      'The bound is settled at three; the goal should also fold reseeding in — I recommend refining before GO.',
      r2,
    ]);
    const interact = new ScriptedInteractor(['3', 'sorted', 'the goal should also cover reseeding a sole unconsumed goal'], [], ['refine', 'GO']);
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    if (!r.seeded) return;
    expect(calls.n).toBeGreaterThanOrEqual(2); // the refine round was RE-GRILLED, not ended
    expect(r.contract.intent).toBe(refined); // the seed carries the REFINED goal
    const md = readFileSync(goalDoc(), 'utf8');
    expect(md).toContain('reseeds a sole unconsumed goal'); // the refinement folded into the doc
    // the resolved high-impact answer imposed a criterion (the bound the goal must honor)
    expect(r.contract.acceptanceCriteria).toContain(`${BOUND_Q} → 3`);
    // never ask twice: the bound question was asked exactly once though round 2 re-raised it
    expect(interact.asked.filter((a) => a.includes(BOUND_Q))).toHaveLength(1);
    // the LLM RESPONSE (the answers read back) was shown after the batch, before the decision
    expect(interact.presented.some((p) => p.includes('your answers, read back'))).toBe(true);
    expect(new Store(root).ids()).toEqual(['01-goal']);
  });

  it('a discussion-advised research (the LLM advises, the human agrees) resolves the unknown; the constraint lands in the goal.md criteria', async () => {
    const commands = fresh();
    const discussAdvice = JSON.stringify({
      reply: 'The bound is the open high-impact item — let me pull the flow-control docs.',
      research: { topic: BOUND_Q, reason: 'to settle the round bound' },
    });
    const discussAfter = JSON.stringify({
      reply: 'The docs confirm three rounds as the norm — the bound is now settled.',
      research: null,
    });
    const { llm } = fakeLlm([
      grill('A working goal! seed command.', [{ verdict: 'ok', claim: 'the round bound matters', basis: [], confidence: 'high' }], [
        { question: BOUND_Q, reason: 'bounds the loop', impact: 'high', options: ['2', '3', '5'], default: '3' },
      ]),
      'The bound is the only open edge; a dig would settle it.',
      discussAdvice,
      discussAfter,
    ]);
    const interact = new ScriptedInteractor(
      ['skip', 'Pull the docs.', 'sorted'], // skipped → stays open → the LLM advises research DURING discussion → the human agrees
      [[{ topic: BOUND_Q, findings: 'Three rounds is the flow-control norm.', sources: ['ann docs'] }]],
      ['yes', 'GO'],
    );
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    if (!r.seeded) return;
    expect(interact.researchCalls).toEqual([[BOUND_Q]]); // research ran, advised + agreed, mid-discussion
    expect(r.contract.acceptanceCriteria).toContain(`${BOUND_Q} → Three rounds is the flow-control norm.`);
  });

  it('SKIP ends with nothing created — an honest note', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], ['SKIP']);
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok || r.seeded) return;
    expect(r.verdict).toBe('reject');
    expect(r.note).toContain('skipped');
    expect(existsSync(goalDoc())).toBe(false);
    expect(new Store(root).ids()).toEqual([]);
  });

  it('dig-more with the rounds running out → a FULL close-out, nothing created, and an honest how-to-continue', async () => {
    const commands = fresh();
    const closeText = 'Two rounds dug and no open edge surfaced; the goal reads as a solid v1. To continue, re-run goal! seed sharper or raise the round bound.';
    const { llm } = fakeLlm([cleanGrill('Reading one.'), cleanGrill('Reading two.'), closeText]);
    const interact = new ScriptedInteractor([], [], ['dig more', 'dig more']); // keep digging to the last round, never a GO
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA, maxRounds: 2 });

    expect(r.ok).toBe(true);
    if (!r.ok || r.seeded) return;
    expect(r.verdict).toBe('revise'); // the value that recommends a sharper re-run
    expect(r.note).toContain('ran out of rounds');
    expect(r.note).toContain('nothing was created');
    // the driver showed the FULL close-out — resolved · open · the goal as it reads
    expect(interact.presented.some((p) => p.includes('Goal grill — no rounds left'))).toBe(true);
    expect(interact.presented.some((p) => p.includes(closeText))).toBe(true);
    expect(existsSync(goalDoc())).toBe(false);
    expect(new Store(root).ids()).toEqual([]);
  });

  it('an abort mid-grill (the human walked away) seeds nothing', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], []); // no decisions → the first decide aborts
    const r = await runGoalSeed(commands, { llm, interact }, { idea: GOAL_IDEA });

    expect(r.ok).toBe(true);
    if (!r.ok || r.seeded) return;
    expect(r.verdict).toBe('reject');
    expect(new Store(root).ids()).toEqual([]);
  });

  it('GUARD: a NON-EMPTY journey refuses BEFORE any provider call (dogfoodable without a provider)', async () => {
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
    const interact = new ScriptedInteractor([GOAL_IDEA], [], ['GO']);
    const r = await runGoalSeed(commands, { llm, interact }, {}); // no idea → the human channel provides it

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seeded).toBe(true);
    expect(interact.presented.some((p) => p.includes('Goal grill'))).toBe(true);
  });

  it('RE-SEED: goal! seed again on the SOLE UNCONSUMED goal re-grills and REPLACES goal.md + the regenerated contract + the lock', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill('The FIRST goal framing.')]);
    const first = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor([], [], ['GO']) }, { idea: 'a first framing' });
    expect(first.ok && first.seeded).toBe(true);
    if (!first.ok || !first.seeded) return;

    // goal! seed AGAIN — the goal leg is still the journey's ONLY node and unconsumed → reseed replaces it
    const { llm: l2 } = fakeLlm([cleanGrill('The REFINED goal framing.')]);
    const second = await runGoalSeed(commands, { llm: l2, interact: new ScriptedInteractor([], [], ['GO']) }, { idea: 'a sharper framing' });
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
    const g = commands.goal();
    expect(g.ok && g.value.reseed?.reseedable).toBe(true);
  });

  it('RE-SEED GUARD: once a work leg spawns AFTER the goal, goal! seed refuses (consumed → archive path) BEFORE any provider call', async () => {
    const commands = fresh();
    const { llm } = fakeLlm([cleanGrill()]);
    const r1 = await runGoalSeed(commands, { llm, interact: new ScriptedInteractor([], [], ['GO']) }, { idea: GOAL_IDEA });
    expect(r1.ok && r1.seeded).toBe(true);

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
