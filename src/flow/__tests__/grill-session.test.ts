import { describe, it, expect } from 'vitest';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { GrillSession, GrillProfile, DECISION_OPTIONS, EXHAUSTED_OPTIONS, roundRead } from '../grill-session.js';
import { GoalGrillSession, GOAL_GRILL_MODE, GOAL_DISCUSS_MODE, GOAL_PROFILE } from '../goal-grill.js';
import type { GrillQuestion } from '../steps/shared.js';

/**
 * THE PORTABLE CORE (flow/grill-session) + THE GOAL AREA (flow/goal-grill):
 *
 * The grilling LOOP is portable and area-neutral; each AREA registers a profile that
 * supplies ONLY what varies — the grill directive (with its AREA-SCOPED BOUNDARY), the
 * reasoning directive, the decision-weigh-in guidance, and copy. These tests prove:
 *  (a) the GOAL grill directive carries the PRODUCT BOUNDARY (grills WHAT/WHY only, and
 *      DEFERS any HOW to a later stage — the grill must not ask implementation questions);
 *  (b) behavior parity — the existing goal-grill + goal-seed suites pass under the
 *      refactored core (their tests are untouched; they exercise the GOAL-configured core);
 *  (c) PORTABILITY — GrillSession is area-agnostic: a second stub area injects DIFFERENT
 *      directive text while the loop runs IDENTICALLY (clean read → GO on an exhausted
 *      menu, and the reasoning path on a question round).
 */

/** A scripted human — FIFO answers/decisions; running out is the ABORT. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly decided: { question: string; options: string[] }[] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly decisions: string[] = [],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(question: string): Promise<string> {
    const a = this.answers.shift();
    if (a === undefined) throw new InteractAbort('scripted interactor ran out of answers');
    return a;
  }
  async research(): Promise<ResearchFinding[]> {
    return [];
  }
  async decide(question: string, options: string[]): Promise<string> {
    this.decided.push({ question, options });
    const d = this.decisions.shift();
    if (d === undefined) throw new InteractAbort('scripted interactor ran out of decisions');
    return d;
  }
}

const fakeLlm = (responses: string[]): { llm: LlmAbility; prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      prompts.push(req.prompt);
      const next = responses[i++];
      if (next === undefined) throw new Error('fake llm ran out of scripted responses');
      return next;
    },
  };
  return { llm, prompts };
};

const grill = (summary: string, validation: unknown[] = [], questions: unknown[] = []) =>
  JSON.stringify({ summary, validation, questions });

const clean = (summary: string, claim = 'the subject is checkable') =>
  grill(summary, [{ verdict: 'ok', claim, basis: [], confidence: 'high' }]);

const HIGH_Q = () => ({
  question: 'Which v1 marker is acceptable?',
  reason: 'defines scope',
  impact: 'high' as const,
  options: ['a', 'b'],
  default: 'a',
});

/** A MINIMAL second area — a totally different subject/boundary, registered ONLY to prove
 *  the engine is area-agnostic. Its directive text must differ from the GOAL directive
 *  while the loop beneath it runs identically. */
const STUB_PROFILE: GrillProfile = {
  id: 'system-design',
  title: 'System grill',
  noun: 'design',
  seedVerb: 'design! seed',
  goAction: 'Save now',
  focus: 'Grill a rough system design at architecture level; defer anything below.',
  grilling:
    'You are grilling a SYSTEM DESIGN at architecture level only — the components, their responsibilities, and the contracts between them. NEVER ask for code, libraries, or implementation minutiae — those belong to a later stage.',
  reasoning:
    'You are the REASONING half of a system-design grill. Interpret the answers at architecture level; defer any implementation minutiae to a later stage.',
  decisionWeighIn: {
    exhausted: 'The round is EXHAUSTED — no new architecture-level question stands: recommend GO unless the DRAFT is weak.',
    open: 'Recommend GO only if the design is coherent at architecture level; dig more if a real architectural unknown stands.',
  },
  refineAsk: 'What should change about the design? Say it in your own words — the next round grills what you say.',
  defaultMaxRounds: 40,
  defaultMaxDiscussTurns: 6,
};

describe('(a) the GOAL boundary — the grill stays at PRODUCT level', () => {
  it('GOAL_GRILL_MODE carries the product-level scope and the deferral rule', () => {
    // it says WHAT/WHY are grilled at product level …
    expect(GOAL_GRILL_MODE).toContain('PRODUCT level');
    expect(GOAL_GRILL_MODE).toMatch(/WHAT.*WHY/i);
    // … it names the HOW list as OUT of scope …
    for (const out of ['tech stack', 'data models', 'algorithms', 'API endpoints', 'internal architecture']) {
      expect(GOAL_GRILL_MODE.toLowerCase()).toContain(out.toLowerCase());
    }
    // … and it DEFERS a below-boundary topic to a later stage instead of grilling it
    expect(GOAL_GRILL_MODE).toContain('belongs to a later stage (spec / system-design / implementation)');
    expect(GOAL_GRILL_MODE).toContain('DEFER');
    expect(GOAL_GRILL_MODE).toContain('do NOT grill it');
  });

  it('the GOAL profile wires the boundary directive into the session (GoalGrillSession uses GOAL_PROFILE.grilling)', async () => {
    expect(GOAL_PROFILE.id).toBe('goal');
    expect(GOAL_PROFILE.grilling).toBe(GOAL_GRILL_MODE); // the directive under test is the one the session actually uses
    const q = HIGH_Q();
    const { llm, prompts } = fakeLlm([
      grill('A v1 goal.', [], [q]),
      'The marker is settled; nothing below product level needs answering.',
      JSON.stringify({ recommendation: 'GO', reason: 'the product-level goal reads seedable' }),
    ]);
    const interact = new ScriptedInteractor(['a', 'sorted'], ['GO']);
    const r = await new GoalGrillSession({ llm, interact }).run({ statement: 'Build a thing.', maxRounds: 3 });
    expect(r.ok && r.verdict === 'solid').toBe(true);
    expect(prompts[0]).toContain(GOAL_GRILL_MODE); // the FIRST grill prompt carries the product boundary
  });

  it('GOAL_DISCUSS_MODE reasons back at the SAME product boundary — a HOW is deferred, not dug', () => {
    expect(GOAL_DISCUSS_MODE).toContain('belongs to a later stage (spec / system-design / implementation)');
    expect(GOAL_DISCUSS_MODE).toMatch(/PRODUCT level/);
    expect(GOAL_DISCUSS_MODE.toLowerCase()).toContain('tech stack');
    expect(GOAL_DISCUSS_MODE).toContain('Never turn a HOW into a dig-more recommendation');
  });
});

describe('(c) PORTABILITY — GrillSession is area-agnostic; only the injected directives differ', () => {
  it('a second area with DIFFERENT directive text runs the SAME clean-read → GO on an exhausted menu', async () => {
    const { llm, prompts } = fakeLlm([clean('An architecture with two components.')]);
    const interact = new ScriptedInteractor([], ['GO']);
    const r = await new GrillSession({ llm, interact }, STUB_PROFILE).run({ subject: 'a rough design', maxRounds: 3 });

    // the loop ran IDENTICALLY: one grill → exhausted (nothing fresh, nothing open) →
    // straight to the decision → human GO → converged
    expect(r).toMatchObject({ ok: true, verdict: 'solid', statement: 'An architecture with two components.', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.okClaims).toEqual(['the subject is checkable']);
    expect(r.resolved).toEqual([]);
    expect(prompts).toHaveLength(1); // no synthesis/discussion — nothing to reason back
    // the INJECTED DIRECTIVES differ: the stub's grilling directive ran, never the GOAL one
    expect(prompts[0]).toContain('SYSTEM DESIGN');
    expect(prompts[0]).toContain('architecture level');
    expect(prompts[0]).not.toContain(GOAL_GRILL_MODE);
    // the area's own copy/headers are used (not 'Goal grill')
    expect(interact.presented.some((p) => p.includes('── System grill · round 1 ──'))).toBe(true);
    // exhaustion semantics are the SAME across areas: GO / refine / skip, no 'dig more'
    const decisionCalls = interact.decided.filter((d) => d.options.includes('GO'));
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].options).toEqual([...EXHAUSTED_OPTIONS]);
    // the GO verb comes from the PROFILE — the stub area's own copy, never the goal's 'Seed now'
    expect(decisionCalls[0].question).toContain('Save now (GO)');
    expect(decisionCalls[0].question).not.toContain('Seed now');
  });

  it('the reasoning path is area-neutral too: a question round on the stub uses the stub reasoning directive, not GOAL_DISCUSS_MODE', async () => {
    const q = HIGH_Q();
    const { llm, prompts } = fakeLlm([
      grill('An architecture.', [{ verdict: 'ok', claim: 'the split is sound', basis: [], confidence: 'high' }], [q]),
      'Stub read-back: the marker is settled.',
      JSON.stringify({ recommendation: 'GO', reason: 'the architecture is coherent at this level' }),
    ]);
    const interact = new ScriptedInteractor(['a', 'sorted'], ['GO']);
    const r = await new GrillSession({ llm, interact }, STUB_PROFILE).run({ subject: 'a rough design', maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid' });
    // the batch → synthesis → DECISION sequence is the same mechanics the GOAL tests prove
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(STUB_PROFILE.reasoning); // the stub's reasoning directive
    expect(prompts[1]).not.toContain(GOAL_DISCUSS_MODE); // never the goal one
    // a NON-exhausted round offers the full four options — same as the GOAL area
    const decisionCalls = interact.decided.filter((d) => d.options.includes('GO'));
    expect(decisionCalls[0].options).toEqual([...DECISION_OPTIONS]);
  });
});

describe('the round READ render (roundRead) — show-me: crux first, only the actionable rows', () => {
  const q = (over: Partial<GrillQuestion> = {}): GrillQuestion => ({
    id: 'q1',
    question: 'Which v1 marker is acceptable?',
    reason: 'defines scope',
    impact: 'high',
    default: 'a',
    ...over,
  });

  it('prints the GOAL line first, then ONLY the concern/blocking rows, the ok count, and the numbered answer batch with ONE frontier marker', () => {
    const text = roundRead(
      'Goal grill',
      'goal',
      1,
      'A v1 goal.',
      [
        { verdict: 'ok', claim: 'scope is settled' },
        { verdict: 'ok', claim: 'a second ok' },
        { verdict: 'concern', claim: 'offline is over-promised' },
        { verdict: 'blocking', claim: 'no checkable outcome' },
      ],
      [q(), q({ id: 'q2', question: 'Which platform first?', impact: 'medium', default: 'web' })],
    );
    expect(text).toBe(
      [
        '── Goal grill · round 1 ──',
        'GOAL (as it reads): A v1 goal.',
        '',
        'In the way (fix these):',
        '  ▸ offline is over-promised',
        '  ▸ no checkable outcome',
        '',
        '✓ 2 settled',
        '',
        'Answer (one word — default = my pick):',
        '  1. Which v1 marker is acceptable?  → a  ← frontier',
        '  2. Which platform first?  → web',
      ].join('\n'),
    );
  });

  it('omits the answer batch when nothing is open, the in-the-way list when nothing is in the way, and the settled count when there are no ok rows', () => {
    expect(roundRead('Goal grill', 'goal', 2, 'A clean v1.', [{ verdict: 'ok', claim: 'scope is checkable' }], [])).toBe(
      ['── Goal grill · round 2 ──', 'GOAL (as it reads): A clean v1.', '', '✓ 1 settled'].join('\n'),
    );
    expect(roundRead('Goal grill', 'goal', 2, 'A clean v1.', [], [])).toBe('── Goal grill · round 2 ──\nGOAL (as it reads): A clean v1.');
  });

  it('renders the area label from the noun — a stub area reads DESIGN, not GOAL', () => {
    const text = roundRead('System grill', 'design', 1, 'An architecture.', [{ verdict: 'concern', claim: 'the split is fuzzy' }], []);
    expect(text).toContain('── System grill · round 1 ──');
    expect(text).toContain('DESIGN (as it reads): An architecture.');
    expect(text).not.toContain('GOAL');
  });
});
