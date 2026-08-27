import { describe, it, expect, vi } from 'vitest';
import { DefaultGrillingEngine } from '../grilling.js';
import type { GrillingArtifact, GrillingRequest } from '../grilling.js';
import type { Completion, ProviderAdapter } from '../../../../adapters/provider/index.js';

/** Fake adapter — engines never touch a real provider in tests (AC-4: interface only). */
const fakeAdapter = (responses: Completion[]): { adapter: ProviderAdapter; calls: Array<{ prompt: string; opts?: object }> } => {
  const calls: Array<{ prompt: string; opts?: object }> = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    complete: vi.fn(async (prompt: string, opts?: { model?: string; maxTokens?: number }) => {
      calls.push({ prompt, opts });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    }),
  };
  return { adapter, calls };
};

const ok = (text: string, inputTokens = 5, outputTokens = 3): Completion => ({
  ok: true,
  text,
  usage: { inputTokens, outputTokens },
});
const fail = (blocker: string): Completion => ({ ok: false, error: { code: 'provider-unavailable', blocker } });

const req: GrillingRequest = {
  idea: 'Build a tool that turns messy notes into a journey-of-legs plan.',
  context: [
    { label: 'c1', text: 'The user hates manual planning spreadsheets.', sourceType: 'user input' },
    { label: 'c2', text: 'Existing internal tool is retired next quarter.', sourceType: 'repo metadata' },
  ],
  constraints: ['No new infra', 'CLI first'],
};

describe('DefaultGrillingEngine — F4 validate/grilling (idea exit gate)', () => {
  it('produces the validation + questions artifact, provenance-labeled', async () => {
    const { adapter, calls } = fakeAdapter([
      ok(JSON.stringify({
        summary: 'Buildable with care; missing a clear input format.',
        validation: [
          { verdict: 'concern', claim: 'Input format is undefined', basis: [], confidence: 'medium' },
          { verdict: 'ok', claim: 'Fits the user dislike of manual planning', basis: ['c1'], confidence: 'high' },
        ],
        questions: [
          { question: 'What input formats must v1 accept?', reason: 'defines scope', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' },
        ],
      })),
    ]);
    const engine = new DefaultGrillingEngine(adapter);

    const r = await engine.grill(req);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.summary).toContain('Buildable');
    // provenance: grounded point cites its source type; ungrounded point is labeled inference
    expect(r.artifact.validation).toContainEqual(expect.objectContaining({ claim: expect.stringContaining('dislike'), basis: ['c1'], sourceType: 'user input', confidence: 'high' }));
    expect(r.artifact.validation).toContainEqual(expect.objectContaining({ claim: expect.stringContaining('Input format'), basis: [], sourceType: 'inference', confidence: 'medium' }));
    // batch-ask: one batch of questions with ids + defaults
    expect(r.artifact.questions).toEqual([
      expect.objectContaining({ id: 'q1', question: 'What input formats must v1 accept?', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' }),
    ]);
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    // the prompt carried the idea, context, constraints
    expect(calls[0].prompt).toContain('idea');
    expect(calls[0].prompt).toContain('c1 [user input]');
    expect(calls[0].prompt).toContain('No new infra');
  });

  it('demotes ungrounded low-confidence assertions to questions (refuses fake precision)', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        validation: [
          { verdict: 'concern', claim: 'The user count is probably 10k', basis: [], confidence: 'low' },
          { verdict: 'blocking', claim: 'No data to estimate effort', basis: [], confidence: 'high' },
        ],
        questions: [],
      })),
    ]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.validation).toHaveLength(1); // only the grounded/high-confidence point survives as a validation
    expect(r.artifact.validation[0].claim).toContain('No data to estimate effort');
    expect(r.artifact.questions).toContainEqual(expect.objectContaining({ question: 'The user count is probably 10k' }));
  });

  it('drops unknown basis labels — never trusts unverifiable citations', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        validation: [{ verdict: 'ok', claim: 'Everything is fine per c99', basis: ['c99'], confidence: 'high' }],
        questions: [],
      })),
    ]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.validation[0].basis).toEqual([]); // c99 was dropped
    expect(r.artifact.validation[0].sourceType).toBe('inference');
  });

  it('dedupes repeated questions within the batch', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        validation: [],
        questions: [
          { question: 'What input formats?', reason: 'a', impact: 'high' },
          { question: 'What input formats?', reason: 'b', impact: 'low' },
          { question: 'What output format?', reason: 'c', impact: 'medium' },
        ],
      })),
    ]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.questions.map((q) => q.question)).toEqual(['What input formats?', 'What output format?']);
  });

  it('fails closed on unparseable model output — never fabricated', async () => {
    const { adapter } = fakeAdapter([ok('this is not json at all')]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill(req);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response', blocker: expect.stringContaining('unparseable') }) });
  });

  it('fails closed on shape violations and on an empty grill (nothing to gate on)', async () => {
    const engine = new DefaultGrillingEngine(fakeAdapter([ok(JSON.stringify({ summary: 's' }))]).adapter);
    expect(await engine.grill(req)).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response' }) });

    const engine2 = new DefaultGrillingEngine(fakeAdapter([ok(JSON.stringify({ summary: 's', validation: [], questions: [] }))]).adapter);
    const r2 = await engine2.grill(req);
    expect(r2).toEqual({ ok: false, error: expect.objectContaining({ blocker: expect.stringContaining('empty grill') }) });
  });

  it('rejects an empty idea at intake (requirements-spec: empty/greeting rejected)', async () => {
    const { adapter, calls } = fakeAdapter([ok('unused')]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill({ idea: '   ' });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-config' }) });
    expect(calls).toHaveLength(0); // no provider call for a rejected intake
  });

  it('passes adapter failures through fail-closed — never fabricates a grill', async () => {
    const { adapter } = fakeAdapter([fail("provider 'test' failed after 2 retries: HTTP 503")]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.grill(req);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'provider-unavailable', blocker: expect.stringContaining('HTTP 503') }) });
  });

  it('requirementsGrilling drafts a PRD grounded in the grill artifact', async () => {
    const { adapter, calls } = fakeAdapter([ok('## Summary\n...\n## Requirements\n- CLI first [ground: validated in gate]')]);
    const engine = new DefaultGrillingEngine(adapter);
    const answered: GrillingArtifact = {
      summary: 's',
      validation: [
        { verdict: 'ok', claim: 'Fits the user dislike', basis: ['c1'], sourceType: 'user input', confidence: 'high' },
      ],
      questions: [{ id: 'q1', question: 'Formats?', reason: 'r', impact: 'high', default: 'markdown' }],
    };
    const r = await engine.requirementsGrilling(req, answered);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.prd).toContain('## Summary');
    expect(calls[0].prompt).toContain('Fits the user dislike (ground: c1)');
    expect(calls[0].prompt).toContain('Formats? → markdown');
  });

  it('requirementsGrilling fails closed on an empty PRD', async () => {
    const { adapter } = fakeAdapter([ok('   ')]);
    const engine = new DefaultGrillingEngine(adapter);
    const r = await engine.requirementsGrilling(req, { summary: 's', validation: [], questions: [] });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ blocker: expect.stringContaining('empty PRD') }) });
  });
});
