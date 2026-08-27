import { describe, it, expect, vi } from 'vitest';
import { DefaultEnvisionEngine } from '../envision-engine.js';
import type { VisionRequest } from '../envision-engine.js';
import type { Completion, ProviderAdapter } from '../../../abilities/llm/index.js';

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

const req: VisionRequest = {
  idea: 'A tool that turns messy notes into a journey-of-legs plan.',
  context: [
    { label: 'c1', text: 'The user hates manual planning spreadsheets.', sourceType: 'user input' },
    { label: 'c2', text: 'Existing internal tool is retired next quarter.', sourceType: 'repo metadata' },
  ],
  constraints: ['No new infra', 'CLI first'],
};

describe('DefaultEnvisionEngine — F8 envision (usage + look, after the idea is confirmed)', () => {
  it('produces the vision artifact: usage + look with provenance labels, batch questions', async () => {
    const { adapter, calls } = fakeAdapter([
      ok(JSON.stringify({
        summary: 'A CLI that turns messy notes into a plan.',
        usage: [
          { claim: 'People who keep notes in plain files', kind: 'who', basis: ['c1'], confidence: 'high' },
          { claim: 'Notes in → plan steps out', kind: 'flow', basis: [], confidence: 'medium' },
        ],
        look: [
          { claim: 'A tree view of legs and tasks', kind: 'surface', basis: [], confidence: 'high' },
        ],
        questions: [
          { question: 'Which note formats must v1 accept?', reason: 'defines scope', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' },
        ],
      })),
    ]);
    const engine = new DefaultEnvisionEngine(adapter);

    const r = await engine.envision(req);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.summary).toContain('CLI');
    // provenance: grounded claim cites its source type; ungrounded claim is labeled inference
    expect(r.artifact.usage).toContainEqual(expect.objectContaining({ claim: expect.stringContaining('plain files'), basis: ['c1'], sourceType: 'user input', confidence: 'high' }));
    expect(r.artifact.usage).toContainEqual(expect.objectContaining({ claim: expect.stringContaining('Notes in → plan steps out'), basis: [], sourceType: 'inference' }));
    expect(r.artifact.look).toEqual([expect.objectContaining({ kind: 'surface', claim: expect.stringContaining('tree view') })]);
    // batch-ask: one batch of questions with ids + defaults
    expect(r.artifact.questions).toEqual([
      expect.objectContaining({ id: 'q1', question: 'Which note formats must v1 accept?', impact: 'high', options: ['markdown', 'txt'], default: 'markdown' }),
    ]);
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    // the prompt carried the idea, context, constraints
    expect(calls[0].prompt).toContain('confirmed idea');
    expect(calls[0].prompt).toContain('c1 [user input]');
    expect(calls[0].prompt).toContain('No new infra');
  });

  it('demotes ungrounded low-confidence projections to questions (refuses fake precision)', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        usage: [
          { claim: 'Probably 10k users would pay $50/mo', kind: 'who', basis: [], confidence: 'low' },
          { claim: 'Notes in → plan out', kind: 'flow', basis: [], confidence: 'high' },
        ],
        look: [],
        questions: [],
      })),
    ]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.usage).toHaveLength(1); // only the non-fake-precision claim survives as usage
    expect(r.artifact.usage[0].claim).toContain('Notes in');
    expect(r.artifact.questions).toContainEqual(expect.objectContaining({ question: 'Probably 10k users would pay $50/mo' }));
  });

  it('drops unknown basis labels — never trusts unverifiable citations', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        usage: [{ claim: 'Per c99 the user wants X', kind: 'who', basis: ['c99'], confidence: 'high' }],
        look: [],
        questions: [],
      })),
    ]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.usage[0].basis).toEqual([]); // c99 dropped
    expect(r.artifact.usage[0].sourceType).toBe('inference');
  });

  it('separates usage (who/scenario/flow) from look (surface/element)', async () => {
    const { adapter } = fakeAdapter([
      ok(JSON.stringify({
        summary: 's',
        usage: [{ claim: 'a scenario', kind: 'scenario', basis: [], confidence: 'high' }],
        look: [{ claim: 'an element', kind: 'element', basis: [], confidence: 'high' }],
        questions: [],
      })),
    ]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.usage.map((c) => c.kind)).toEqual(['scenario']);
    expect(r.artifact.look.map((c) => c.kind)).toEqual(['element']);
  });

  it('fails closed on unparseable model output — never fabricated', async () => {
    const { adapter } = fakeAdapter([ok('this is not json')]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision(req);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response', blocker: expect.stringContaining('unparseable') }) });
  });

  it('fails closed on shape violations and on an empty vision (nothing to build from)', async () => {
    const engine = new DefaultEnvisionEngine(fakeAdapter([ok(JSON.stringify({ summary: 's' }))]).adapter);
    expect(await engine.envision(req)).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response' }) });

    const engine2 = new DefaultEnvisionEngine(fakeAdapter([ok(JSON.stringify({ summary: 's', usage: [], look: [], questions: [] }))]).adapter);
    const r2 = await engine2.envision(req);
    expect(r2).toEqual({ ok: false, error: expect.objectContaining({ blocker: expect.stringContaining('empty vision') }) });
  });

  it('rejects an empty idea — the vision step runs only after a confirmed idea (F8)', async () => {
    const { adapter, calls } = fakeAdapter([ok('unused')]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision({ idea: '  ' });
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-config' }) });
    expect(calls).toHaveLength(0); // no provider call for a rejected intake
  });

  it('passes adapter failures through fail-closed — never fabricates a vision', async () => {
    const { adapter } = fakeAdapter([fail("provider 'test' failed after 2 retries: HTTP 503")]);
    const engine = new DefaultEnvisionEngine(adapter);
    const r = await engine.envision(req);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'provider-unavailable', blocker: expect.stringContaining('HTTP 503') }) });
  });

  it('passes per-call model selection through to the adapter', async () => {
    const { adapter, calls } = fakeAdapter([
      ok(JSON.stringify({ summary: 's', usage: [], look: [], questions: [{ question: 'q?', reason: 'r', impact: 'high' }] })),
    ]);
    const engine = new DefaultEnvisionEngine(adapter, { model: 'vision-model', maxTokens: 512 });
    await engine.envision(req);
    expect(calls[0].opts).toEqual({ model: 'vision-model', maxTokens: 512 });
  });
});
