import { GrillQuestion } from '../engines/shared.js';

/**
 * The interactor — the HUMAN channel (S8 talk seam, flow-finalization decision
 * 2026-08-23): the interactive idea-validation step talks to the user through
 * this protocol. v1 ships a scripted channel (tests) + a console channel (CLI);
 * S8 wires the real talk/UI adapter. A step that needs the human channel but
 * gets no interactor fails closed with a named blocker (never silent).
 *
 * Protocol shape follows flow-control v6 §3 human interface: present-draft ·
 * collect-decision · collect-feedback · present-question · collect-answer.
 */

export interface Interactor {
  /** Present a draft/read — the session shows its current understanding. */
  present(title: string, body: string): Promise<void>;
  /** collect-answer — one question, one answer (batched by the caller). */
  askQuestion(q: GrillQuestion): Promise<{ answer: string }>;
  /** Research together: the session proposes topics (from high-impact unknowns),
   *  the user/agent researches, findings return with provenance for the next round. */
  collectResearch(topics: string[]): Promise<Array<{ topic: string; findings: string; sources?: string[] }>>;
  /** collect-decision — the human concludes (verdict: solid | revise | reject). */
  collectDecision(d: { prompt: string; options: string[] }): Promise<{ choice: string }>;
}

/** The flow-control v6 §3 abort signal — the human walked away; verdict = reject. */
export class InteractorAbort extends Error {}

/** A scripted interactor for tests: a script of answers per call kind, FIFO. */
export class ScriptedInteractor implements Interactor {
  readonly presented: Array<{ title: string; body: string }> = [];
  constructor(
    private readonly answers: string[],
    private readonly findings: Array<{ topic: string; findings: string; sources?: string[] }> = [],
    private readonly decision: string = 'solid',
  ) {}
  async present(title: string, body: string) {
    this.presented.push({ title, body });
  }
  async askQuestion(_q: GrillQuestion): Promise<{ answer: string }> {
    const a = this.answers.shift();
    if (a === undefined) throw new InteractorAbort('scripted interactor ran out of answers — the session asked more questions than scripted');
    return { answer: a };
  }
  async collectResearch(_topics: string[]): Promise<Array<{ topic: string; findings: string; sources?: string[] }>> {
    return this.findings;
  }
  async collectDecision(_d: { prompt: string; options: string[] }): Promise<{ choice: string }> {
    return { choice: this.decision };
  }
}

/** The v1 console channel — the CLI's talk seam (S8 will replace it with the UI). */
export class ConsoleInteractor implements Interactor {
  constructor(private readonly read: (q: string) => Promise<string> = async () => '') {}
  async present(title: string, body: string) {
    console.log(`\n── ${title} ──\n${body}`);
  }
  async askQuestion(q: GrillQuestion): Promise<{ answer: string }> {
    return { answer: await this.read(`${q.question}${q.default ? ` (default: ${q.default})` : ''}`) };
  }
  async collectResearch(topics: string[]): Promise<Array<{ topic: string; findings: string }>> {
    const out: Array<{ topic: string; findings: string }> = [];
    for (const t of topics) {
      const findings = await this.read(`research topic: ${t} — findings (or leave blank to skip)`);
      if (findings.trim()) out.push({ topic: t, findings });
    }
    return out;
  }
  async collectDecision(d: { prompt: string; options: string[] }): Promise<{ choice: string }> {
    return { choice: await this.read(`${d.prompt} [${d.options.join(' | ')}]`) };
  }
}
