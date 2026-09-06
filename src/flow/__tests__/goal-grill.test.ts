import { describe, it, expect } from 'vitest';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { GoalGrillSession, GOAL_GRILL_MODE } from '../goal-grill.js';

/**
 * The GOAL GRILL (flow/goal-grill) — the goal-scope loop that goal! seed runs: a
 * bounded, multi-round grill that refines a rough goal IN-SESSION (a 'revise' is NOT
 * terminal — it refines the statement and the next round re-grills it), never re-asks,
 * researches high-impact unknowns, always shows a round summary before the decision, and
 * on the rounds running out ends with a full summary — never a bare 'not seeded'.
 */

/** A scripted human — FIFO answers/decisions; running out is the ABORT (a departure to
 *  record, never a blank to infer). Research findings are FIFO per call. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly asked: string[] = [];
  readonly researchCalls: string[][] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly findingsQueue: ResearchFinding[][] = [],
    private readonly decisions: string[] = [],
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

/** A fake llm — sequential grill completions (one per round); records prompts so tests
 *  can prove a later round BUILT on what the earlier one answered. */
const fakeLlm = (responses: string[]): { llm: LlmAbility; prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      prompts.push(req.prompt);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
  return { llm, prompts };
};

const session = (llm: LlmAbility, interact: InteractAbility) => new GoalGrillSession({ llm, interact });

const grill = (summary: string, validation: unknown[] = [], questions: unknown[] = []) =>
  JSON.stringify({ summary, validation, questions });

const clean = (summary: string, claim = 'the goal is scoped and buildable') =>
  grill(summary, [{ verdict: 'ok', claim, basis: [], confidence: 'high' }]);

const highQ = (text = 'What round bound must the grill honor?') => ({
  question: text,
  reason: 'bounds the loop',
  impact: 'high' as const,
  options: ['2', '3', '5'],
  default: '3',
});

describe('GoalGrillSession — the goal-scope grill (goal! seed)', () => {
  it('GO on a clean read returns the refined goal + what the read validated', async () => {
    const { llm, prompts } = fakeLlm([clean('A working goal! seed command.')]);
    const interact = new ScriptedInteractor([], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', goal: 'A working goal! seed command.', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.okClaims).toEqual(['the goal is scoped and buildable']);
    expect(r.resolved).toEqual([]);
    // goal-mode instruction was fed to the model; the read + round summary were shown
    expect(prompts[0]).toContain('Goal-mode instructions');
    expect(prompts[0]).toContain(GOAL_GRILL_MODE);
    expect(interact.presented.some((p) => p.includes('Goal grill — round 1 of 3'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('Round 1 summary'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('Goal as it reads now: A working goal! seed command.'))).toBe(true);
  });

  it('REVISE refines the statement IN-SESSION; the next round re-grills it — ≥2 grills, no question twice, round summary before the GO', async () => {
    const refined = 'A goal! seed command that re-grills a revised goal in a bounded session.';
    const round1 = grill('A goal! seed command.', [{ verdict: 'ok', claim: 'grill bound needed', basis: [], confidence: 'high' }], [highQ()]);
    // round 2 re-raises the SAME question — the session must NOT ask it again
    const round2 = grill(refined, [{ verdict: 'ok', claim: 'revised goal is scoped', basis: [], confidence: 'high' }], [highQ()]);
    const { llm, prompts } = fakeLlm([round1, round2]);
    const interact = new ScriptedInteractor(['3', refined], [], ['REVISE', 'GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.rounds).toBe(2); // the revise round did not end the session — it re-grilled
    expect(r.goal).toBe(refined); // the refined statement the human approved is what GO returns
    expect(r.resolved).toEqual([{ id: 'q1', question: 'What round bound must the grill honor?', answer: '3', impact: 'high' }]);
    // the SECOND grill built on the first: it was fed the refined statement AND the answer
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('re-grills a revised goal');
    expect(prompts[1]).toContain('3');
    // never ask twice: the high-impact question was asked exactly once, though round 2 re-raised it
    expect(interact.asked.filter((a) => a.includes('What round bound'))).toHaveLength(1);
    // a ROUND SUMMARY was shown before each decision
    expect(interact.presented.some((p) => p.includes('Round 1 summary'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('Round 2 summary'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('Goal as it reads now: A goal! seed command that re-grills a revised goal in a bounded session.'))).toBe(true);
  });

  it('high-impact open questions become research topics; findings fold back with provenance', async () => {
    const q = highQ();
    const { llm } = fakeLlm([grill('A goal! seed command.', [], [q])]);
    const interact = new ScriptedInteractor(
      ['skip'], // unresolved → a research topic
      [[{ topic: 'What round bound must the grill honor?', findings: 'Three rounds is the flow-control norm.', sources: ['ann docs'] }]],
      ['GO'],
    );
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(interact.researchCalls).toEqual([['What round bound must the grill honor?']]); // research ran
    expect(r.researchLog).toEqual([{ topic: 'What round bound must the grill honor?', findings: 'Three rounds is the flow-control norm.', sources: ['ann docs'] }]);
    expect(r.resolved).toEqual([{ id: 'q1', question: 'What round bound must the grill honor?', answer: 'Three rounds is the flow-control norm.', impact: 'high' }]);
  });

  it('while meaningful unknowns remain the decision offers RESEARCH; a deeper dig folds and the next round re-grills', async () => {
    const q = { question: 'Which v1 scope marker is acceptable?', reason: 'defines v1 scope', impact: 'medium' as const, options: ['a', 'b'], default: 'a' };
    const { llm } = fakeLlm([grill('A goal! seed command.', [], [q]), clean('A scoped goal! seed command.')]);
    const interact = new ScriptedInteractor(
      ['skip', 'Which v1 scope marker is acceptable?'], // medium q skipped → open → RESEARCH → human names the topic
      [[{ topic: 'Which v1 scope marker is acceptable?', findings: 'v1 accepts only the "a" marker.', sources: ['workshop'] }]],
      ['RESEARCH', 'GO'],
    );
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(interact.researchCalls).toHaveLength(1); // the human-triggered research ran (auto research only digs high-impact)
    expect(r.researchLog).toEqual([{ topic: 'Which v1 scope marker is acceptable?', findings: 'v1 accepts only the "a" marker.', sources: ['workshop'] }]);
    expect(r.resolved).toEqual([expect.objectContaining({ question: 'Which v1 scope marker is acceptable?', impact: 'medium' })]);
    expect(r.rounds).toBe(2);
  });

  it('rounds exhausted with no GO → a FULL summary + an honest note — never a bare not-seeded', async () => {
    const { llm } = fakeLlm([clean('Reading one.'), clean('Reading two.')]);
    const interact = new ScriptedInteractor(['unknown', 'unknown'], [], ['REVISE', 'REVISE']); // revise but never refine
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 2 });

    expect(r).toMatchObject({ ok: true, verdict: 'exhausted', rounds: 2 });
    if (!r.ok || r.verdict !== 'exhausted') return;
    expect(r.note).toContain('ran out of rounds');
    expect(r.note).toContain('nothing was created');
    // the full summary lists where it landed + how to continue
    expect(interact.presented.some((p) => p.includes('Goal grill — no rounds left'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('To continue: re-run goal! seed with a sharper statement'))).toBe(true);
  });

  it('SKIP ends the grill — nothing created', async () => {
    const { llm } = fakeLlm([clean('A reading.')]);
    const interact = new ScriptedInteractor([], [], ['SKIP']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.' });

    expect(r).toMatchObject({ ok: true, verdict: 'reject', reason: 'skipped' });
    if (!r.ok || r.verdict !== 'reject') return;
    expect(r.note).toContain('nothing was created');
  });

  it('an InteractAbort (the human walked away) is a REJECT — never a blank answer', async () => {
    const { llm } = fakeLlm([grill('A reading.', [], [highQ()])]);
    const interact = new ScriptedInteractor([], [], []); // no answers, no decisions
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.' });

    expect(r).toMatchObject({ ok: true, verdict: 'reject', reason: 'aborted' });
    if (!r.ok || r.verdict !== 'reject') return;
    expect(r.note).toContain('aborted');
  });

  it('provider/adapter failure fails CLOSED — nothing fabricated', async () => {
    const llm: LlmAbility = {
      async complete() {
        throw new Error('provider down');
      },
    };
    const r = await session(llm, new ScriptedInteractor()).run({ statement: 'Build a goal! seed command.' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blocker).toContain('provider down');
  });
});
