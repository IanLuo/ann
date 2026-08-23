import { describe, it, expect, vi } from 'vitest';
import { LlmExecutor } from '../../../executor.js';
import { ScriptedInteractor, ConsoleInteractor } from '../../../interact.js';
import { IdeaValidationSession, IdeaValidationDoc } from '../session.js';

/** A fake llm executor — sequential completions (the session grills per round). */
const fakeLlm = (responses: string[]): { llm: LlmExecutor; calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  const llm: LlmExecutor = {
    async complete(prompt: string, opts?: { evidence?: boolean }) {
      calls.push(prompt);
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, result: text, usage: { inputTokens: 5, outputTokens: 3 }, provenance: { provider: 'test', model: 'm' } };
    },
  };
  return { llm, calls };
};
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
    const r = await new IdeaValidationSession(llm, interact).run(base());

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
    const r = await new IdeaValidationSession(llm, interact).run(base());

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
    const r = await new IdeaValidationSession(llm, interact, {}).run({ ...base(), maxRounds: 3 });

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
    const r = await new IdeaValidationSession(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1); // the finding resolved the topic → converged
    expect(r.doc.researchLog).toEqual([{ topic: 'What input format must v1 accept?', findings: 'Confirmed markdown v1.', sources: ['workshop'] }]);
    expect(r.doc.remainingUnknowns.length).toBe(0);
  });

  it('bounded: no convergence in maxRounds → recommends revise; the human decides; unknowns documented', async () => {
    const { llm } = fakeLlm([highQuestionGrill(), highQuestionGrill()]);
    const interact = new ScriptedInteractor(['unknown', 'unknown'], [], 'revise');
    const r = await new IdeaValidationSession(llm, interact).run({ ...base(), maxRounds: 2 });

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
    const r = await new IdeaValidationSession(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.recommendation).toBe('reject');
    expect(r.doc.verdict).toBe('reject');
    expect(r.doc.risks.some((v) => v.verdict === 'blocking')).toBe(true);
  });

  it('user abort → verdict reject, doc still produced (honest record)', async () => {
    const { llm } = fakeLlm([highQuestionGrill()]);
    const interact = new ScriptedInteractor([], [], 'reject'); // no answers → InteractorAbort on the first ask
    const r = await new IdeaValidationSession(llm, interact).run(base());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.verdict).toBe('reject');
    expect(r.doc.markdown).toContain('# Idea Validation Doc');
  });

  it('empty idea → fail-closed invalid-config', async () => {
    const r = await new IdeaValidationSession(fakeLlm([]).llm, new ScriptedInteractor([], [], 'solid')).run({ idea: '   ' });
    expect(r.ok).toBe(false);
  });

  it('adapter failure passes through fail-closed (never fabricated)', async () => {
    const llm: LlmExecutor = {
      async complete() {
        return { ok: false, error: { code: 'provider-unavailable', blocker: 'provider down' } };
      },
    };
    const r = await new IdeaValidationSession(llm, new ScriptedInteractor([], [], 'solid')).run(base());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.blocker).toContain('provider down');
  });

  it('question dedupe across rounds: the same question is never asked twice', async () => {
    const { llm } = fakeLlm([highQuestionGrill(), highQuestionGrill()]); // both rounds raise the same question
    const interact = new ScriptedInteractor(['markdown'], [], 'solid'); // one answer — round 1 resolves it
    const r = await new IdeaValidationSession(llm, interact).run({ ...base(), maxRounds: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rounds).toBe(1); // resolved in round 1 — no re-ask
  });
});

describe('Interactor channels', () => {
  it('ScriptedInteractor presents + collects in FIFO order and aborts when answers run out', async () => {
    const s = new ScriptedInteractor(['a1']);
    await s.present('t', 'b');
    expect(await s.askQuestion({ id: 'q1', question: 'q?', reason: 'r', impact: 'high' })).toEqual({ answer: 'a1' });
    await expect(s.askQuestion({ id: 'q2', question: 'q2?', reason: 'r', impact: 'medium' })).rejects.toThrow(/ran out of answers/);
    expect(s.presented).toEqual([{ title: 't', body: 'b' }]);
  });

  it('ConsoleInteractor is a valid v1 talk channel', async () => {
    const c = new ConsoleInteractor(async () => 'markdown');
    expect(await c.askQuestion({ id: 'q', question: 'format?', reason: 'r', impact: 'high', default: 'md' })).toEqual({ answer: 'markdown' });
    expect(await c.collectDecision({ prompt: 'verdict?', options: ['solid', 'reject'] })).toEqual({ choice: 'markdown' });
  });
});
