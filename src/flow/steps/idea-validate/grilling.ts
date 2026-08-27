import { ProviderAdapter, CompletionSuccess, CompletionUsage, AdapterError } from '../../../adapters/provider/index.js';

/**
 * The grilling engine (S2) — F4: the idea's exit gate.
 *
 * Runs the validate/grilling step (requirements-spec v3 step 2): is the idea
 * buildable? worth building? what's missing? Output = validation + open
 * questions (flow-control v4 §7: batch-ask at end · artifact = validation +
 * questions · specs spawn after). Also requirements-grilling (template + LLM)
 * → a PRD draft once the idea is confirmed. NOT the spec step (that is the
 * Planner kernel / S5).
 *
 * Honesty invariants (design §4/§6, task AC-3/AC-6):
 *  - every validation point carries provenance: cited `basis` labels must exist
 *    in the provided context (unknown labels are dropped, never trusted);
 *    ungrounded points are LABELED 'inference', never masquerade as sourced
 *    (sourceType taxonomy, design §6);
 *  - refuses fake precision on novel work: an ungrounded + low-confidence
 *    assertion is a question in disguise — demoted to QUESTIONS, never asserted;
 *  - model output is parsed and shape-validated deterministically; anything
 *    unparseable or malformed → {ok:false} failure, never fabricated; an empty
 *    grill (no validation, no questions) cannot inform a gate → failure;
 *  - provider calls go ONLY through the frozen ProviderAdapter interface
 *    (task AC-4) — no direct provider access; adapter failures pass through
 *    fail-closed (design §5).
 */

export { SourceType, GroundingInput, GrillQuestion } from '../shared.js';
import { GroundingInput, GrillQuestion, SourceType, isRawQuestion, buildQuestion, renderContext, renderConstraints, unquote } from '../shared.js';

export interface GrillingRequest {
  /** The idea to grill — the step's intent/goal text (never empty). */
  idea: string;
  /** Grounding context with provenance (packet-style, design §6). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
}

export interface ValidationPoint {
  verdict: 'ok' | 'concern' | 'blocking';
  /** The claim — a judgment about the idea, never a fabricated fact. */
  claim: string;
  /** Grounding: cited context labels (validated against the request's context). */
  basis: string[];
  /** Provenance (design §6): 'inference' iff the point has no grounding basis;
   *  otherwise the sourceType of its primary cited input. */
  sourceType: SourceType;
  confidence: 'high' | 'medium' | 'low';
}

export interface GrillingArtifact {
  summary: string;
  validation: ValidationPoint[];
  /** The batch-ask set — asked together at the end (flow-control v4 §7). */
  questions: GrillQuestion[];
}

export type GrillingResult =
  | { ok: true; artifact: GrillingArtifact; usage: CompletionUsage }
  | { ok: false; error: AdapterError };

export type PrdResult =
  | { ok: true; prd: string; usage: CompletionUsage }
  | { ok: false; error: AdapterError };

export interface GrillingEngine {
  grill(req: GrillingRequest): Promise<GrillingResult>;
  /** requirements-grilling (template + LLM) → PRD draft, grounded in the confirmed idea. */
  requirementsGrilling(req: GrillingRequest, answered: GrillingArtifact): Promise<PrdResult>;
}

/* ------------------------------------------------------------------ */
/* The requirements-grilling templates (data, not code — the LLM prompts) */
/* ------------------------------------------------------------------ */

const GRILL_PROMPT = `You are the validate/grilling engine of a journey system (F4 — the idea's exit gate).
Your job: decide whether this idea is buildable, worth building, and what is missing — NEVER to invent facts.

## The idea
{idea}

## Grounded context (cite ONLY these labels as basis; never invent a label)
{context}

## Contract constraints
{constraints}

## Output — strict JSON, no commentary, no markdown fence
{
  "summary": "one-paragraph read on the idea",
  "validation": [
    {
      "verdict": "ok | concern | blocking",
      "claim": "a judgment about the idea",
      "basis": ["label1"],
      "confidence": "high | medium | low"
    }
  ],
  "questions": [
    {
      "question": "...",
      "reason": "why the human's answer matters",
      "impact": "high | medium | low",
      "options": ["optional", "choices"],
      "default": "optional"
    }
  ]
}

## Rules (hard)
1. VERDICTS: blocking = the idea cannot proceed as stated; concern = needs attention; ok = fine as stated.
2. Every claim must cite its basis from the provided context labels. If a claim is NOT grounded in context, set basis to [].
3. NEVER assert what you do not know: an unknown that matters goes into questions, not validation.
4. High-impact unknowns are ALWAYS questions, never guesses.
5. Questions are asked in a batch at the end — make each question self-contained, with a reason.
6. Do not invent labels, numbers, prices, users, or requirements not present in the context.`;

const PRD_PROMPT = `You are the requirements-grilling step of a journey system. The idea passed its gate.
Draft the PRD (product requirements) — grounded ONLY in what follows. Never invent requirements, numbers, users, or constraints not present here.

## The confirmed idea
{idea}

## Grounded context
{context}

## Validation (the grill verdict)
{validation}

## Answered questions (question → default/answer)
{questions}

## Output — a markdown PRD draft with sections:
## Summary · ## Goals (non-goals marked) · ## Scope (in/out) · ## Requirements (each citing its ground) · ## Open questions
Every requirement line ends with its ground in brackets, e.g. "[ground: context label x]" or "[ground: validated in gate]". If a requirement has no ground, put it in Open questions instead.`;

/* ------------------------------------------------------------------ */


interface RawValidationPoint {
  verdict: 'ok' | 'concern' | 'blocking';
  claim: string;
  basis: string[];
  confidence: 'high' | 'medium' | 'low';
}

const isRawPoint = (p: unknown): p is RawValidationPoint => {
  const o = p as Record<string, unknown>;
  return (
    typeof o?.claim === 'string' &&
    (o.verdict === 'ok' || o.verdict === 'concern' || o.verdict === 'blocking') &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    Array.isArray(o.basis) &&
    o.basis.every((b) => typeof b === 'string')
  );
};

export class DefaultGrillingEngine implements GrillingEngine {
  constructor(
    /** The frozen provider-adapter interface — the ONLY way to reach an LLM (AC-4). */
    private readonly adapter: ProviderAdapter,
    private readonly options: { model?: string; maxTokens?: number } = {},
  ) {}

  async grill(req: GrillingRequest): Promise<GrillingResult> {
    if (!req.idea.trim()) {
      return {
        ok: false,
        error: { code: 'invalid-config', blocker: 'grilling: idea must not be empty (requirements-spec: empty/greeting rejected at intake)' },
      };
    }
    const prompt = GRILL_PROMPT
      .replace('{idea}', req.idea.trim())
      .replace('{context}', renderContext(req.context))
      .replace('{constraints}', renderConstraints(req.constraints));

    const completion = await this.adapter.complete(prompt, this.options);
    if (!completion.ok) return completion; // adapter failure passes through fail-closed — never fabricated

    return this.interpretGrill(completion, req);
  }

  /** Deterministic enforcement over the model output (the honesty layer). */
  private interpretGrill(completion: CompletionSuccess, req: GrillingRequest): GrillingResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(unquote(completion.text));
    } catch {
      return { ok: false, error: { code: 'bad-response', blocker: 'grilling model returned unparseable output — treated as failure, never fabricated' } };
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || !Array.isArray(o.validation) || !Array.isArray(o.questions) || typeof o.summary !== 'string') {
      return { ok: false, error: { code: 'bad-response', blocker: 'grilling model output violated the shape contract (summary + validation[] + questions[]) — treated as failure' } };
    }
    if (o.validation.length === 0 && o.questions.length === 0) {
      return { ok: false, error: { code: 'bad-response', blocker: 'grilling model returned an empty grill (no validation, no questions) — nothing to gate on, treated as failure' } };
    }

    const byLabel = new Map((req.context ?? []).map((c) => [c.label, c]));
    const validation: ValidationPoint[] = [];
    const questions: GrillQuestion[] = [];
    const seenText = new Set<string>();
    let idCounter = 0;

    for (const raw of o.validation) {
      if (!isRawPoint(raw)) continue; // malformed point dropped — the engine, not the model, is the schema authority
      const basis = raw.basis.filter((b) => byLabel.has(b)); // unknown labels dropped, never trusted
      const sourceType: SourceType = basis.length > 0 ? byLabel.get(basis[0])!.sourceType : 'inference';
      // Refuse fake precision (no silent inference): an ungrounded, low-confidence
      // assertion is a question in disguise — demote it rather than assert it.
      if (basis.length === 0 && raw.confidence === 'low') {
        const q = buildQuestion(`q${++idCounter}`, raw.claim, 'raised by the grill as an ungrounded, low-confidence claim', 'medium', seenText);
        if (q) questions.push(q);
        continue;
      }
      validation.push({ verdict: raw.verdict, claim: raw.claim, basis, sourceType, confidence: raw.confidence });
    }

    for (const raw of o.questions) {
      if (!isRawQuestion(raw)) continue;
      const q = buildQuestion(`q${++idCounter}`, raw.question, raw.reason, raw.impact, seenText, raw.options, raw.default);
      if (q) questions.push(q);
    }

    return { ok: true, artifact: { summary: o.summary, validation, questions }, usage: completion.usage };
  }

  async requirementsGrilling(req: GrillingRequest, answered: GrillingArtifact): Promise<PrdResult> {
    const prompt = PRD_PROMPT
      .replace('{idea}', req.idea.trim())
      .replace('{context}', renderContext(req.context))
      .replace(
        '{validation}',
        answered.validation.map((v) => `- [${v.verdict}] ${v.claim} (ground: ${v.basis.join(', ') || 'none — inference'})`).join('\n') || '(none)',
      )
      .replace('{questions}', answered.questions.map((q) => `- ${q.question} → ${q.default ?? '(unanswered)'}`).join('\n') || '(none)');

    const completion = await this.adapter.complete(prompt, this.options);
    if (!completion.ok) return completion;
    const text = completion.text.trim();
    if (!text) {
      return { ok: false, error: { code: 'bad-response', blocker: 'requirements-grilling returned an empty PRD — treated as failure, never fabricated' } };
    }
    return { ok: true, prd: text, usage: completion.usage };
  }

}
