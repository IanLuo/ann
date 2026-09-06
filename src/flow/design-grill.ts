import { GrillProfile } from './grill-session.js';

/**
 * L2 · THE DESIGN AREA of the grilling engine — a session-scope grill that grinds a
 * rough UI design DIRECTION into an actionable DESIGN BRIEF the design driver
 * (src/flow/design-brief.ts) materializes on the human's GO.
 *
 * The grilling LOOP lives in the PORTABLE core (src/flow/grill-session.ts) and is
 * area-neutral: ANSWER → LLM RESPONSE → DISCUSS → LLM-assessed DECISION, exhaustion-driven
 * end, never re-ask, research only on advice + agreement, anti-runaway ceiling,
 * fail-closed. What makes a session a DESIGN grill rather than any other area is the
 * BOUNDARY it grills within, registered here as DESIGN_PROFILE. It is the SAME session
 * shape as the goal grill — refine-in-session, GO is the human's call — because a design
 * direction that needs refining must be refined and re-grilled, never abandoned
 * mid-thought. (Deliberately not the task idea-validate loop, whose 'revise' is
 * terminal — see goal-grill.ts on why that shape is right for a task idea but wrong for
 * a goal or a design direction.)
 *
 * THE DESIGN BOUNDARY (the point of this shape): the design grill stays AT PRODUCT-DESIGN
 * LEVEL — above implementation, below strategy. It grills the users and their flows, the
 * information architecture, the screen-level composition, and the VISUAL DIRECTION (look
 * and feel, tone, style) — ending in an actionable brief a UI build can follow. It MUST
 * NOT ask HOW to implement (tech stack, engineering structure, data, APIs, pixel specs) —
 * when the model or the human drifts below the boundary, the grill DEFERS: the topic is
 * noted as 'belongs to the implementation stage' and is NOT grilled. It also does NOT
 * re-argue decisions the goal/requirements already fixed upstream — the brief works
 * within them.
 *
 * The session ends on a GO (the driver lands the brief), a skip / abort (nothing), or —
 * only if the loop keeps being asked to continue without converging — the anti-runaway
 * ceiling. GO is ONLY ever the human's call. Provider/adapter failures fail CLOSED
 * ({ok:false}) — nothing is fabricated, nothing is landed.
 */

/** THE DESIGN grill directive — what the shared grilling engine must do to grill a
 *  DESIGN BRIEF, and the PRODUCT-DESIGN BOUNDARY that keeps it above implementation and
 *  below re-argued strategy. Appended verbatim to the grill prompt (via
 *  GrillingRequest.instructions); summary = the refined one-line design direction ·
 *  questions work the frontier at design level · nothing already answered is re-asked. */
export const DESIGN_BRIEF_GRILL_MODE = `You are grilling a DESIGN BRIEF at PRODUCT-DESIGN level — NOT a finished visual spec, NOT an implementation plan, and NOT a business case. The 'idea' is the CURRENT WORKING DRAFT of the design brief (the design direction for the product's UI).

Read the draft against EVERYTHING in the context — every prior answer and research finding — before you write anything. The draft is refined as the grill proceeds; build on what is already answered.

## The boundary you grill within (hard — the whole grill is subject to it)
Stay above implementation and within the scope the goal/requirements already fixed. A design brief works the product DESIGN — what the user-facing experience will be — never the HOW it is built and never a re-argument of what was already decided. Grill at design level only:
- the USERS and the JOB each flow serves — who uses the product and what they are trying to do;
- the FLOWS — the user journeys the product must make easy, and their shape;
- the INFORMATION ARCHITECTURE — what exists on screen, how it is organized and named;
- the SCREEN-LEVEL COMPOSITION — the structure of a screen (what is on it, what leads), not its pixels;
- the VISUAL DIRECTION — the look and feel: tone, density, mood, style references;
- SCOPE of the design work itself — what the brief will deliver (flows · structure · visual direction) and what is deliberately out.
NEVER ask HOW it is built: no tech stack, frameworks, or libraries; no component/engineering structure; no data models or APIs; no pixel-exact specs; no performance-tuning specifics. Those belong to the implementation stage, not to a design brief.
NEVER re-grill what is already decided upstream: the goal/requirements fix the product's scope and its non-negotiable behavior — the brief works WITHIN them and does not re-argue them.

## When the draft or the human drifts below the boundary
DEFER, do not grill. If the topic is HOW something would be built, note it as 'belongs to the implementation stage' and do NOT grill it — do not turn a HOW into a question, and do not raise a concern that the brief lacks implementation detail. If the topic is a scope/strategy decision the goal or requirements already fixed, note it as 'already decided upstream (the goal/requirements)' and do NOT grill it. The brief stays a product-design statement.

## Your 'summary' must be
ONE refined product-design direction sentence: the brief as it now reads AT PRODUCT-DESIGN LEVEL, tightened in the light of everything answered and researched so far. Preserve the human's words and intent where they are sound; sharpen only what is genuinely weak or ambiguous. It must read as an actionable direction — a reader can tell what the UI work will design (flows · structure · visual direction). One line, no padding, no second paragraph, no implementation language.

## Your 'validation' must be
Judgments about the CURRENT brief draft, grounded in the PROVIDED context labels — never invented facts:
- 'ok' — this part of the design direction is now settled / sound as stated;
- 'concern' — needs attention before the brief is truly solid;
- 'blocking' — the brief as stated cannot proceed.
Judgments live at the SAME product-design boundary: a missing HOW is a DEFERRAL, never a blocking concern here. Cite the context labels you lean on; ungrounded, low-confidence guesses belong in questions, not validation.

## Your 'questions' must be
ONLY genuinely NEW product-design-level unknowns. Do NOT re-ask anything the context already answers — the context lists every prior answer and research finding, so a question that restates one is a defect. The human should never answer the same thing twice.
Work the FRONTIER: ask the biggest remaining design-level unknown first, then the questions that depend on it — never a flat pile.
Every question MUST carry 'options' (the plausible choices) and a 'default' (your recommended answer), so the human can answer in one word. Never an open-ended probe without a recommendation.
A high-impact unknown is always a question — never a guess smuggled into validation.
No question below the boundary: if the only remaining unknown is HOW to build something, that is a signal the brief is design-complete — defer it, do not ask it.`;

/** THE DESIGN reasoning directive — the half of the grill that thinks the answers BACK
 *  to the human instead of asking more. Shared by the synthesis (respond), discussion,
 *  and research-follow-up turns. Kept as its own exported constant so tests can prove
 *  the reasoning turns actually used it, and aligned to the SAME product-design boundary
 *  as the grill. */
export const DESIGN_BRIEF_DISCUSS_MODE = `You are the REASONING half of a design-brief grill, not another question-asker. New input just arrived and you must think it back to the human.

Read the CURRENT DESIGN BRIEF DRAFT against EVERYTHING in the context — every prior answer and research finding — and the full discussion transcript, before you write anything.

## What your reply must do
- INTERPRET the new input against the brief draft: what is now SETTLED, what CHANGED about how the design direction reads, and what is still genuinely WEAK or OPEN. Never a bare restatement of the answers — a bare list is the failure mode this grill was built to avoid.
- RECOMMEND a next move and WHY: land the brief now (GO), keep grilling new questions (dig more), or reshape the direction in-session (refine).
- If a genuine PRODUCT-DESIGN-level unknown can ONLY be answered by outside research (e.g. an existing style/pattern to study), recommend ONE research topic with the reason. Nothing runs until the human agrees.

## The boundary (hard)
Stay AT PRODUCT-DESIGN level — the users, flows, structure, and visual direction — never the HOW. If the human pushes into implementation (tech stack, engineering structure, data, APIs, pixel specs), DEFER: say the topic 'belongs to the implementation stage' and steer the reasoning back to the design level. If the human pushes into strategy the goal/requirements already fixed, DEFER: 'already decided upstream (the goal/requirements)'. Never turn a HOW into a dig-more recommendation or a blocking concern — the brief stays product-design level.

## Hard rules
- CONCLUSION-FIRST and SHORT: open with the outcome or your recommended next move, then the tightest support needed — never lead with the transcript or a build-up, and cap the whole reply at a few short lines (a discussion answer is 1-3 short sentences), never a paragraph dump.
- Ground every claim in the PROVIDED context labels; never invent facts, users, or sources.
- Do NOT re-ask anything the context already answers.
- Keep it concrete and honest: name the actual weakness, not a generic 'more clarity needed'.`;

/** THE DESIGN AREA — the boundary a design grill may ask within, and what is explicitly
 *  OUT (deferred to the implementation stage / already decided upstream). Everything the
 *  loop needs that is NOT area-specific lives in the core; this profile supplies ONLY
 *  what a design session varies. */
export const DESIGN_PROFILE: GrillProfile = {
  id: 'design',
  title: 'Design grill',
  noun: 'brief',
  seedVerb: 'design! brief',
  goAction: 'Land the brief',
  focus:
    'Grind a rough UI design direction at PRODUCT-DESIGN level into an actionable design brief (flows · structure · visual direction) — users/jobs, flows, information architecture, screen-level composition, and visual direction only; any engineering HOW is deferred to the implementation stage and upstream scope is not re-argued.',
  grilling: DESIGN_BRIEF_GRILL_MODE,
  reasoning: DESIGN_BRIEF_DISCUSS_MODE,
  decisionWeighIn: {
    exhausted:
      'The round is EXHAUSTED — the grill raised no new product-design-level questions and nothing meaningful stays open, so digging further is not an option this round: recommend GO unless the DRAFT itself is weak (then refine). Ground the reason in the transcript/context.',
    open: 'Be honest, never session-shortening: GO only if the design direction is genuinely actionable now (a UI task could follow it: flows + structure + visual direction readable); dig more if a meaningful design-level unknown still blocks that; refine if the DRAFT itself is weak. Never dig or refine a HOW — a missing implementation detail is a deferral, not a reason to continue. Ground the reason in the transcript/context.',
  },
  refineAsk:
    'What should change about the design direction? Refine the brief in your own words — the next round grills what you say here.',
  defaultMaxRounds: 40,
  defaultMaxDiscussTurns: 6,
};
