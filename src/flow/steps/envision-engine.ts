import { ProviderAdapter, CompletionSuccess, CompletionUsage, AdapterError } from '../../adapters/provider/index.js';
import {
  GroundingInput,
  GrillQuestion,
  SourceType,
  isRawQuestion,
  buildQuestion,
  renderContext,
  renderConstraints,
  unquote,
} from './shared.js';

/**
 * The envision engine (S2) — F8: the beginning build step, AFTER the idea is confirmed.
 *
 * Helps the builder imagine USAGE (who uses it, scenarios, flows) and LOOK (surface /
 * key elements) → a product-vision artifact (usage + look). Batch-asks vision questions
 * at the end (flow-control v6 §7). Chain effect: detailed specs (F9, S5) spawn after —
 * the vision artifact is the spec step's input.
 *
 * Honesty invariants (design §4/§6, task AC-3/AC-4 — same honesty layer as grilling):
 *  - every usage/look claim carries provenance: cited `basis` labels must exist in the
 *    provided context (unknown labels dropped, never trusted); ungrounded claims are
 *    labeled 'inference' — the vision's imaginative parts are honest projections, never
 *    sourced-sounding facts (no invented users, numbers, prices);
 *  - refuses fake precision: ungrounded + low-confidence claims become QUESTIONS;
 *  - model output is parsed and shape-validated deterministically; unparseable /
 *    malformed / empty → {ok:false} failure, never fabricated;
 *  - provider calls go ONLY through the frozen ProviderAdapter interface (AC-4).
 */

export interface VisionRequest {
  /** The CONFIRMED idea — the vision step runs only after the idea's gate (F8). */
  idea: string;
  /** Grounding context with provenance (packet-style, design §6). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
}

export interface VisionClaim {
  /** A usage or look statement — the vision's content. */
  claim: string;
  kind: 'who' | 'scenario' | 'flow' | 'surface' | 'element';
  /** Grounding: cited context labels (validated against the request's context). */
  basis: string[];
  /** Provenance (design §6): 'inference' iff ungrounded (the model's projection). */
  sourceType: SourceType;
  confidence: 'high' | 'medium' | 'low';
}

export interface VisionArtifact {
  summary: string;
  /** Usage — who uses it, scenarios, flows (each claim with provenance). */
  usage: VisionClaim[];
  /** Look — the surface and its key elements (each claim with provenance). */
  look: VisionClaim[];
  /** The batch-ask set — vision questions asked together at the end (flow-control v6 §7). */
  questions: GrillQuestion[];
}

export type VisionResult =
  | { ok: true; artifact: VisionArtifact; usage: CompletionUsage }
  | { ok: false; error: AdapterError };

export interface EnvisionEngine {
  envision(req: VisionRequest): Promise<VisionResult>;
}

const VISION_PROMPT = `You are the envision engine of a journey system (F8 — the beginning build step, AFTER the idea is confirmed).
Help the builder IMAGINE the product: how it will be used and what it looks like. NEVER invent sourced-sounding facts.

## The confirmed idea
{idea}

## Grounded context (cite ONLY these labels as basis; never invent a label)
{context}

## Contract constraints
{constraints}

## Output — strict JSON, no commentary, no markdown fence
{
  "summary": "one-paragraph product vision",
  "usage": [
    { "claim": "who uses it / a usage scenario / how the flow runs", "kind": "who | scenario | flow", "basis": ["label1"], "confidence": "high | medium | low" }
  ],
  "look": [
    { "claim": "what it looks like / a key surface element", "kind": "surface | element", "basis": ["label1"], "confidence": "high | medium | low" }
  ],
  "questions": [
    { "question": "...", "reason": "why the human's answer matters", "impact": "high | medium | low", "options": ["optional"], "default": "optional" }
  ]
}

## Rules (hard)
1. Cite ONLY the provided context labels as basis. A claim NOT grounded in context sets basis to [] — it is the model's projection, labeled inference.
2. NEVER assert sourced-sounding facts — invented users, counts, prices, or requirements. An unknown that matters goes into questions.
3. High-impact unknowns are ALWAYS questions, never guesses.
4. Questions are asked in a batch at the end — self-contained, each with a reason.
5. The look is inherently prospective — that is fine, but ungrounded look claims still carry basis [] (projection, not fact).`;

interface RawVisionClaim {
  claim: string;
  kind: 'who' | 'scenario' | 'flow' | 'surface' | 'element';
  basis?: string[];
  confidence: 'high' | 'medium' | 'low';
}

const isRawVisionClaim = (p: unknown): p is RawVisionClaim => {
  const o = p as Record<string, unknown>;
  return (
    typeof o?.claim === 'string' &&
    ['who', 'scenario', 'flow', 'surface', 'element'].includes(String(o.kind)) &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    (o.basis === undefined || (Array.isArray(o.basis) && o.basis.every((b) => typeof b === 'string')))
  );
};

export class DefaultEnvisionEngine implements EnvisionEngine {
  constructor(
    /** The frozen provider-adapter interface — the ONLY way to reach an LLM (AC-4). */
    private readonly adapter: ProviderAdapter,
    private readonly options: { model?: string; maxTokens?: number } = {},
  ) {}

  async envision(req: VisionRequest): Promise<VisionResult> {
    if (!req.idea.trim()) {
      return {
        ok: false,
        error: { code: 'invalid-config', blocker: 'envision: idea must not be empty (the vision step runs only after a confirmed idea — F8)' },
      };
    }
    const prompt = VISION_PROMPT
      .replace('{idea}', req.idea.trim())
      .replace('{context}', renderContext(req.context))
      .replace('{constraints}', renderConstraints(req.constraints));

    const completion = await this.adapter.complete(prompt, this.options);
    if (!completion.ok) return completion; // adapter failure passes through fail-closed — never fabricated

    return this.interpretVision(completion, req);
  }

  /** Deterministic enforcement over the model output (the honesty layer). */
  private interpretVision(completion: CompletionSuccess, req: VisionRequest): VisionResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(unquote(completion.text));
    } catch {
      return { ok: false, error: { code: 'bad-response', blocker: 'envision model returned unparseable output — treated as failure, never fabricated' } };
    }
    const o = parsed as Record<string, unknown> | null;
    if (!o || !Array.isArray(o.usage) || !Array.isArray(o.look) || !Array.isArray(o.questions) || typeof o.summary !== 'string') {
      return { ok: false, error: { code: 'bad-response', blocker: 'envision model output violated the shape contract (summary + usage[] + look[] + questions[]) — treated as failure' } };
    }
    if (o.usage.length === 0 && o.look.length === 0 && o.questions.length === 0) {
      return { ok: false, error: { code: 'bad-response', blocker: 'envision model returned an empty vision (no usage, no look, no questions) — nothing to build from, treated as failure' } };
    }

    const byLabel = new Map((req.context ?? []).map((c) => [c.label, c]));
    const claims: VisionClaim[] = [];
    const questions: GrillQuestion[] = [];
    const seenText = new Set<string>();
    let idCounter = 0;

    for (const raw of [...(o.usage as unknown[]), ...(o.look as unknown[])]) {
      if (!isRawVisionClaim(raw)) continue; // malformed claim dropped — the engine, not the model, is the schema authority
      const basis = (raw.basis ?? []).filter((b) => byLabel.has(b)); // unknown labels dropped, never trusted
      const sourceType: SourceType = basis.length > 0 ? byLabel.get(basis[0])!.sourceType : 'inference';
      // Refuse fake precision (no silent inference): an ungrounded, low-confidence
      // claim is a question in disguise — demote it rather than assert it.
      if (basis.length === 0 && raw.confidence === 'low') {
        const q = buildQuestion(`q${++idCounter}`, raw.claim, 'raised by the envision step as an ungrounded, low-confidence projection', 'medium', seenText);
        if (q) questions.push(q);
        continue;
      }
      claims.push({ claim: raw.claim, kind: raw.kind, basis, sourceType, confidence: raw.confidence });
    }

    for (const raw of o.questions) {
      if (!isRawQuestion(raw)) continue;
      const q = buildQuestion(`q${++idCounter}`, raw.question, raw.reason, raw.impact, seenText, raw.options, raw.default);
      if (q) questions.push(q);
    }

    const usage = claims.filter((c) => ['who', 'scenario', 'flow'].includes(c.kind));
    const look = claims.filter((c) => ['surface', 'element'].includes(c.kind));
    return { ok: true, artifact: { summary: o.summary, usage, look, questions }, usage: completion.usage };
  }
}
