import { describe, it, expect } from 'vitest';
import { ConsoleInteract } from '../../../../abilities/index.js';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../../../types.js';
import { IdeaValidationSession } from '../session.js';

/** A scripted human — FIFO answers. Running out is the ABORT: the human walked away,
 *  which is a departure to record, not a blank answer to infer from. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly decidedQuestions: string[] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly findings: ResearchFinding[] = [],
    private readonly decision: string = 'solid',
    private readonly decisions: string[] = [],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(_question: string): Promise<string> {
    const a = this.answers.shift();
    if (a === undefined) throw new InteractAbort('scripted interactor ran out of answers — the session asked more questions than scripted');
    return a;
  }
  async research(_topics: string[]): Promise<ResearchFinding[]> {
    return this.findings;
  }
  async decide(question: string, _options: string[]): Promise<string> {
    this.decidedQuestions.push(question);
    const d = this.decisions.shift();
    return d !== undefined ? d : this.decision;
  }
}

/** A fake llm ability — sequential completions (the session grills per round). */
const fakeLlm = (responses: string[]): { llm: LlmAbility; calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      calls.push(req.prompt);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
  return { llm, calls };
};

/** The session takes the ability SET — llm + the human channel, injected together. */
const session = (llm: LlmAbility, interact: InteractAbility) => new IdeaValidationSession({ llm, interact });
const grillOk = (validation: unknown[], questions: unknown[] = []) =>
  JSON.stringify({ summary: 'Readable idea.', validation, questions });

const cleanGrill = () => grillOk([{ verdict: 'ok', claim: 'The idea fits', basis: ['c1'], confidence: 'high' }]);
const highQuestionGrill = () =>
  grillOk([], [{ question: 'What input format must v1 accept?', reason: 'defines scope', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' }]);
const blockingGrill = () => grillOk([{ verdict: 'blocking', claim: 'Unresolvable dependency', basis: [], confidence: 'high' }]);

const base = () => ({
  idea: 'Build a tool that turns messy notes into a journey-of-legs plan.',
  context: [{ label: 'c1', text: 'The user hates manual planning.', sourceType: 'user input' as const }],
  constraints: ['No new infra'],
});

describe('IdeaValidationSession (flow-1 validate — interactive idea validator)', () => {
  it('converges to solid in one round when the grill is clean; doc guides the following work', async () => {
    const { llm, calls } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], 'solid');
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1);
    expect(r.doc.verdict).toBe('solid');
    expect(r.doc.recommendation).toBe('solid');
    expect(r.doc.summary).toContain('Readable idea');
    expect(r.doc.guidance.some((g) => g.includes('No new infra'))).toBe(true); // constraints carried
    expect(r.doc.guidance.some((g) => g.includes('The idea fits'))).toBe(true); // grounded claims → spec grounds on
    expect(r.doc.markdown).toContain('# Idea Validation Doc');
    expect(calls.length).toBe(1); // one grill, one round
  });

  it('asks the batch questions and folds answers as user input; a skip becomes a research topic', async () => {
    const { llm } = fakeLlm([highQuestionGrill(), cleanGrill()]);
    const interact = new ScriptedInteractor(['markdown'], [{ topic: 'What input format must v1 accept?', findings: 'User confirmed markdown for v1.', sources: ['user interview'] }], 'solid');
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the answer resolved the high-impact question → research NOT needed for it
    expect(r.doc.resolvedQuestions).toEqual([
      { id: 'q1', question: 'What input format must v1 accept?', answer: 'markdown', impact: 'high' },
    ]);
    expect(r.doc.researchLog.length).toBe(0);
    expect(r.doc.remainingUnknowns.length).toBe(0);
    expect(r.rounds).toBe(1); // converged round 1 (answer resolved the only high-impact question)
  });

  it('an unresolved high-impact answer becomes a research topic; findings fold in and drive a second round', async () => {
    const { llm, calls } = fakeLlm([highQuestionGrill(), cleanGrill()]);
    const interact = new ScriptedInteractor(['unknown'], [], 'solid'); // skipped → research topic, no findings returned
    const r = await session(llm, interact).run({ ...base(), maxRounds: 3 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(2); // round 1 could not converge (high-impact open) → round 2 re-grilled clean
    expect(calls.length).toBe(2);
    expect(r.doc.resolvedQuestions.length).toBe(0); // the answer was a skip
    // the open high-impact question survived into the doc as a remaining unknown
    expect(r.doc.remainingUnknowns.some((q) => q.impact === 'high')).toBe(true);
  });

  it('research findings that resolve the topic let round 1 converge with a research log', async () => {
    const { llm } = fakeLlm([highQuestionGrill()]);
    const interact = new ScriptedInteractor(['unknown'], [{ topic: 'What input format must v1 accept?', findings: 'Confirmed markdown v1.', sources: ['workshop'] }], 'solid');
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1); // the finding resolved the topic → converged
    expect(r.doc.researchLog).toEqual([{ topic: 'What input format must v1 accept?', findings: 'Confirmed markdown v1.', sources: ['workshop'] }]);
    expect(r.doc.remainingUnknowns.length).toBe(0);
  });

  it('bounded: no convergence in maxRounds → recommends revise; the human decides; unknowns documented', async () => {
    const { llm } = fakeLlm([highQuestionGrill(), highQuestionGrill()]);
    const interact = new ScriptedInteractor(['unknown', 'unknown'], [], 'revise');
    const r = await session(llm, interact).run({ ...base(), maxRounds: 2 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(2);
    expect(r.doc.recommendation).toBe('revise');
    expect(r.doc.verdict).toBe('revise'); // the human concluded revise
    expect(r.doc.remainingUnknowns.some((q) => q.impact === 'high')).toBe(true);
    expect(r.doc.guidance.some((g) => g.includes('RESOLVE BEFORE SPEC'))).toBe(true);
  });

  it('blocking concerns drive a reject recommendation', async () => {
    const { llm } = fakeLlm([blockingGrill()]);
    const interact = new ScriptedInteractor([], [], 'reject');
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.recommendation).toBe('reject');
    expect(r.doc.verdict).toBe('reject');
    expect(r.doc.risks.some((v) => v.verdict === 'blocking')).toBe(true);
  });

  it('user abort → verdict reject, doc still produced (honest record)', async () => {
    const { llm } = fakeLlm([highQuestionGrill()]);
    const interact = new ScriptedInteractor([], [], 'reject'); // no answers → InteractorAbort on the first ask
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.verdict).toBe('reject');
    expect(r.doc.markdown).toContain('# Idea Validation Doc');
  });

  it('empty idea → fail-closed invalid-config', async () => {
    const r = await session(fakeLlm([]).llm, new ScriptedInteractor([], [], 'solid')).run({ idea: '   ' });
    expect(r.ok).toBe(false);
  });

  it('adapter failure passes through fail-closed (never fabricated)', async () => {
    // the llm ability THROWS on a provider failure; the engine shim turns it into a value
    const llm: LlmAbility = {
      async complete() {
        throw new Error('provider down');
      },
    };
    const r = await session(llm, new ScriptedInteractor([], [], 'solid')).run(base());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blocker).toContain('provider down');
  });

  it('question dedupe across rounds: the same question is never asked twice', async () => {
    const { llm } = fakeLlm([highQuestionGrill(), highQuestionGrill()]); // both rounds raise the same question
    const interact = new ScriptedInteractor(['markdown'], [], 'solid'); // one answer — round 1 resolves it
    const r = await session(llm, interact).run({ ...base(), maxRounds: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1); // resolved in round 1 — no re-ask
  });

  it('forceRefine (goal! seed): a question the human answers is re-grilled before the verdict — ≥2 grills, the second folds the answer', async () => {
    const { llm, calls } = fakeLlm([highQuestionGrill(), cleanGrill()]); // round 2 re-grills the ANSWERED context clean
    const interact = new ScriptedInteractor(['markdown'], [], 'solid');
    const r = await session(llm, interact).run({ ...base(), forceRefine: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(2); // the answer-bearing round could not conclude — it was re-grilled
    expect(calls.length).toBe(2);
    expect(r.doc.resolvedQuestions).toEqual([
      { id: 'q1', question: 'What input format must v1 accept?', answer: 'markdown', impact: 'high' },
    ]);
    // the re-grill was fed the answered context — round 2's prompt carries the answer
    expect(calls[1]).toContain('markdown');
    expect(r.doc.summary).toContain('Readable idea'); // the read reflects the REFINED round 2 grill
  });

  it('forceRefine does not defer a round that asked/answered nothing — a clean idea still converges in one grill', async () => {
    const { llm, calls } = fakeLlm([cleanGrill()]); // no questions → nothing answered → nothing to re-grill
    const interact = new ScriptedInteractor([], [], 'solid');
    const r = await session(llm, interact).run({ ...base(), forceRefine: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1);
    expect(calls.length).toBe(1); // forceRefine never forces a round the human contributed nothing to
  });
});

describe('provenance-label dedupe (the answer:qN collision fix — AC-2)', () => {
  // The grilling engine restarts question ids at q1 on EVERY engine call. Round 1's
  // answer therefore labels `answer:q1` and — WITHOUT dedupe — round 2's fresh q1
  // would label `answer:q1` AGAIN, shadowing round 1's in the grounding map: a later
  // round that cites `answer:q1` would bind to the WRONG (round-2) answer. These tests
  // prove the session counter-dedupes so every label is unique across rounds and a
  // later citation resolves to the round it names.
  it('a multi-round session labels each round answer uniquely and grounds a later citation on THAT round answer', async () => {
    // R1 asks "format?" (id q1) → answered 'markdown'; R2 asks "platform?" (id q1 AGAIN
    // — the engine restarted) → answered 'web'; R3 is the concluding clean read, whose
    // validated claim CITES round 2's answer by its rendered label.
    const r1 = grillOk([], [{ question: 'What input format must v1 accept?', reason: 'defines scope', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' }]);
    const r2 = grillOk([], [{ question: 'Which platform ships first?', reason: 'sequencing', impact: 'high', options: ['ios', 'web'], default: 'web' }]);
    const r3 = grillOk([{ verdict: 'ok', claim: 'web-first is the grounded call', basis: ['answer:q1-2'], confidence: 'high' }]);
    const { llm, calls } = fakeLlm([r1, r2, r3]);
    const interact = new ScriptedInteractor(['markdown', 'web'], [], 'solid');
    const r = await session(llm, interact).run({ ...base(), forceRefine: true, maxRounds: 3 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(3); // each answered round was re-grilled before the clean concluding read
    expect(calls.length).toBe(3);
    // the ROUND-3 grill prompt carries BOTH answers under DISTINCT labels — round 2's
    // answer did not shadow round 1's under a duplicate `answer:q1`
    expect(calls[2]).toContain('answer:q1 [user input]: markdown');
    expect(calls[2]).toContain('answer:q1-2 [user input]: web');
    // the round-3 model CITED the deduped round-2 label and the engine resolved it —
    // the claim survives WITH its basis (pre-fix the label did not exist: the citation
    // would have been dropped as unknown and the claim demoted to inference)
    expect(r.doc.validatedAssumptions).toContainEqual(
      expect.objectContaining({ claim: 'web-first is the grounded call', basis: ['answer:q1-2'], sourceType: 'user input', confidence: 'high' }),
    );
    expect(r.doc.validatedAssumptions.some((v) => v.claim === 'web-first is the grounded call' && v.basis.length === 0)).toBe(false);
  });

  it('a later round cannot silently re-cite round 1 as if it were round 2: the EARLIER label keeps round 1 answer', async () => {
    // Same two answered rounds; the concluding read cites BOTH labels — round 1's
    // answer under `answer:q1`, round 2's under `answer:q1-2`.
    const r1 = grillOk([], [{ question: 'What input format must v1 accept?', reason: 'defines scope', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' }]);
    const r2 = grillOk([], [{ question: 'Which platform ships first?', reason: 'sequencing', impact: 'high', options: ['ios', 'web'], default: 'web' }]);
    const r3 = grillOk([
      { verdict: 'ok', claim: 'the format markdown is settled', basis: ['answer:q1'], confidence: 'high' },
      { verdict: 'ok', claim: 'the platform web is settled', basis: ['answer:q1-2'], confidence: 'high' },
    ]);
    const { llm } = fakeLlm([r1, r2, r3]);
    const interact = new ScriptedInteractor(['markdown', 'web'], [], 'solid');
    const r = await session(llm, interact).run({ ...base(), forceRefine: true, maxRounds: 3 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the two citations resolve to their OWN round answers — never both to the last `answer:q1`
    expect(r.doc.validatedAssumptions).toContainEqual(expect.objectContaining({ claim: 'the format markdown is settled', basis: ['answer:q1'], sourceType: 'user input' }));
    expect(r.doc.validatedAssumptions).toContainEqual(expect.objectContaining({ claim: 'the platform web is settled', basis: ['answer:q1-2'], sourceType: 'user input' }));
    expect(r.doc.validatedAssumptions.filter((v) => v.basis.length === 0)).toEqual([]); // neither citation was dropped
  });
});

describe('the depth signal (shaping) — one extra bounded decide, only on a solid verdict', () => {
  it('a clean solid idea recommends LIGHT; the human routing decides needsVision and the doc records the depth', async () => {
    const { llm } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], 'solid', ['solid', 'light']);
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.verdict).toBe('solid');
    expect(r.doc.needsVision).toBe(false); // route light
    // exactly two decisions in the SAME final read: solidness, then the depth route
    expect(interact.decidedQuestions.length).toBe(2);
    expect(interact.decidedQuestions[1]).toContain('recommendation: light');
    expect(r.doc.markdown).toContain('**Depth: light — no vision, spec directly**');
    // the guidance never names a step the light route will skip
    expect(r.doc.guidance.some((g) => g.includes('Vision must cover'))).toBe(false);
  });

  it('an ambiguous solid idea recommends VISION and the doc names the full depth', async () => {
    // a high-impact question the human cannot resolve stays OPEN → the depth recommends vision
    const { llm } = fakeLlm([highQuestionGrill()]);
    const interact = new ScriptedInteractor(['unknown'], [], 'solid', ['solid', 'vision']);
    const r = await session(llm, interact).run({ ...base(), maxRounds: 3 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.verdict).toBe('solid');
    expect(r.doc.remainingUnknowns.some((q) => q.impact === 'high')).toBe(true);
    expect(r.doc.needsVision).toBe(true); // the open question needs the vision to resolve
    expect(interact.decidedQuestions[1]).toContain('recommendation: vision');
    expect(r.doc.markdown).toContain('**Depth: full — a product vision runs before the spec**');
    expect(r.doc.guidance.some((g) => g.includes('Vision must cover') || g.includes('RESOLVE BEFORE SPEC'))).toBe(true);
  });

  it('the depth decide is NOT asked on a revise/reject verdict — no route to gather', async () => {
    const { llm } = fakeLlm([cleanGrill()]);
    const interact = new ScriptedInteractor([], [], 'solid', ['revise']);
    const r = await session(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.verdict).toBe('revise');
    expect(r.doc.needsVision).toBe(false); // meaningless off the solid path
    expect(interact.decidedQuestions.length).toBe(1); // only the solidness decide
  });
});

describe('the interact ability — FOUR verbs', () => {
  it('the scripted channel serves FIFO and ABORTS when the answers run out', async () => {
    const s = new ScriptedInteractor(['a1']);
    await s.present('a read');
    expect(await s.ask('q?')).toBe('a1');
    await expect(s.ask('q2?')).rejects.toThrow(/ran out of answers/);
    expect(s.presented).toEqual(['a read']);
  });

  it('the console channel is a valid v1 talk channel across all four verbs', async () => {
    const c = new ConsoleInteract(async () => 'markdown');
    expect(await c.ask('format?')).toBe('markdown');
    expect(await c.decide('verdict?', ['solid', 'reject'])).toBe('markdown');
    expect(await c.research(['topic a'])).toEqual([{ topic: 'topic a', findings: 'markdown' }]);
  });
});
