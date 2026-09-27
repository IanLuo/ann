import { Commands, REJECT_BOUND } from '../commands/index.js';
import type { ReviewAbsence, ReviewFindingInput, ReviewFindingView } from '../store/store.js';
import {
  REVIEW_FINDINGS_MODE,
  REVIEW_GRILL_MODE,
  REVIEW_MAX_TOKENS,
  buildReviewMaterial,
  renderReviewMaterial,
  shapeFindings,
} from './review-session.js';
import type { Abilities } from './types.js';

/**
 * L2 · THE REVIEW WORKER — the headless, single-pass reviewer that DECIDES the exit gate
 * (leg 12/22; the design is `docs/gate-cadence.md` §7, whose four operator decisions are
 * this module's premise).
 *
 * THE ONE THING NOT TO SOFTEN: the model is NEVER ASKED FOR A VERDICT. It is asked for the
 * same record `ann review!` produces — localized findings in the existing shape — and ONE
 * deterministic rule ({@link deriveGateVerdict}) reads the severities and derives the
 * outcome. A model that hallucinates "accept" in prose therefore changes nothing: prose is
 * not a severity, and only the rule decides. That is what makes an automatic gate auditable
 * rather than a model's opinion with a log entry attached.
 *
 * THE THREE ARMS, and the middle one is load-bearing:
 *   · an OPEN `gap` or `regression`  → REWORK (the existing reject → re-execute loop);
 *   · an OPEN `quality` — defective bytes with no contract defect → THE HUMAN, with no
 *     rejection burned;
 *   · nothing outstanding but `uncertain` → ACCEPT, carried by the findings that DID settle
 *     something, with the questions recorded rather than decided.
 *
 * WHY `uncertain` DOES NOT BLOCK (changed 2026-09-27, on measurement — see the rule below).
 * The arm as first written sent any open `uncertain` to the human, and that made `accept`
 * unreachable: MEASURED against the configured provider on deliveries the floor had
 * certified closeable, FOUR runs returned `human` and zero returned `accept`, and the clean
 * first pass of one of them landed EIGHT `matches` and FIVE `uncertain`s with nothing wrong
 * anywhere in the delivery. A reviewer asked to say when it cannot verify a criterion from
 * text will always have something to say, so a rule that requires a flawless review is a
 * rule that never accepts — and a gate that is never accepted automatically is a gate the
 * human never left, which is the burden this whole area exists to remove.
 *
 * WHY THIS IS NOT `ann review!`. That session is interactive, terminal-only, and
 * STRUCTURALLY BARRED from deciding: `landFindings` writes `evidence` and nothing else, and
 * that property is pinned by test (`review-session.ts` AC-4). The gate needs an actor that
 * DOES decide, so the actor is separate rather than a mode of it — and it reuses the same
 * profile, the same `shapeFindings`, the same material assembly and the SAME writers
 * (`commands.gate`, `commands.landFindings`): a worker's rejection IS the `rejected` event a
 * human's is, with no new event type, no new state and no new write path.
 */

/** Who asserted a worker's findings. Stamped by this area, never taken from the model —
 *  the same rule the review session's provenance follows, and the reason a worker's record
 *  can never be read as a person's. */
export const GATE_REVIEW_PROVENANCE = 'gate review worker (model)';

/** The outcome the rule derives. Never a model's word. */
export type GateVerdict = 'accept' | 'rework' | 'human';

/**
 * THE VERDICT RULE (AC-2) — deterministic, total, and over SEVERITIES ONLY. Pure, so it is
 * testable without a provider and replayable after the fact: the same findings always
 * derive the same outcome, and the record shows which findings produced it.
 *
 * The deliberate readings:
 *   · NO FINDINGS AT ALL derives `human`, not `accept`. An empty list is not a clean
 *     delivery — it is a reviewer that said nothing, and nothing is not evidence of
 *     anything.
 *   · `quality` is an OPEN concern with no contract defect: it must not auto-rework (nothing
 *     is broken) and must not auto-accept (something is wrong), so it goes to the human.
 *     The severity vocabulary defines it as "the delivered bytes are defective in a way that
 *     will cost someone later" — localized, actionable, and not this rule's to wave through.
 *   · `uncertain` IS RAISED, NOT DECIDED. It means "a real concern you CANNOT localize to a
 *     file and line", so there is nothing for the author to fix, the bytes never change, and
 *     the next pass re-states it: as a BLOCKER it is permanent, and it made `accept`
 *     unreachable on every delivery measured. It therefore does not block — but it cannot
 *     CARRY an accept either, which is the same invariant as the empty list: a set of
 *     findings that settled nothing establishes nothing. One finding that is not
 *     `uncertain` — a `matches`, or a prior finding the current bytes resolved — is what an
 *     accept stands on, and the open questions ride the record beside it.
 *   · a RESOLVED finding of any severity is out of the way — the record's own "the current
 *     bytes settle this", which is what makes a rework's second review able to accept.
 */
export const deriveGateVerdict = (findings: readonly Pick<ReviewFindingView, 'severity' | 'status'>[]): GateVerdict => {
  if (!findings.length) return 'human';
  // AN OPEN `matches` IS NOT A CONCERN, and this is the difference between a working
  // automatic gate and a dead one. The findings contract makes the reviewer RAISE what it
  // finds ('open' for anything you are raising now; 'resolved' is reserved for a PRIOR
  // finding the current bytes settle), so a criterion the reviewer walked and asserted
  // arrives as `matches` + `open` — which is the ordinary shape of a clean first review.
  // Reading it as unsettled sends every such review to the human and makes `accept`
  // unreachable for any spec-compliant reviewer: the three arms would be two.
  const open = findings.filter((f) => f.status === 'open' && f.severity !== 'matches');
  if (open.some((f) => f.severity === 'gap' || f.severity === 'regression')) return 'rework';
  if (open.some((f) => f.severity === 'quality')) return 'human';
  return findings.some((f) => f.severity !== 'uncertain') ? 'accept' : 'human';
};

/**
 * THE WORKER'S ONE TURN. Composed from the review session's own directives rather than
 * restated, so the boundary the interactive review works within ("the gate is NOT yours",
 * "never invent a line number") is the same boundary here — the worker differs in the
 * NUMBER of turns and in what happens to its record, not in what it is allowed to say.
 *
 * The `summary` is the only extra the single pass adds: it becomes the recorded WHY of an
 * accept, and a why is required on every confirm accept (12/11). Asking for it in the same
 * strict-JSON turn keeps the worker at ONE model call.
 */
export const gateReviewPrompt = (material: string): string => `${REVIEW_GRILL_MODE}

${REVIEW_FINDINGS_MODE}

## THIS TURN, SPECIFICALLY
You get ONE turn: there is no second round and nobody to ask. Produce the complete list now,
and walk every acceptance criterion — a criterion you do not mention is a criterion this
review did nothing with.

Alongside the findings, give "summary": ONE line stating what the delivered bytes establish
against the criteria, naming what is established and what is not. When nothing is left open
it is recorded as the reason the gate was accepted, so it must be true of the material and
free of any verdict.

Reply with STRICT JSON and NOTHING ELSE:
{"findings": [ …the finding objects exactly as specified above… ], "summary": "<one line>"}

## THE MATERIAL
${material}`;

/** The strict-JSON reply, as read. Tolerant of a fenced or chatty reply ONLY in the sense
 *  of locating the object; a reply with no readable object is an ABSENCE, never a verdict. */
const parseGateReview = (raw: string): { items: unknown[]; summary: string } | undefined => {
  const text = String(raw ?? '').trim();
  const attempts = [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of attempts) {
    if (!candidate) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
    } catch {
      continue;
    }
    const r = parsed as { findings?: unknown; summary?: unknown } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Array.isArray(r.findings)) continue;
    return { items: r.findings, summary: typeof r.summary === 'string' ? r.summary.trim() : '' };
  }
  return undefined;
};

/** The open defects, rendered as the feedback a rework is routed by — the same per-finding
 *  record `ann review!` lands, which is what makes "everything found was fixed" checkable
 *  against a list rather than a digest (the 12/08 lesson this whole area exists for). */
const openDefects = (findings: readonly ReviewFindingInput[]): string =>
  findings
    .filter((f) => f.status === 'open' && (f.severity === 'gap' || f.severity === 'regression'))
    .map((f) => `${f.id} [${f.severity}] ${f.where} — ${f.text}`)
    .join(' · ');

/** The open concerns that are NOT defects — what the human is handed when the rule declines
 *  to decide, and what an accept CARRIES when it fires over them. Naming them is the point
 *  in both directions: an escalation that says only "unclear" is a card a person cannot act
 *  on, and an accept that went through over three open questions while saying nothing about
 *  them is a decision nobody can audit. A `matches` is neither: it is a criterion the
 *  reviewer asserted, and listing it here would hand the human a "concern" that is the
 *  opposite of one.
 *
 *  THE SELECTION AND THE COUNT COME FROM HERE, and that is the point of the split: the
 *  accept's why used to count `severity === 'uncertain'` inline while THIS function also
 *  gathered `quality`, so the number and the list beside it were two independent readings of
 *  the same question and could disagree. One predicate, one answer. (The rule makes an open
 *  `quality` unreachable at an accept, so the two readings agree today — which is exactly the
 *  kind of agreement nobody notices breaking.) */
const openConcernsOf = (findings: readonly ReviewFindingInput[]): ReviewFindingInput[] =>
  findings.filter((f) => f.status === 'open' && f.severity !== 'matches' && f.severity !== 'gap' && f.severity !== 'regression');

const openConcerns = (findings: readonly ReviewFindingInput[]): string =>
  openConcernsOf(findings)
    .map((f) => `${f.id} [${f.severity}] ${f.where} — ${f.text}`)
    .join(' · ');

export interface GateReviewOptions {
  /** THE REVIEWING RUN (AC-6). Stamped on the decision the worker writes, so an accept by
   *  the same run that implemented the task is checkable after the fact. */
  run?: string;
  /** Overridden by tests; the production budget is the review area's own (a findings list
   *  is the same size class as the session's strict-JSON turn). */
  maxTokens?: number;
}

export type GateReviewResult =
  /** The rule ACCEPTED: the gate is decided and, when the floor holds, the task is closed. */
  | { ok: true; verdict: 'accept'; why: string; findings: number; run?: string }
  /** The rule REWORKED: the same `rejected` event a human's rejection writes, the open
   *  defects as its feedback, and the existing re-execute rung behind it. */
  | { ok: true; verdict: 'rework'; feedback: string; findings: number; run?: string }
  /** The rule declined: the submission STANDS, nothing is decided, no rejection is burned,
   *  and the card goes back to the human exactly as it reads today. */
  | { ok: true; verdict: 'human'; reason: string; findings: number; run?: string }
  /** THE WORKER'S ABSENCE (AC-6): no provider, an unreachable endpoint, a refusal, an
   *  unparseable reply — the submission stands and the human decides, and the reason is
   *  NAMED so an outage can never silently look like a human gate. */
  | { ok: false; absent: string };

/**
 * Run the worker over `id`'s CONFIRM gate. The ORDER is the design:
 *
 *   1 · THE BOUND, BEFORE ANYTHING IS SPENT (AC-5). At REJECT_BOUND the worker is OUT —
 *       its next action is not a rejection — so it does not run at all and the human
 *       decides for real. The check is here rather than inside the loop because it must
 *       not cost a model call to discover.
 *   2 · ONE MODEL CALL, and ONE ONLY. Every failure path below is fail-closed: an
 *       unparseable or empty reply is an ABSENCE, never an accept and never a rejection.
 *   3 · THE FINDINGS LAND THROUGH THE ONE WRITER, as they are asserted, before any
 *       decision — so a worker that decides and a worker that crashes both leave the same
 *       record of what it found.
 *   4 · THE RULE READS THE SEVERITIES and the decision goes through `commands.gate`, the
 *       SAME writer a human's decision goes through (AC-3). No new event type, no new
 *       state, no new loop.
 *   5 · EVERY ARM IS ON THE RECORD (12/27). The two that DECIDE need nothing extra — the
 *       decision event IS the record. The two that leave the gate to the human are the ones
 *       that used to leave nothing: `human` rides its own review's findings landing as an
 *       `outcome`, and an ABSENCE lands an outcome-only record through the same writer, from
 *       every path. The BOUND is the exception and is not written at all — it is a property
 *       of the gate, derived where it is read (12/27 AC-3).
 */
export const runGateReview = async (
  commands: Commands,
  abilities: Abilities,
  id: string,
  opts: GateReviewOptions = {},
): Promise<GateReviewResult> => {
  const rejects = commands.rejections(id, 'confirm');
  if (rejects >= REJECT_BOUND) {
    return {
      ok: true,
      verdict: 'human',
      findings: 0,
      reason: `${REJECT_BOUND} rejection cycles are exhausted at ${id}'s confirm gate — the review worker is OUT and its next action is not a rejection. A human decides for real: override the objection (ann gate! ${id} confirm accept '<why>' --force), restructure (ann spawn! <new-task> '<contract>' then ann append! ${id} '{"at":"<date>","type":"cancelled","reason":"…"}'), or block it (ann append! ${id} '{"at":"<date>","type":"deferred","reason":"…"}').`,
    };
  }

  const material = buildReviewMaterial(commands, id);
  const run = opts.run?.trim() || undefined;

  /**
   * THE ABSENCE, ON THE RECORD (12/27 AC-2) — through the ONE writer, reached by every path
   * that runs the worker (the frame, `ann submit!`, `ann gate! --review`), so the three stop
   * disagreeing about what an absent review leaves behind. The submission STANDS in every case
   * and the gate stays the human's; what changes is that the reason is ON THE NODE rather than
   * only on a console a later reader never sees.
   *
   * No `anchorSha`: an anchor is the commit a review's citations were READ at, and nothing was
   * read. Claiming one would be the class of false claim the anchor exists to prevent.
   *
   * A record that could not be written is SAID — an absence nobody can read is the defect this
   * arm exists to remove. That is the one absence with no record behind it, because the write
   * is what failed (see `REVIEW_ABSENCES`).
   */
  const absent = (why: ReviewAbsence, reason: string): GateReviewResult => {
    const landed = commands.landFindings(id, [], {
      note: `gate review — NO REVIEW (${why}) · ${GATE_REVIEW_PROVENANCE}`,
      outcome: { verdict: 'absent', why, reason, count: 0, ...(run ? { run } : {}) },
    });
    return { ok: false, absent: landed.ok ? reason : `${reason} — AND THE OUTCOME COULD NOT BE RECORDED (${landed.error.code}: ${landed.error.blocker})` };
  };

  let raw: string;
  try {
    raw = await abilities.llm.complete({
      prompt: gateReviewPrompt(renderReviewMaterial(material)),
      maxTokens: opts.maxTokens ?? REVIEW_MAX_TOKENS,
    });
  } catch (e) {
    return absent('unavailable', `the review worker could not run — ${(e as Error).message}`);
  }
  const parsed = parseGateReview(raw);
  if (!parsed) {
    return absent('unparseable', 'the review worker did not return the strict JSON findings record — nothing was decided and the submission stands');
  }

  const findings = shapeFindings(parsed.items, GATE_REVIEW_PROVENANCE);
  if (!findings.length) {
    return absent('empty', 'the review worker returned NO findings — an empty review is not a record, so nothing was decided and the submission stands');
  }

  // THE RULE RUNS BEFORE THE LANDING, and this is the ONE ordering change 12/27 makes. The
  // rule is PURE and touches no record, so the property the old order protected is untouched —
  // the findings still land before any DECISION (`commands.gate` below) — and it buys what Q1
  // asked for: the declining arm's outcome rides the SAME event as its findings, so one review
  // stays ONE record and no reader can see findings without their verdict.
  const verdict = deriveGateVerdict(findings);
  const concerns = openConcerns(findings);
  const settled = parsed.summary || `the review walked every criterion and left no defect open (${findings.length} finding(s))`;
  const humanReason = `the review recorded ${findings.length} finding(s) and left ${concerns ? 'an open concern with no defect against the contract' : 'nothing open'}${concerns ? `: ${concerns}` : ''} — a human decides (no rejection is burned by a question the worker could not settle)${parsed.summary ? `. ${parsed.summary}` : ''}`;
  const landed = commands.landFindings(id, findings, {
    ...(material.anchor ? { anchorSha: material.anchor } : {}),
    // THE ACTOR, NAMED ONCE AND CORRECTLY. This read `(${REVIEW_PROVENANCE} worker)`, which
    // composed into "review session (model) worker" — the SESSION's constant with the word
    // appended, so the landing note named the interactive review as the author of the
    // worker's findings. The provenance FIELD was always right (`shapeFindings` is stamped
    // with GATE_REVIEW_PROVENANCE above); it was the note a human reads that lied, and only
    // a real run shows it — no unit test asserts prose nobody thought to check.
    note: `gate review — ${findings.length} finding(s) (${GATE_REVIEW_PROVENANCE})`,
    // THE DECLINING ARM IS RECORDED HERE, on its own review's event (AC-1). The DECIDING arms
    // are NOT: an accept and a rework land through `commands.gate` below, and a copy of that
    // verdict beside a gate that may never be decided is exactly the drift this field must
    // not introduce (the writer refuses one by name).
    ...(verdict === 'human' ? { outcome: { verdict: 'human' as const, reason: humanReason, count: findings.length, ...(run ? { run } : {}) } } : {}),
  });
  if (!landed.ok) {
    return { ok: false, absent: `the review worker's findings could not be recorded (${landed.error.code}: ${landed.error.blocker}) — nothing was decided` };
  }

  const actor = { kind: 'worker' as const, ...(run ? { run } : {}) };

  if (verdict === 'accept') {
    // AN ACCEPT THAT CARRIES QUESTIONS SAYS SO, IN ITS OWN WHY. A why is required on every
    // confirm accept (12/11) and it is the line a human reads on the card — so an accept
    // that fired over open `uncertain`s while reading as "nothing left open" would be the
    // silent decision this area exists to prevent. The questions are named, and they are
    // also on the record: this is the prose, `reviewFindings` is the data.
    const carried = openConcernsOf(findings);
    const why = concerns ? `${settled} — CARRIED WITH ${carried.length} OPEN QUESTION(S), raised and not decided: ${concerns}` : settled;
    const g = commands.gate(id, 'confirm', 'accept', why, { actor });
    if (!g.ok) return { ok: false, absent: `the review worker's accept could not be recorded (${g.error.code}: ${g.error.blocker}) — the submission stands` };
    return { ok: true, verdict: 'accept', why, findings: findings.length, ...(run ? { run } : {}) };
  }

  if (verdict === 'rework') {
    const feedback = `${openDefects(findings)}${parsed.summary ? ` — ${parsed.summary}` : ''}`;
    const g = commands.gate(id, 'confirm', 'reject', feedback, { actor });
    if (!g.ok) return { ok: false, absent: `the review worker's rejection could not be recorded (${g.error.code}: ${g.error.blocker}) — the submission stands` };
    return { ok: true, verdict: 'rework', feedback, findings: findings.length, ...(run ? { run } : {}) };
  }

  return {
    ok: true,
    verdict: 'human',
    findings: findings.length,
    ...(run ? { run } : {}),
    // THE SAME STRING THAT IS ON THE RECORD (AC-1), composed once above: the console narration
    // and the node's own outcome can never read differently.
    reason: humanReason,
  };
};
