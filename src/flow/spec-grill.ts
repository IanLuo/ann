import { GrillProfile } from './grill-session.js';

/**
 * L2 · THE SPECS AREA of the grilling engine — a session-scope grill that grinds the
 * SEEDED GOAL (grounded on the goal + the in-force docs) into ONE concrete, checkable
 * spec doc at the REQUIREMENTS/SYSTEM-DESIGN level — what the system must do, scope,
 * constraints, and acceptance criteria — which the driver (src/flow/spec-doc.ts)
 * materializes on the human's GO as docs/<name>.md. On an AMEND run the same session
 * targets an EXISTING in-force spec doc, grounds on its current content + the goal +
 * work context, and writes a REVISED version in place — because specs are LIVING,
 * amendable guidance (unlike the immutable goal).
 *
 * The grilling LOOP lives in the PORTABLE core (src/flow/grill-session.ts) and is
 * area-neutral: ANSWER → LLM RESPONSE → DISCUSS → LLM-assessed DECISION, exhaustion-driven
 * end, never re-ask, research only on advice + agreement, anti-runaway ceiling,
 * fail-closed. What makes a session a SPEC grill rather than any other area is the
 * BOUNDARY it grills within, registered here as SPECS_PROFILE. It is the SAME session
 * shape as the goal and design grills — refine-in-session, GO is the human's call.
 *
 * THE SPECS BOUNDARY (the point of this shape): the spec grill stays AT REQUIREMENTS /
 * SYSTEM-DESIGN level — above code, and never a re-argument of what the goal already
 * fixed. It grills what the SYSTEM must do, the scope (in/out), the constraints the
 * design must honor, and the acceptance criteria at the requirements level — how a
 * reader tells the required behavior is met. It MUST NOT ask HOW it is implemented
 * (tech stack, data models, schemas, algorithms, endpoints, component/architecture
 * structure, performance tuning) — when the model or the human drifts below the
 * boundary, the grill DEFERS: the topic is noted as 'belongs to the implementation
 * stage' and is NOT grilled. It also does NOT re-argue the product scope the goal's
 * success criteria already fixed — the spec works WITHIN them.
 *
 * The session ends on a GO (the driver writes/rewrites the spec doc), a skip / abort
 * (nothing), or — only if the loop keeps being asked to continue without converging —
 * the anti-runaway ceiling. GO is ONLY ever the human's call. Provider/adapter failures
 * fail CLOSED ({ok:false}) — nothing is fabricated, nothing is written.
 */

/** THE SPECS grill directive — what the shared grilling engine must do to grill a SPEC,
 *  and the REQUIREMENTS/SYSTEM-DESIGN BOUNDARY that keeps it above code and below a
 *  re-argument of the goal. Appended verbatim to the grill prompt (via
 *  GrillingRequest.instructions); summary = the refined one-line spec reading ·
 *  questions work the frontier at spec level · nothing already answered is re-asked. */
export const SPEC_GRILL_MODE = `You are grilling a SPEC at REQUIREMENTS/SYSTEM-DESIGN level — NOT code, NOT an implementation plan, NOT the goal itself, and NOT a re-argument of what the goal already fixed. The 'idea' is the CURRENT WORKING DRAFT of the spec (what the system must do). On a PRODUCE session the draft begins as the SEEDED GOAL and is reshaped into spec language; on an AMEND session it begins as the CURRENT IN-FORCE SPEC DOC being revised in place.

Read the draft against EVERYTHING in the context — every prior answer, every in-force doc, and the goal — before you write anything. The draft is refined as the grill proceeds; build on what is already answered.

## The boundary you grill within (hard — the whole grill is subject to it)
Stay above CODE and within the scope the goal already fixed. A spec grill works the REQUIREMENTS — what the realized system must do — never the HOW it is built and never a re-argument of the goal's success criteria. Grill at requirements/system-design level only:
- WHAT THE SYSTEM MUST DO — the concrete, checkable behaviors and functions it provides;
- SCOPE — the requirement boundary: what is deliberately IN and OUT of the spec;
- CONSTRAINTS — the limits and non-negotiables the design must honor;
- ACCEPTANCE CRITERIA at the requirements level — how a reader tells the required behavior is met;
- the GOAL it realizes and the IN-FORCE docs it must stay consistent with.
NEVER ask HOW it is implemented: no tech stack, frameworks, or libraries; no data models or schemas; no algorithms; no API endpoints; no component/engineering structure; no performance-tuning specifics. Those belong to the implementation stage, not to a spec grill.
NEVER re-grill what the goal already fixed: the seeded goal (docs/goal.md) locks the product-level outcome and its success criteria — the spec works WITHIN them and does not re-argue them.

## When the draft or the human drifts below the boundary
DEFER, do not grill. If the topic is HOW something would be built, note it as 'belongs to the implementation stage' and do NOT grill it — do not turn a HOW into a question, and do not raise a concern that the spec lacks implementation detail. If the topic is a product decision the goal already fixed, note it as 'already decided upstream (the goal)' and do NOT grill it. The spec stays a requirements/system-design statement.

## Your 'summary' must be
ONE refined requirements-level sentence: the spec as it now reads AT REQUIREMENTS/SYSTEM-DESIGN level, tightened in the light of everything answered and researched so far. Preserve the goal's intent where it is sound; sharpen only what is genuinely weak or ambiguous. It must read as the concrete, checkable thing the realized system must do — a reader can tell when the required behavior is met. One line, no padding, no second paragraph, no code-level language.

## Your 'validation' must be
Judgments about the CURRENT spec draft, grounded in the PROVIDED context labels — never invented facts:
- 'ok' — this part of the spec is now settled / sound as stated;
- 'concern' — needs attention before the spec is truly solid;
- 'blocking' — the spec as stated cannot proceed.
Judgments live at the SAME requirements boundary: a missing HOW is a DEFERRAL, never a blocking concern here. Cite the context labels you lean on; ungrounded, low-confidence guesses belong in questions, not validation.

## Your 'questions' must be
ONLY genuinely NEW requirements-level unknowns. Do NOT re-ask anything the context already answers — the context lists every prior answer and research finding, so a question that restates one is a defect. The human should never answer the same thing twice.
Work the FRONTIER: ask the biggest remaining spec-level unknown first, then the questions that depend on it — never a flat pile.
Every question MUST carry 'options' (the plausible choices) and a 'default' (your recommended answer), so the human can answer in one word. Never an open-ended probe without a recommendation.
A high-impact unknown is always a question — never a guess smuggled into validation.
No question below the boundary: if the only remaining unknown is HOW to build something, that is a signal the spec is requirements-complete — defer it, do not ask it.`;

/** THE SPECS reasoning directive — the half of the grill that thinks the answers BACK
 *  to the human instead of asking more. Shared by the synthesis (respond), discussion,
 *  and research-follow-up turns. Kept as its own exported constant so tests can prove
 *  the reasoning turns actually used it, and aligned to the SAME requirements boundary
 *  as the grill. */
export const SPEC_DISCUSS_MODE = `You are the REASONING half of a spec grill, not another question-asker. New input just arrived and you must think it back to the human.

Read the CURRENT SPEC DRAFT against EVERYTHING in the context — every prior answer, every in-force doc, the goal — and the full discussion transcript, before you write anything.

## What your reply must do
- INTERPRET the new input against the spec draft: what is now SETTLED, what CHANGED about how the spec reads, and what is still genuinely WEAK or OPEN. Never a bare restatement of the answers — a bare list is the failure mode this grill was built to avoid.
- RECOMMEND a next move and WHY: write the spec now (GO), keep grilling new requirements questions (dig more), or reshape the spec in-session (refine).
- If a genuine REQUIREMENTS-level unknown can ONLY be answered by outside research (e.g. an in-force doc to reconcile with), recommend ONE research topic with the reason. Nothing runs until the human agrees.

## The boundary (hard)
Stay AT REQUIREMENTS/SYSTEM-DESIGN level — what the system must do, scope, constraints, acceptance criteria — never the HOW. If the human pushes into code (tech stack, data models, schemas, algorithms, endpoints, component/architecture structure, performance tuning), DEFER: say the topic 'belongs to the implementation stage' and steer the reasoning back to the requirements level. If the human pushes into product scope the goal already fixed, DEFER: 'already decided upstream (the goal)'. Never turn a HOW into a dig-more recommendation or a blocking concern — the spec stays requirements/system-design level.

## Hard rules
- CONCLUSION-FIRST and SHORT: open with the outcome or your recommended next move, then the tightest support needed — never lead with the transcript or a build-up, and cap the whole reply at a few short lines (a discussion answer is 1-3 short sentences), never a paragraph dump.
- Ground every claim in the PROVIDED context labels; never invent facts, constraints, or sources.
- Do NOT re-ask anything the context already answers.
- Keep it concrete and honest: name the actual weakness, not a generic 'more clarity needed'.`;

/** THE SPECS AREA — the boundary a spec grill may ask within, and what is explicitly OUT
 *  (deferred to the implementation stage / already decided upstream by the goal).
 *  Everything the loop needs that is NOT area-specific lives in the core; this profile
 *  supplies ONLY what a SPECS session varies. */
export const SPECS_PROFILE: GrillProfile = {
  id: 'spec',
  title: 'Spec grill',
  noun: 'spec',
  seedVerb: 'spec!',
  goAction: 'Write the spec',
  focus:
    'Grill the seeded goal (grounded on the in-force docs) at REQUIREMENTS/SYSTEM-DESIGN level into one concrete, checkable spec doc — what the system must do, scope, constraints, acceptance criteria only; any code-level HOW is deferred to the implementation stage and the goal’s product scope is not re-argued.',
  grilling: SPEC_GRILL_MODE,
  reasoning: SPEC_DISCUSS_MODE,
  decisionWeighIn: {
    exhausted:
      'The round is EXHAUSTED — the grill raised no new requirements-level questions and nothing meaningful stays open, so digging further is not an option this round: recommend GO unless the DRAFT itself is weak (then refine). Ground the reason in the transcript/context.',
    open: 'Be honest, never session-shortening: GO only if the spec is genuinely concrete and checkable now at requirements/system-design level (a reader can tell when the required behavior is met and no meaningful spec-level unknown blocks it); dig more if a meaningful unknown still blocks that; refine if the DRAFT itself is weak. Never dig or refine a HOW — a missing code-level detail is a deferral to the implementation stage, not a reason to continue. Ground the reason in the transcript/context.',
  },
  refineAsk:
    'What should change about the spec? Refine the spec in your own words — the next round grills what you say here.',
  defaultMaxRounds: 40,
  defaultMaxDiscussTurns: 6,
};
