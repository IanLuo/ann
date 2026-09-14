import { describe, it, expect } from 'vitest';
import { GateTalk, HtmlInteract, escapeHtml } from '../talk.js';
import { InteractAbort, InteractAbility } from '../../flow/types.js';
import { TaskDetail } from '../../store/store.js';

/** A scripted interact channel — answers served by question identity, in order. */
class ScriptedInteract implements InteractAbility {
  private queue: Array<{ q: string; answer: string }> = [];
  presented: string[] = [];

  constructor(private readonly defaultAnswer = 'accept') {}

  answer(q: string, answer: string): this {
    this.queue.push({ q, answer });
    return this;
  }

  async present(text: string): Promise<void> {
    this.presented.push(text);
  }
  async ask(question: string): Promise<string> {
    return this.take(question);
  }
  async decide(question: string, options: string[]): Promise<string> {
    return this.take(question);
  }
  async research(topics: string[]): Promise<Array<{ topic: string; findings: string }>> {
    return topics.map((topic) => ({ topic, findings: `findings for ${topic}` }));
  }
  private take(q: string): string {
    const hit = this.queue.find((x) => x.q === q);
    return hit ? hit.answer : this.defaultAnswer;
  }
}

const detail: TaskDetail = {
  id: '06-engine-build/10-s7-github-binding',
  isLeg: false,
  status: 'queued',
  superseded: false,
  contract: { intent: 'the github binding', acceptanceCriteria: ['AC one'] },
  gates: { grill: { state: 'none' }, confirm: { state: 'none' } },
  rework: false,
  next: { verdict: 'queued' },
  artifacts: [],
  events: [],
  blockers: [],
};

describe('GateTalk — the gate talk-loop (F7)', () => {
  it('presents the step card, then collects an accept', async () => {
    const interact = new ScriptedInteract();
    const talk = new GateTalk(interact);
    await talk.presentCard(detail);
    const decision = await talk.decideGate('grill', detail.id);

    expect(interact.presented).toHaveLength(1);
    expect(interact.presented[0]).toContain('GATE CARD: 06-engine-build/10-s7-github-binding');
    expect(decision).toEqual({ decision: 'accept' });
  });

  it('collects feedback on a rejection — never invented', async () => {
    const interact = new ScriptedInteract('reject').answer('why is \'confirm\' rejected? (the feedback routes the rework)', 'the ACs are not met');
    const talk = new GateTalk(interact);
    const decision = await talk.decideGate('confirm', detail.id);

    expect(decision).toEqual({ decision: 'reject', feedback: 'the ACs are not met' });
  });

  it('a blank rejection feedback is surfaced as-is — the answer channel owns it, never inferred', async () => {
    const interact = new ScriptedInteract('reject').answer('why is \'grill\' rejected? (the feedback routes the rework)', '');
    const talk = new GateTalk(interact);
    const decision = await talk.decideGate('grill', detail.id);
    expect(decision.decision).toBe('reject');
    expect(decision.feedback).toBe(''); // the channel returned blank — surfaced, never invented
  });
});

describe('HtmlInteract — the same interface serving web HTML (swappable, target surface)', () => {
  it('present emits an HTML card', async () => {
    const emitted: string[] = [];
    const html = new HtmlInteract((h) => emitted.push(h));
    await html.present('intent: <the github binding>');
    expect(emitted[0]).toContain('<div class="ann-card">');
    expect(emitted[0]).toContain('&lt;the github binding&gt;'); // HTML-escaped
  });

  it('decide emits buttons and awaits the answer source', async () => {
    const emitted: string[] = [];
    const html = new HtmlInteract((h) => emitted.push(h), {
      ask: async (q, kind, options) => {
        expect(kind).toBe('decide');
        expect(options).toEqual(['accept', 'reject']);
        expect(q).toContain('<button data-opt="accept">accept</button>');
        return 'accept';
      },
    });
    const answer = await html.decide('decide gate', ['accept', 'reject']);
    expect(answer).toBe('accept');
    expect(emitted).toHaveLength(1);
  });

  it('throws InteractAbort when the answer source is absent — the human walked away (never infer)', async () => {
    const html = new HtmlInteract();
    await expect(html.ask('any question')).rejects.toBeInstanceOf(InteractAbort);
  });

  it('throws InteractAbort when the source returns no answer', async () => {
    const html = new HtmlInteract(() => {}, { ask: async () => undefined as unknown as string });
    await expect(html.ask('any question')).rejects.toBeInstanceOf(InteractAbort);
  });

  it('escapeHtml renders user text XSS-safe', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
