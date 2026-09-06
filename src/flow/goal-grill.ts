import { AdapterError } from '../abilities/llm/index.js';
import { GroundingInput } from './steps/shared.js';
import { Abilities, ResearchFinding } from './types.js';
import { GrillProfile, GrillSession, ResolvedQuestion } from './grill-session.js';

/**
 * L2 · THE GOAL AREA of the grilling engine (goal! seed) v4 — a GOAL-scope grill that
 * grinds a ROUGH goal into a SHARP, PRODUCT-LEVEL one the engine can seed.
 *
 * The grilling LOOP lives in the PORTABLE core (src/flow/grill-session.ts) and is
 * area-neutral: ANSWER → LLM RESPONSE → DISCUSS → LLM-assessed DECISION, exhaustion-driven
 * end, never re-ask, research only on advice + agreement, anti-runaway ceiling,
 * fail-closed. What makes a session a GOAL grill rather than any other area is the
 * BOUNDARY it grills within, registered here as GOAL_PROFILE. Deliberately NOT the task
 * idea-validate session: that loop treats a human 'revise' as TERMINAL (bounded out →
 * recommend revise → done), which is right for a task idea but wrong for grilling a
 * GOAL — a goal that needs refining must be refined IN-SESSION and re-grilled, never
 * abandoned mid-thought.
 *
 * THE GOAL BOUNDARY (the point of this shape): the goal grill stays AT PRODUCT LEVEL.
 * It grills the idea / the function and its modules / the WHAT + WHY / the user and the
 * value / scope — a checkable outcome sentence and its success criteria. It MUST NOT ask
 * HOW to implement (tech stack, data models, algorithms, endpoints, internal
 * architecture, performance tuning) — when the model or the human drifts below the
 * boundary, the grill DEFERS: the topic is noted as 'belongs to a later stage
 * (spec / system-design / implementation)' and is NOT grilled. The goal stays a
 * product/outcome statement through the whole session.
 *
 * The session ends on a GO (seeds), a skip / abort (the human quits), or — only if the
 * loop keeps being asked to continue without converging — the anti-runaway ceiling. GO is
 * ONLY ever the human's call. Provider/adapter failures fail CLOSED ({ok:false}) —
 * nothing is fabricated, nothing is seeded.
 */

/** THE GOAL grill directive — what the shared grilling engine must do to grill a GOAL,
 *  and the PRODUCT BOUNDARY that keeps it above implementation. Appended verbatim to the
 *  grill prompt (via GrillingRequest.instructions); summary = the refined one-line goal ·
 *  questions work the frontier at product level · nothing already answered is re-asked. */
export const GOAL_GRILL_MODE = `You are grilling a GOAL at PRODUCT level — NOT a finished product and NOT an implementation plan. The 'idea' is the CURRENT WORKING DRAFT of the goal statement.

Read the draft against EVERYTHING in the context — every prior answer and research finding — before you write anything. The draft is refined as the grill proceeds; build on what is already answered.

## The boundary you grill within (hard — the whole grill is subject to it)
Stay ABOVE implementation. A goal grill works the WHAT and the WHY, never the HOW. Grill at product level only:
- the IDEA itself and the function it serves — what the user is trying to accomplish;
- the USER and the VALUE — who it is for, why it matters to them;
- SCOPE — the checkable outcome and what is deliberately in / out.
NEVER ask HOW to build it: no tech stack, frameworks, or libraries; no data models or schemas; no algorithms; no API endpoints; no internal architecture; no performance-tuning specifics. Those belong to a later stage (spec / system-design / implementation), not to a goal grill.

## When the draft or the human drifts below the boundary
DEFER, do not grill. If the topic is HOW something would be built, note it as 'belongs to a later stage (spec / system-design / implementation)' and do NOT grill it — do not turn a HOW into a question, and do not raise a concern that the goal lacks implementation detail. The goal stays a product/outcome statement.

## Your 'summary' must be
ONE refined product/outcome sentence: the goal as it now reads AT PRODUCT LEVEL, tightened in the light of everything answered and researched so far. Preserve the human's words and intent where they are sound; sharpen only what is genuinely weak or ambiguous. It must read as a concrete, checkable outcome — a reader can tell when it is done. One line, no padding, no second paragraph, no implementation language.

## Your 'validation' must be
Judgments about the CURRENT goal draft, grounded in the PROVIDED context labels — never invented facts:
- 'ok' — this part of the goal is now settled / sound as stated;
- 'concern' — needs attention before the goal is truly solid;
- 'blocking' — the goal as stated cannot proceed.
Judgments live at the SAME product boundary: a missing HOW is a DEFERRAL, never a blocking concern here. Cite the context labels you lean on; ungrounded, low-confidence guesses belong in questions, not validation.

## Your 'questions' must be
ONLY genuinely NEW product-level unknowns. Do NOT re-ask anything the context already answers — the context lists every prior answer and research finding, so a question that restates one is a defect. The human should never answer the same thing twice.
Work the FRONTIER: ask the biggest remaining product-level unknown first, then the questions that depend on it — never a flat pile.
Every question MUST carry 'options' (the plausible choices) and a 'default' (your recommended answer), so the human can answer in one word. Never an open-ended probe without a recommendation.
A high-impact unknown is always a question — never a guess smuggled into validation.
No question below the boundary: if the only remaining unknown is HOW to build something, that is a signal the goal is product-complete — defer it, do not ask it.`;

/** THE GOAL reasoning directive — the half of the grill that thinks the answers BACK to
 *  the human instead of asking more. Shared by the synthesis (respond), discussion, and
 *  research-follow-up turns. Kept as its own exported constant so tests can prove the
 *  reasoning turns actually used it, and aligned to the SAME product boundary as the
 *  grill. */
export const GOAL_DISCUSS_MODE = `You are the REASONING half of a goal grill, not another question-asker. New input just arrived and you must think it back to the human.

Read the CURRENT GOAL DRAFT against EVERYTHING in the context — every prior answer and research finding — and the full discussion transcript, before you write anything.

## What your reply must do
- INTERPRET the new input against the goal draft: what is now SETTLED, what CHANGED about how the goal reads, and what is still genuinely WEAK or OPEN. Never a bare restatement of the answers — a bare list is the failure mode this grill was built to avoid.
- RECOMMEND a next move and WHY: seed now (GO), keep grilling new questions (dig more), or reshape the goal in-session (refine).
- If a genuine PRODUCT-level unknown can ONLY be answered by outside research, recommend ONE research topic with the reason. Nothing runs until the human agrees.

## The boundary (hard)
Stay AT PRODUCT level — the WHAT and the WHY, never the HOW. If the human pushes into implementation (tech stack, data models, schemas, algorithms, endpoints, internal architecture, performance tuning), DEFER: say the topic 'belongs to a later stage (spec / system-design / implementation)' and steer the reasoning back to the product/outcome level. Never turn a HOW into a dig-more recommendation or a blocking concern — the goal stays product-level.

## Hard rules
- CONCLUSION-FIRST and SHORT: open with the outcome or your recommended next move, then the tightest support needed — never lead with the transcript or a build-up, and cap the whole reply at a few short lines (a discussion answer is 1-3 short sentences), never a paragraph dump.
- Ground every claim in the PROVIDED context labels; never invent facts, numbers, users, or sources.
- Do NOT re-ask anything the context already answers.
- Keep it concrete and honest: name the actual weakness, not a generic 'more clarity needed'.`;

/** THE GOAL AREA — the boundary a goal grill may ask within, and what is explicitly OUT
 *  (deferred to spec / system-design / implementation). Everything the loop needs that is
 *  NOT area-specific lives in the core; this profile supplies ONLY what a goal session
 *  varies. */
export const GOAL_PROFILE: GrillProfile = {
  id: 'goal',
  title: 'Goal grill',
  noun: 'goal',
  seedVerb: 'goal! seed',
  goAction: 'Seed now',
  focus:
    'Grill a rough goal at PRODUCT level into a checkable one-line goal + success criteria — WHAT and WHY only; any HOW is deferred to spec / system-design / implementation.',
  grilling: GOAL_GRILL_MODE,
  reasoning: GOAL_DISCUSS_MODE,
  decisionWeighIn: {
    exhausted:
      'The round is EXHAUSTED — the grill raised no new product-level questions and nothing meaningful stays open, so digging further is not an option this round: recommend GO unless the DRAFT itself is weak (then refine). Ground the reason in the transcript/context.',
    open: 'Be honest, never session-shortening: GO only if the goal is genuinely seedable now at product level (a reader can tell when it is done and no meaningful product-level unknown blocks a checkable criterion); dig more if a meaningful unknown still blocks that; refine if the DRAFT itself is weak. Never dig or refine a HOW — a missing implementation detail is a deferral, not a reason to continue. Ground the reason in the transcript/context.',
  },
  refineAsk:
    'What should change about the goal? Refine the goal statement in your own words — the next round grills what you say here.',
  defaultMaxRounds: 40,
  defaultMaxDiscussTurns: 6,
};

/** A question the human (or research) RESOLVED during a goal grill. */
export type GoalResolvedQuestion = ResolvedQuestion;

export interface GoalGrillOptions {
  /** The goal statement to grill (a rough idea is fine — the grill sharpens it). */
  statement: string;
  /** Pre-existing grounding (e.g. an earlier goal being re-seeded). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
  /** Bounded rounds (flow-control §3 — never unbounded). */
  maxRounds?: number;
  /** Bounded in-discussion exchanges per round (flow-control §3 — never unbounded). */
  maxDiscussTurns?: number;
}

export type GoalGrillResult =
  | {
      ok: true;
      verdict: 'solid';
      /** The REFINED one-line goal — the statement as it read when the human said GO. */
      goal: string;
      /** The last round's 'ok' validation claims (the read the human approved). */
      okClaims: string[];
      resolved: GoalResolvedQuestion[];
      researchLog: ResearchFinding[];
      rounds: number;
    }
  | { ok: true; verdict: 'reject'; reason: 'skipped' | 'aborted'; note: string; rounds: number }
  | { ok: true; verdict: 'exhausted'; note: string; rounds: number }
  | { ok: false; error: AdapterError };

/** The thin GOAL adapter over the portable {@link GrillSession}: wires the GOAL_PROFILE
 *  in, maps the generic grill's `subject`/`statement` back to the goal vocabulary goal
 *  seed and its callers already speak. The loop itself is the core's. */
export class GoalGrillSession {
  private readonly core: GrillSession;
  constructor(abilities: Abilities, options: { model?: string; maxTokens?: number } = {}) {
    this.core = new GrillSession(abilities, GOAL_PROFILE, options);
  }

  async run(opts: GoalGrillOptions): Promise<GoalGrillResult> {
    if (!opts.statement.trim()) {
      return { ok: false, error: { code: 'invalid-config', blocker: 'goal grill: the goal statement must not be empty' } };
    }
    const r = await this.core.run({
      subject: opts.statement.trim(),
      ...(opts.context?.length ? { context: opts.context } : {}),
      ...(opts.constraints?.length ? { constraints: opts.constraints } : {}),
      ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
      ...(opts.maxDiscussTurns !== undefined ? { maxDiscussTurns: opts.maxDiscussTurns } : {}),
    });
    if (!r.ok) return { ok: false, error: r.error };
    switch (r.verdict) {
      case 'solid':
        return {
          ok: true,
          verdict: 'solid',
          goal: r.statement,
          okClaims: r.okClaims,
          resolved: r.resolved,
          researchLog: r.researchLog,
          rounds: r.rounds,
        };
      case 'reject':
        return { ok: true, verdict: 'reject', reason: r.reason, note: r.note, rounds: r.rounds };
      case 'exhausted':
        return { ok: true, verdict: 'exhausted', note: r.note, rounds: r.rounds };
    }
  }
}
