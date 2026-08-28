import { InteractAbility, ResearchFinding, InteractAbort } from '../flow/types.js';
import { TaskDetail, ResultItem } from '../store/store.js';
import { renderGateCard } from './renderers.js';

/**
 * S8 — THE GATE TALK-LOOP (functional-spec F7/§3: present → decide → feedback).
 *
 * Every gate interaction has ONE shape, used by all functions:
 *
 *   present  → Ann shows the step card (intent · ACs · artifacts · gates · results)
 *   decide   → user: accept | reject (+ feedback on reject)
 *   feedback → collected when the gate is rejected (routes the bounded rework)
 *
 * `GateTalk` drives that shape over ANY `InteractAbility` — the SWAP POINT. The v1
 * adapter is `ConsoleInteract` (CLI text, src/abilities/index.ts); `HtmlInteract`
 * below implements the SAME interface serving web HTML — the target surface. A gate
 * can never be skipped, an acceptance never fabricated, feedback never invented
 * (ann-system-design §1: "Skip a gate · fabricate an acceptance · invent feedback"
 * in the NEVER column): the decision comes from the interact channel, never inferred.
 */

export interface GateDecision {
  decision: 'accept' | 'reject';
  feedback?: string;
}

export class GateTalk {
  constructor(private readonly interact: InteractAbility) {}

  /** present → the step card, via the injected channel (the channel renders it: CLI
   *  text or web HTML — the interface is the swap point). */
  async presentCard(detail: TaskDetail, results?: ResultItem[]): Promise<void> {
    await this.interact.present(renderGateCard({ detail, results }));
  }

  /** decide → accept | reject; a rejection COLLECTS the feedback (never invented). */
  async decideGate(gate: 'grill' | 'confirm', taskId: string): Promise<GateDecision> {
    const answer = await this.interact.decide(`decide gate '${gate}' for ${taskId}`, ['accept', 'reject']);
    if (answer === 'accept') return { decision: 'accept' };
    const why = await this.interact.ask(`why is '${gate}' rejected? (the feedback routes the rework)`);
    return { decision: 'reject', feedback: why };
  }
}

/* ══ the same interface, serving WEB HTML — the target surface ═══════════════ */

export interface HtmlAnswerSource {
  /** The web surface's answer channel: the server pushes the question, the client
   *  posts the answer back. Absent/refusing → `InteractAbort` (the human walked away —
   *  the ONE signal interact raises rather than returns). */
  ask(questionHtml: string, kind: 'ask' | 'decide' | 'research', options?: string[]): Promise<string>;
}

/** HTML-escape user/provider text before it enters a web render (XSS-safe; NFR-SEC-1
 *  applies to text in renders). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The S8 web-HTML human channel — the SAME `InteractAbility` interface as the v1
 * `ConsoleInteract`, serving HTML instead of terminal text. Proves the presentation
 * is swappable (architecture-v3 rung 2: "human-interface adapter makes the
 * presentation swappable (CLI text → web HTML)").
 *
 *   present   → emits an HTML card to the `emit` seam
 *   ask/decide/research → emit the question as HTML, then await the answer from the
 *              injected `HtmlAnswerSource` — the web client's post-back. A source
 *              that refuses raises `InteractAbort` (the human walked away); a blank
 *              answer reads as one only if the source returns it.
 */
export class HtmlInteract implements InteractAbility {
  constructor(
    private readonly emit: (html: string) => void = () => {},
    private readonly source?: HtmlAnswerSource,
  ) {}

  async present(text: string): Promise<void> {
    this.emit(`<div class="ann-card"><pre>${escapeHtml(text)}</pre></div>`);
  }

  async ask(question: string): Promise<string> {
    return this.answer(question, 'ask');
  }

  async decide(question: string, options: string[]): Promise<string> {
    const html = `<div class="ann-question"><p>${escapeHtml(question)}</p><div class="ann-options">${options
      .map((o) => `<button data-opt="${escapeHtml(o)}">${escapeHtml(o)}</button>`)
      .join('')}</div></div>`;
    return this.answer(html, 'decide', options);
  }

  async research(topics: string[]): Promise<ResearchFinding[]> {
    const html = `<div class="ann-research"><p>${escapeHtml('research topics: ' + topics.join(' · '))}</p></div>`;
    const raw = await this.answer(html, 'research');
    if (!raw.trim()) return [];
    return topics
      .map((topic) => ({ topic, findings: raw }))
      .filter((f) => f.findings.trim());
  }

  private async answer(html: string, kind: 'ask' | 'decide' | 'research', options?: string[]): Promise<string> {
    this.emit(html);
    if (!this.source) throw new InteractAbort('HtmlInteract: no answer source — the web channel is unbound (the human walked away; never infer the answer)');
    const answer = await this.source.ask(html, kind, options);
    if (answer === undefined) throw new InteractAbort('HtmlInteract: the web channel returned no answer — the human walked away (never infer)');
    return answer;
  }
}
