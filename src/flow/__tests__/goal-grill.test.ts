import { describe, it, expect } from 'vitest';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { GoalGrillSession, GOAL_GRILL_MODE, GOAL_DISCUSS_MODE } from '../goal-grill.js';

/**
 * THE GOAL GRILL (flow/goal-grill) v4 — the goal-scope loop that goal! seed runs:
 *
 *   ANSWER → LLM RESPONSE → DISCUSS → (next round)
 *
 * a bounded, multi-round grill that refines a rough goal IN-SESSION. Each round: grill →
 * the human answers a batch → the LLM REASONS THE ANSWERS BACK (a synthesis turn) →
 * a bounded multi-turn DISCUSS (the LLM may recommend ONE research topic, which runs
 * only when the human agrees, folds, and the LLM responds again) → an explicit
 * DECISION whose menu is EXHAUSTION-DRIVEN: a round whose grill raised no fresh questions
 * and left nothing meaningful open offers only GO / refine / skip (no 'dig more' — the
 * branches are empty); otherwise the full GO / dig more / refine / skip menu stands and
 * the session continues while the human digs. The loop ends on GO, a skip/abort, or the
 * anti-runaway ceiling — a safety net, never the normal end — which closes with a full
 * synthesis, never a bare 'not seeded'.
 */

/** A scripted human — FIFO answers/decisions; running out is the ABORT (a departure to
 *  record, never a blank to infer). Research findings are FIFO per call. Records every
 *  ask and every decide so tests can prove options and never-re-ask. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly asked: string[] = [];
  readonly decided: { question: string; options: string[] }[] = [];
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
  async decide(question: string, options: string[]): Promise<string> {
    this.decided.push({ question, options });
    const d = this.decisions.shift();
    if (d === undefined) throw new InteractAbort('scripted interactor ran out of decisions');
    return d;
  }
}

/** A fake llm — sequential completions (one per grill/synthesis/discuss/close turn);
 *  records every prompt so tests can prove a later turn BUILT on earlier ones. Running
 *  out is a loud failure (an under-scripted test must not silently re-use a response). */
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

const session = (llm: LlmAbility, interact: InteractAbility) => new GoalGrillSession({ llm, interact });

const grill = (summary: string, validation: unknown[] = [], questions: unknown[] = []) =>
  JSON.stringify({ summary, validation, questions });

const clean = (summary: string, claim = 'the goal is scoped and buildable') =>
  grill(summary, [{ verdict: 'ok', claim, basis: [], confidence: 'high' }]);

/** An in-discussion LLM reply — strict JSON with an OPTIONAL research recommendation. */
const discuss = (reply: string, research?: unknown) => JSON.stringify({ reply, ...(research ? { research } : {}) });

/** A DECISION turn — strict JSON: the grill's grounded recommendation the human decides against. */
const decision = (recommendation: string, reason: string) => JSON.stringify({ recommendation, reason });

const HIGH_Q = () => ({
  question: 'Which v1 scope marker is acceptable?',
  reason: 'defines v1 scope',
  impact: 'high' as const,
  options: ['a', 'b'],
  default: 'a',
});

/** The after-round DECISION calls (the research yes/no gates never carry a GO option, so
 *  they fall out of the filter). */
const decisionCalls = (i: ScriptedInteractor) => i.decided.filter((d) => d.options.includes('GO'));

/** The FOUR options a NON-exhausted round's DECISION offers. */
const DECISION_OPTIONS = ['GO', 'dig more', 'refine', 'skip'];
/** The THREE options an EXHAUSTED round's DECISION offers — 'dig more' is gone: a round
 *  whose grill raised no fresh questions and left nothing meaningful open has no branches
 *  left to dig, so the menu is GO / refine / skip and GO is the natural call. */
const EXHAUSTED_OPTIONS = ['GO', 'refine', 'skip'];
const everyDecisionOffersAllFour = (i: ScriptedInteractor) => {
  const calls = decisionCalls(i);
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c.options).toEqual(DECISION_OPTIONS);
};
const everyDecisionOffersExhausted = (i: ScriptedInteractor) => {
  const calls = decisionCalls(i);
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c.options).toEqual(EXHAUSTED_OPTIONS);
};

describe('GoalGrillSession v4 — ANSWER → LLM RESPONSE → DISCUSS → (round)', () => {
  it('(a) batch answers → an LLM RESPONSE (synthesis) happens before any decision, and GO returns the read', async () => {
    const q = HIGH_Q();
    const synth = 'The bound of three reads cleanly and "a" as the v1 marker settles scope. My recommendation: GO.';
    const { llm, prompts } = fakeLlm([
      grill('A v1 goal with a fixed scope marker.', [{ verdict: 'ok', claim: 'scope is checkable', basis: [], confidence: 'high' }], [q]),
      synth,
      decision('GO', 'the marker and the bound are settled — the goal is seedable'),
    ]);
    const interact = new ScriptedInteractor(['a', 'sorted'], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', goal: 'A v1 goal with a fixed scope marker.', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.resolved).toEqual([{ id: 'q1', question: q.question, answer: 'a', impact: 'high' }]);
    expect(r.okClaims).toEqual(['scope is checkable']);
    // the model calls before the decision: the grill, then the RESPONSE (synthesis),
    // then the DECISION turn that weighs the round — a bare list of answers is never
    // what the human sees before deciding
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Goal-mode instructions');
    expect(prompts[0]).toContain(GOAL_GRILL_MODE);
    expect(prompts[1]).toContain(GOAL_DISCUSS_MODE);
    // the synthesis was PRESENTED to the human before the DECISION
    const synthIndex = interact.presented.findIndex((p) => p.includes(synth));
    expect(synthIndex).toBeGreaterThan(-1);
    // the header carries no fixed 'of N' total — the loop is exhaustion-driven
    expect(interact.presented.some((p) => p.includes('── Goal grill · round 1 ──'))).toBe(true);
    // the decision offered exactly the four v4 options
    everyDecisionOffersAllFour(interact);
  });

  it('the round READ is show-me: GOAL line first, ONLY concern/blocking rows shown (ok collapsed to a count), numbered questions with the frontier marked — no ground/confidence noise', async () => {
    const concernClaim = 'the draft over-promises offline support';
    const q = HIGH_Q();
    const { llm } = fakeLlm([
      grill(
        'A v1 goal that ships web first.',
        [
          { verdict: 'ok', claim: 'scope is checkable', basis: [], confidence: 'high' },
          { verdict: 'concern', claim: concernClaim, basis: [], confidence: 'high' },
        ],
        [q],
      ),
      'My call: GO — the marker settles scope and web-first bounds the draft.',
      decision('GO', 'the scope marker is settled and web-first bounds the draft'),
    ]);
    const interact = new ScriptedInteractor(['a', 'sorted'], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    const read = interact.presented[0]; // the round read is what the human sees first
    expect(read).toContain('── Goal grill · round 1 ──');
    expect(read).toContain('GOAL (as it reads): A v1 goal that ships web first.');
    expect(read).toContain('In the way (fix these):');
    expect(read).toContain(`  ▸ ${concernClaim}`); // the concern claim still reaches the human
    expect(read).toContain('✓ 1 settled'); // the ok row is collapsed to a count …
    expect(read).not.toContain('scope is checkable'); // … never shown inline
    expect(read).not.toContain('[ok]'); // no validation-wall brackets
    expect(read).not.toContain('ground:'); // no provenance noise in the read
    expect(read).toContain('  1. Which v1 scope marker is acceptable?  → a  ← frontier'); // numbered, default inline, ONE frontier marker
  });

  it('GO on a clean read (no questions, no concerns) skips straight to the decision', async () => {
    const { llm, prompts } = fakeLlm([clean('A working goal! seed command.')]);
    const interact = new ScriptedInteractor([], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', goal: 'A working goal! seed command.', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(prompts).toHaveLength(1); // nothing to reason back → no synthesis, no discussion
    expect(r.okClaims).toEqual(['the goal is scoped and buildable']);
    expect(r.resolved).toEqual([]);
    expect(interact.asked).toEqual([]);
  });

  it('EXHAUSTION ends the loop: a converged round (no fresh questions, nothing open) reaches a decision WITHOUT dig more, and GO seeds on round 1', async () => {
    const { llm, prompts } = fakeLlm([clean('A working goal! seed command.')]);
    const interact = new ScriptedInteractor([], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(prompts).toHaveLength(1); // exhausted → nothing to reason back → one grill, one decision
    // the round raised no fresh questions and nothing meaningful is open → EXHAUSTED: the
    // decision offered EXACTLY GO/refine/skip — 'dig more' is not on the menu
    everyDecisionOffersExhausted(interact);
    // and the loop ENDED here — round 1 only, never advanced to a round 2
    expect(interact.presented.filter((p) => p.includes('── Goal grill · round '))).toHaveLength(1);
  });

  it('(b) after the response a human message gets ANOTHER LLM turn — the discussion is multi-turn AND bounded', async () => {
    const q = HIGH_Q();
    const synth = 'The scope marker is settled; the criterion can be tighter.';
    const { llm, prompts } = fakeLlm([
      grill('A v1 goal.', [], [q]),
      synth,
      discuss('I can tighten that into a checkable success criterion.', null),
      discuss('The offline case is out of v1 scope — the goal should not promise it.', null),
      decision('GO', 'the bound fired and the criterion is checkable — seedable'),
    ]);
    // maxDiscussTurns 2: the human never says 'sorted', so the bound itself must end the
    // discussion and reach the DECISION (had it kept asking, the FIFO would abort).
    const interact = new ScriptedInteractor(['a', 'Can you make the success criterion checkable?', 'What about offline?'], [], ['GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3, maxDiscussTurns: 2 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    // grill + synthesis + two discussion turns + the decision turn — no third discuss turn past the bound
    expect(prompts).toHaveLength(5);
    expect(interact.presented.some((p) => p.includes('I can tighten that into a checkable success criterion.'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('The offline case is out of v1 scope'))).toBe(true);
    // reaching the DECISION (solid GO) without the human ever saying 'sorted' proves the bound fired
    everyDecisionOffersAllFour(interact);
  });

  it('(c) the DECISION asks GO/dig more/refine/skip; dig more → a new round builds on ALL prior input, ≥2 grills, no question twice', async () => {
    const q1 = HIGH_Q();
    const q2 = { question: 'Which platform ships first?', reason: 'sequencing', impact: 'medium' as const, options: ['ios', 'web'], default: 'web' };
    const round1 = grill('A scoped v1 goal.', [{ verdict: 'ok', claim: 'v1 scope marker matters', basis: [], confidence: 'high' }], [q1]);
    const round2 = grill('A scoped v1 goal with a first platform.', [{ verdict: 'ok', claim: 'sequencing is settled', basis: [], confidence: 'high' }], [q1, q2]); // re-raises q1 — must NOT re-ask
    const { llm, prompts } = fakeLlm([
      round1,
      'Round 1 read-back.',
      decision('dig more', 'the v1 marker is settled but the platform is open'),
      round2,
      'Round 2 read-back.',
      decision('GO', 'both open items are settled — seedable'),
    ]);
    const interact = new ScriptedInteractor(['a', 'sorted', 'web', 'sorted'], [], ['dig more', 'GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.rounds).toBe(2); // dig more did not end the session — it re-grilled
    expect(r.resolved).toEqual([
      { id: 'q1', question: q1.question, answer: 'a', impact: 'high' },
      { id: 'q2', question: q2.question, answer: 'web', impact: 'medium' },
    ]);
    // never ask twice: q1 (re-raised in round 2) was asked exactly once, q2 once
    expect(interact.asked.filter((a) => a.includes(q1.question))).toHaveLength(1);
    expect(interact.asked.filter((a) => a.includes(q2.question))).toHaveLength(1);
    // two grills; the SECOND grill was fed the round-1 answer AND the refined reading
    expect(prompts[0]).toContain('Build a goal! seed command.'); // round 1 grills the raw statement
    expect(prompts[3]).toContain('A scoped v1 goal.'); // round 2 grills the refined draft
    expect(prompts[3]).toContain('user input]: a'); // the round-1 answer is grounded context it must build on, not re-ask
    // every DECISION (round 1 + round 2) offered exactly the four options
    everyDecisionOffersAllFour(interact);
    expect(decisionCalls(interact)).toHaveLength(2);
  });

  it('refine reshapes the goal IN-SESSION; the next round grills the human’s words, and GO returns the refined reading', async () => {
    const refined = 'A goal that also ships offline on day one.';
    const round1 = grill('A v1 goal.', [{ verdict: 'ok', claim: 'scope marker needed', basis: [], confidence: 'high' }], [HIGH_Q()]);
    const round2 = clean('A v1 goal that ships offline on day one.');
    const { llm, prompts } = fakeLlm([round1, 'Read-back one.', decision('refine', 'the draft must not over-promise scope'), round2]);
    const interact = new ScriptedInteractor(['a', 'sorted', refined], [], ['refine', 'GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.goal).toBe('A v1 goal that ships offline on day one.');
    expect(r.rounds).toBe(2);
    // the second grill grills the human's OWN words, not the previous reading
    expect(prompts[3]).toContain('ships offline on day one');
    expect(interact.asked).toContain('What should change about the goal? Refine the goal statement in your own words — the next round grills what you say here.');
  });

  it('(d) research runs ONLY when the LLM advises it AND the human agrees — findings fold in and the LLM responds again', async () => {
    const q = HIGH_Q();
    const { llm, prompts } = fakeLlm([
      grill('A v1 goal.', [{ verdict: 'ok', claim: 'scope is the open edge', basis: [], confidence: 'high' }], [q]),
      'Read-back one.',
      discuss('The open high-impact item is the scope marker — let me dig the workshop.', { topic: q.question, reason: 'to settle v1 scope' }),
      discuss('The workshop confirms the "a" marker — v1 scope is now settled.', null),
      decision('GO', 'the scope marker is grounded by the workshop finding — seedable'),
    ]);
    const interact = new ScriptedInteractor(
      ['skip', 'Please dig it.', 'sorted'], // skipped → q stays open → discussion → research advised → human agrees
      [[{ topic: q.question, findings: 'v1 accepts only the "a" marker.', sources: ['workshop'] }]],
      ['yes', 'GO'],
    );
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    // research ran exactly once, on the advised topic, mid-discussion
    expect(interact.researchCalls).toEqual([[q.question]]);
    expect(r.researchLog).toEqual([{ topic: q.question, findings: 'v1 accepts only the "a" marker.', sources: ['workshop'] }]);
    // the finding RESOLVED the skipped open question and became a grounded constraint
    expect(r.resolved).toEqual([{ id: 'q1', question: q.question, answer: 'v1 accepts only the "a" marker.', impact: 'high' }]);
    // the LLM responded AGAIN to the findings (grill + synthesis + advise-turn + follow-up + decision)
    expect(prompts).toHaveLength(5);
    expect(prompts[3]).toContain('v1 accepts only the "a" marker.'); // the follow-up reasoned over the folded finding
    expect(interact.presented.some((p) => p.includes('The workshop confirms the "a" marker'))).toBe(true);
  });

  it('declining the recommended research does NOT run it — the discussion just moves on', async () => {
    const q = HIGH_Q();
    const { llm } = fakeLlm([
      grill('A v1 goal.', [], [q]),
      'Read-back one.',
      discuss('I would research the marker, but it can wait.', { topic: q.question, reason: 'optional' }),
      decision('GO', 'the marker stays open but does not block a seedable v1'),
    ]);
    const interact = new ScriptedInteractor(['skip', 'No, skip the dig.', 'sorted'], [], ['no', 'GO']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 3 });

    expect(r.ok && r.verdict === 'solid').toBe(true);
    if (!r.ok || r.verdict !== 'solid') return;
    expect(interact.researchCalls).toEqual([]); // human declined → nothing ran
    expect(r.researchLog).toEqual([]);
    expect(r.resolved).toEqual([]); // the skipped question simply stays open — GO still allowed
  });

  it('(e) SKIP ends the grill — nothing created', async () => {
    const { llm } = fakeLlm([clean('A reading.')]);
    const interact = new ScriptedInteractor([], [], ['SKIP']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.' });

    expect(r).toMatchObject({ ok: true, verdict: 'reject', reason: 'skipped' });
    if (!r.ok || r.verdict !== 'reject') return;
    expect(r.note).toContain('nothing was created');
  });

  it('an InteractAbort (the human walked away) is a REJECT — never a blank answer', async () => {
    const { llm } = fakeLlm([grill('A reading.', [], [HIGH_Q()])]);
    const interact = new ScriptedInteractor([], [], []); // no answers → the batch ask aborts
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.' });

    expect(r).toMatchObject({ ok: true, verdict: 'reject', reason: 'aborted' });
    if (!r.ok || r.verdict !== 'reject') return;
    expect(r.note).toContain('aborted');
  });

  it('ANTI-RUNAWAY: a loop that keeps being dug on converged rounds hits the small ceiling — the stop is the safety net, never the normal end', async () => {
    const closeText = 'Resolved: nothing stood in the way of a v1. Still open: none the human flagged. The goal reads as a solid v1. To continue, re-run goal! seed sharper.';
    const { llm, prompts } = fakeLlm([clean('Reading one.'), clean('Reading two.'), closeText]);
    // 'dig more' is NOT offered on a converged round — typing it anyway is the defensive
    // advance (re-grill an empty frontier → still exhausted), which here pushes the loop
    // to the small explicit ceiling (maxRounds 2) so the backstop path fires.
    const interact = new ScriptedInteractor([], [], ['dig more', 'dig more']);
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.', maxRounds: 2 });

    expect(r).toMatchObject({ ok: true, verdict: 'exhausted', rounds: 2 });
    if (!r.ok || r.verdict !== 'exhausted') return;
    expect(r.note).toContain('anti-runaway'); // the note names the safety net, not a normal end
    expect(r.note).toContain('nothing was created');
    // the close-out is an LLM-written synthesis presented as the anti-runaway stop, with the continue path
    expect(prompts[2]).toContain('anti-runaway');
    expect(prompts[2]).toContain('close-out');
    expect(interact.presented.some((p) => p.includes('Goal grill — anti-runaway stop'))).toBe(true);
    expect(interact.presented.some((p) => p.includes(closeText))).toBe(true);
    expect(interact.presented.some((p) => p.includes('raise the round ceiling'))).toBe(true);
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

  it('a malformed discussion reply fails CLOSED — never fabricated into a reply', async () => {
    const q = HIGH_Q();
    const { llm } = fakeLlm([grill('A v1 goal.', [], [q]), 'Read-back one.', 'not json at all']);
    const interact = new ScriptedInteractor(['a', 'what else?'], [], ['GO']); // the discuss turn gets garbage
    const r = await session(llm, interact).run({ statement: 'Build a goal! seed command.' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blocker).toContain('unparseable');
  });
});
