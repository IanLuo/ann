import { DefaultGrillingEngine, GrillingRequest, ValidationPoint } from './grilling.js';
import { AdapterError, CompletionUsage } from '../../../abilities/llm/index.js';
import { GroundingInput, GrillQuestion } from '../shared.js';
import { Abilities, InteractAbort } from '../../types.js';
import { adapterFromAbility } from '../engine-adapter.js';

/**
 * The interactive idea-validation session (flow-1 `validate` step — finalized
 * 2026-08-23). NOT a context validator (S4, deterministic store checks) and NOT
 * a one-shot grill: this is an interactive, multi-round grilling session that
 * researches WITH the user and ends in a human verdict.
 *
 * Session loop (bounded — the flow-control 3-reject pattern):
 *   1. grill the idea (one-shot engine as the per-round synthesizer, wrapped —
 *      its honesty layer applies every round: provenance, demote-to-question);
 *   2. present the read; batch-ask the open questions (answers fold back as
 *      `user input` grounding, deduped across rounds);
 *   3. research together — high-impact unknowns become research topics, findings
 *      fold back with provenance (runner/user research, S8 channel);
 *   4. re-grill with the enriched context → converge or next round.
 * The session RECOMMENDS; the human concludes (solid | revise | reject).
 *
 * Output — the IDEA VALIDATION DOC, the artifact that guides the following work:
 * verdict · validated assumptions · resolved questions · risks · research log ·
 * remaining unknowns · guidance for envision/spec.
 */

export type IdeaVerdict = 'solid' | 'revise' | 'reject';

export interface ResearchFinding {
  topic: string;
  findings: string;
  sources?: string[];
}

export interface ResolvedQuestion {
  id: string;
  question: string;
  answer: string;
  impact: 'high' | 'medium' | 'low';
}

export interface IdeaValidationDoc {
  verdict: IdeaVerdict;
  /** What the session recommended vs what the human decided. */
  recommendation: IdeaVerdict;
  idea: string;
  summary: string;
  /** Provenance-labeled (each carries basis/sourceType — the grilling honesty layer). */
  validatedAssumptions: ValidationPoint[];
  resolvedQuestions: ResolvedQuestion[];
  risks: ValidationPoint[];
  researchLog: ResearchFinding[];
  /** Asked and still open — high-impact ones must be resolved before the spec step. */
  remainingUnknowns: GrillQuestion[];
  /** What the following work (envision/spec) must cover; non-negotiables. */
  guidance: string[];
  /** The renderable artifact (locked as the doc file). */
  markdown: string;
}

export interface SessionOptions {
  idea: string;
  context?: GroundingInput[];
  constraints?: string[];
  /** Bounded rounds (flow-control §3: bounded loops — never unbounded). */
  maxRounds?: number;
}

export type SessionResult =
  | { ok: true; doc: IdeaValidationDoc; rounds: number; usage: CompletionUsage }
  | { ok: false; error: AdapterError };

const DEFAULT_MAX_ROUNDS = 3;
const UNRESOLVED_MARKERS = ['unknown', 'skip', 'not sure', 'unsure', 'n/a', 'na', 'dont know', "don't know", ''];

const isUnresolved = (a: string): boolean => UNRESOLVED_MARKERS.includes(a.trim().toLowerCase());

export class IdeaValidationSession {
  constructor(
    private readonly abilities: Abilities,
    private readonly options: { model?: string; maxTokens?: number } = {},
  ) {}

  async run(opts: SessionOptions): Promise<SessionResult> {
    if (!opts.idea.trim()) {
      return { ok: false, error: { code: 'invalid-config', blocker: 'idea validation: idea must not be empty' } };
    }
    const engine = new DefaultGrillingEngine(adapterFromAbility(this.abilities.llm, this.options.model), { model: this.options.model, ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}) });
    const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const seen = new Set<string>(); // question dedupe across rounds (never ask twice)
    const pending: GrillQuestion[] = []; // asked and NOT resolved — accumulates across rounds
    const context: GroundingInput[] = [...(opts.context ?? [])];
    const resolved: ResolvedQuestion[] = [];
    const researchLog: ResearchFinding[] = [];
    let usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
    let lastArtifact: import('./grilling.js').GrillingArtifact | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      // 1 — grill the CURRENT understanding (one-shot engine, honesty layer applies)
      const req: GrillingRequest = { idea: opts.idea.trim(), context, constraints: opts.constraints };
      const g = await engine.grill(req);
      if (!g.ok) return g;
      usage = { inputTokens: usage.inputTokens + g.usage.inputTokens, outputTokens: usage.outputTokens + g.usage.outputTokens };
      lastArtifact = g.artifact;

      // 2 — present the read
      const read = this.renderRead(g.artifact, round);
      await this.abilities.interact.present(`── Idea validation — round ${round} ──
${read}`);

      // 2b — batch-ask the open questions (deduped); answers fold as user input
      for (const q of g.artifact.questions) {
        const key = q.question.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(q); // asked this round — stays pending until resolved
        let answer: string;
        try {
          answer = await this.abilities.interact.ask(q.default ? `${q.question} (default: ${q.default})` : q.question);
        } catch (e) {
          if (e instanceof InteractAbort) return this.finish('reject', opts, context, resolved, researchLog, lastArtifact, pending, usage, round);
          return { ok: false, error: { code: 'provider-unavailable', blocker: `idea validation: interactor failed — ${(e as Error).message}` } };
        }
        if (isUnresolved(answer)) continue; // still open → research topic below
        resolved.push({ id: q.id, question: q.question, answer, impact: q.impact });
        context.push({ label: `answer:${q.id}`, text: answer, sourceType: 'user input' });
      }

      // 3 — research together: high-impact unknowns → topics; findings fold back
      const openHigh = g.artifact.questions.filter((q) => q.impact === 'high' && !resolved.some((r) => r.question === q.question));
      let findings: Array<{ topic: string; findings: string; sources?: string[] }> = [];
      if (openHigh.length) {
        const topics = openHigh.map((q) => q.question);
        try {
          findings = await this.abilities.interact.research(topics);
        } catch (e) {
          if (e instanceof InteractAbort) return this.finish('reject', opts, context, resolved, researchLog, lastArtifact, pending, usage, round);
          return { ok: false, error: { code: 'provider-unavailable', blocker: `idea validation: research channel failed — ${(e as Error).message}` } };
        }
        for (const f of findings) {
          researchLog.push(f);
          context.push({ label: `research:${f.topic.slice(0, 40)}`, text: f.findings, sourceType: 'web source' });
          // a finding on an open question RESOLVES it (provenance: the research) —
          // it must not survive as a remaining unknown.
          const q = g.artifact.questions.find((x) => x.question === f.topic);
          if (q && !resolved.some((r) => r.question === q.question)) {
            resolved.push({ id: q.id, question: q.question, answer: f.findings, impact: q.impact });
          }
        }
      }

      // 4 — convergence: no blocking concerns AND no high-impact open questions
      const blocking = g.artifact.validation.filter((v) => v.verdict === 'blocking');
      const openHighAfter = openHigh.filter((q) => !findings.some((f) => f.topic === q.question));
      if (blocking.length === 0 && openHighAfter.length === 0) {
        return this.finish('solid', opts, context, resolved, researchLog, lastArtifact, pending, usage, round);
      }
    }

    // Bounded — no convergence in maxRounds: recommend revise (or reject on blocking)
    const rec: IdeaVerdict = lastArtifact?.validation.some((v) => v.verdict === 'blocking') ? 'reject' : 'revise';
    return this.finish(rec, opts, context, resolved, researchLog, lastArtifact, pending, usage, maxRounds);
  }

  /** The final read + the human verdict; renders the doc. Never throws on abort. */
  private async finish(
    recommendation: IdeaVerdict,
    opts: SessionOptions,
    context: GroundingInput[],
    resolved: ResolvedQuestion[],
    researchLog: ResearchFinding[],
    artifact: import('./grilling.js').GrillingArtifact | undefined,
    pending: GrillQuestion[],
    usage: CompletionUsage,
    rounds: number,
  ): Promise<SessionResult> {
    const remaining: GrillQuestion[] = pending.filter((q) => !resolved.some((r) => r.question === q.question));
    let verdict: IdeaVerdict = recommendation;
    try {
      await this.abilities.interact.present(`── Idea validation — final read ──
${this.renderRead(artifact, rounds, true)}`);
      const choice = await this.abilities.interact.decide(`Is the idea solid enough to proceed? (recommendation: ${recommendation})`, ['solid', 'revise', 'reject']);
      if (['solid', 'revise', 'reject'].includes(choice)) verdict = choice as IdeaVerdict;
    } catch (e) {
      if (e instanceof InteractAbort) verdict = 'reject'; // honest record — the human walked away
    }
    const doc = this.renderDoc({ verdict, recommendation, idea: opts.idea.trim(), summary: artifact?.summary ?? '', validatedAssumptions: (artifact?.validation ?? []).filter((v) => v.verdict === 'ok'), resolvedQuestions: resolved, risks: (artifact?.validation ?? []).filter((v) => v.verdict !== 'ok'), researchLog, remainingUnknowns: remaining, guidance: this.guidance(artifact, resolved, remaining, opts.constraints) });
    return { ok: true, doc, rounds, usage };
  }

  /** Deterministic guidance for the following work — provenance-clear, never invented. */
  private guidance(
    artifact: import('./grilling.js').GrillingArtifact | undefined,
    resolved: ResolvedQuestion[],
    remaining: GrillQuestion[],
    constraints?: string[],
  ): string[] {
    const g: string[] = [];
    if (artifact?.summary) g.push(`The idea as validated: ${artifact.summary}`);
    if (constraints?.length) g.push(`Non-negotiables (from the contract): ${constraints.join('; ')}`);
    const blocking = (artifact?.validation ?? []).filter((v) => v.verdict === 'blocking');
    if (blocking.length) g.push(`Blocking concerns to resolve before building: ${blocking.map((b) => b.claim).join('; ')}`);
    const med = remaining.filter((q) => q.impact !== 'high');
    if (med.length) g.push(`Envision must cover: ${med.map((q) => q.question).join('; ')}`);
    if (remaining.some((q) => q.impact === 'high')) g.push(`RESOLVE BEFORE SPEC (high-impact unknowns): ${remaining.filter((q) => q.impact === 'high').map((q) => q.question).join('; ')}`);
    const grounded = (artifact?.validation ?? []).filter((v) => v.basis.length > 0);
    if (grounded.length) g.push(`Spec must ground on: ${grounded.map((v) => v.claim).join('; ')}`);
    if (resolved.length) g.push(`User-answered during validation: ${resolved.map((r) => `${r.question} → ${r.answer}`).join('; ')}`);
    return g;
  }

  private renderRead(artifact: import('./grilling.js').GrillingArtifact | undefined, round: number, final = false): string {
    if (!artifact) return '(no read yet)';
    const lines = [artifact.summary, ''];
    for (const v of artifact.validation) {
      lines.push(`- [${v.verdict}] ${v.claim} (ground: ${v.basis.join(', ') || 'inference'}, ${v.sourceType}, ${v.confidence})`);
    }
    if (artifact.questions.length) {
      lines.push('', 'Open questions:');
      for (const q of artifact.questions) lines.push(`- [${q.impact}] ${q.question}${q.default ? ` (default: ${q.default})` : ''}`);
    }
    lines.push('', final ? '(this is the FINAL read — decide below)' : `(round ${round} of the bounded session — next round re-grills with your answers + research)`);
    return lines.join('\n');
  }

  private renderDoc(d: Omit<IdeaValidationDoc, 'markdown'>): IdeaValidationDoc {
    const md = [
      `# Idea Validation Doc`,
      ``,
      `**Verdict: ${d.verdict}** (session recommendation: ${d.recommendation})`,
      ``,
      `## The idea`,
      d.idea,
      ``,
      `## Summary`,
      d.summary,
      ``,
      `## Validated assumptions (provenance)`,
      ...(d.validatedAssumptions.length ? d.validatedAssumptions.map((v) => `- [${v.confidence}] ${v.claim} (ground: ${v.basis.join(', ') || 'inference'})`) : ['(none)']),
      ``,
      `## Risks & concerns`,
      ...(d.risks.length ? d.risks.map((v) => `- [${v.verdict}] ${v.claim} (ground: ${v.basis.join(', ') || 'inference'})`) : ['(none)']),
      ``,
      `## Resolved questions (user-answered)`,
      ...(d.resolvedQuestions.length ? d.resolvedQuestions.map((r) => `- [${r.impact}] ${r.question} → ${r.answer}`) : ['(none)']),
      ``,
      `## Research log`,
      ...(d.researchLog.length ? d.researchLog.map((f) => `- **${f.topic}**: ${f.findings}${f.sources?.length ? ` (sources: ${f.sources.join(', ')})` : ''}`) : ['(none — questions answered by the user)']),
      ``,
      `## Remaining unknowns`,
      ...(d.remainingUnknowns.length ? d.remainingUnknowns.map((q) => `- [${q.impact}] ${q.question}`) : ['(none)']),
      ``,
      `## Guidance for the following work`,
      ...d.guidance.map((g) => `- ${g}`),
      ``,
    ].join('\n');
    return { ...d, markdown: md };
  }
}
