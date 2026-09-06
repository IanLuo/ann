import { DefaultGrillingEngine } from './steps/idea-validate/grilling.js';
import { AdapterError } from '../abilities/llm/index.js';
import { GroundingInput, GrillQuestion } from './steps/shared.js';
import { Abilities, InteractAbort, ResearchFinding } from './types.js';
import { adapterFromAbility } from './steps/engine-adapter.js';

/**
 * L2 · THE GOAL GRILL (goal! seed) — a goal-SCOPE grill that grinds a ROUGH goal into a
 * SHARP one the engine can seed. Deliberately NOT the task idea-validate session: that
 * loop treats a human 'revise' as TERMINAL (bounded out → recommend revise → done), which
 * is right for a task idea but wrong for grilling a GOAL — a goal that needs refining
 * must be refined IN-SESSION and re-grilled, never abandoned mid-thought.
 *
 * Loop (bounded — flow-control §3, the same never-unbounded rule):
 *   state: the current goal statement · context (accumulated answers + research as
 *          grounding) · resolved[] · researchLog[] · seen (never ask a question twice)
 *
 *   per round:
 *     1. grill the CURRENT goal against ALL accumulated context (the task grilling
 *        engine + its honesty layer, with a GOAL-MODE instruction appended) → the read:
 *        summary = the goal refined into one outcome line · validation points ·
 *        NEW open questions (the instruction drives frontier-first framing, a recommended
 *        default per question, and never re-asking what the context already answers);
 *     2. present the read (round N);
 *     3. batch-ask ONLY the new questions (dedupe on question text) — answers fold into
 *        context + resolved[];
 *     4. research: high-impact questions still open become research topics; findings fold
 *        back with provenance (and the driver offers a deeper RESEARCH at the decision);
 *     5. ROUND SUMMARY — always shown before the verdict: this round · what is resolved
 *        (running) · what is still open · the goal AS IT READS NOW;
 *     6. HUMAN DECISION:
 *          GO       → solid: return the refined goal + what the last read validated, and
 *                     the resolved high/medium constraints (runGoalSeed synthesizes goal.md);
 *          REVISE   → ask WHAT SHOULD CHANGE, refine the statement IN-SESSION, next round
 *                     re-grills the refined statement with ALL context carried — never an
 *                     abrupt end;
 *          RESEARCH → (offered only while meaningful unknowns remain) the human names a
 *                     topic, findings fold, next round re-grills;
 *          SKIP     → nothing, ended.
 *
 * When the rounds run out with no GO the driver ends with a FULL summary (resolved · open ·
 * the goal as it reads) and an honest how-to-continue — never a bare 'NOT seeded'.
 *
 * Provider/adapter failures fail CLOSED ({ok:false}) — nothing is fabricated, nothing is
 * seeded. An InteractAbort (the human walked away) is a REJECT with an honest note.
 */

/** The GOAL-MODE directive appended to the grill prompt (via GrillingRequest.instructions).
 *  It is what makes the shared grilling engine GRILL A GOAL rather than a task idea:
 *  summary = the refined one-line goal · questions work the frontier · each question
 *  carries a recommended default · nothing already answered is re-asked. */
export const GOAL_GRILL_MODE = `You are grilling a GOAL, not a finished product idea. The 'idea' is the CURRENT WORKING DRAFT of the goal statement.

Read the draft against EVERYTHING in the context — every prior answer and research finding — before you write anything. The draft is refined as the grill proceeds; build on what is already answered.

## Your 'summary' must be
ONE refined goal statement: the goal as it now reads, tightened in the light of everything answered and researched so far. Preserve the human's words and intent where they are sound; sharpen only what is genuinely weak or ambiguous. It must read as a concrete, checkable outcome — a reader can tell when it is done. One line, no padding, no second paragraph.

## Your 'validation' must be
Judgments about the CURRENT goal draft, grounded in the PROVIDED context labels — never invented facts:
- 'ok' — this part of the goal is now settled / sound as stated;
- 'concern' — needs attention before the goal is truly solid;
- 'blocking' — the goal as stated cannot proceed.
Cite the context labels you lean on; ungrounded, low-confidence guesses belong in questions, not validation.

## Your 'questions' must be
ONLY genuinely NEW unknowns. Do NOT re-ask anything the context already answers — the context lists every prior answer and research finding, so a question that restates one is a defect. The human should never answer the same thing twice.
Work the FRONTIER: ask the biggest remaining unknown first, then the questions that depend on it — never a flat pile.
Every question MUST carry 'options' (the plausible choices) and a 'default' (your recommended answer), so the human can answer in one word. Never an open-ended probe without a recommendation.
A high-impact unknown is always a question — never a guess smuggled into validation.`;

/** ONE LINE — the Goal: section is read as a whole line by store.parseGoalDoc; any
 *  newlines the model put in collapse into spaces so the doc→contract mapping holds. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

/** Answers that do not resolve anything (a skip, a pass, an empty reply). */
const UNRESOLVED_MARKERS = ['unknown', 'skip', 'not sure', 'unsure', 'n/a', 'na', 'dont know', "don't know", ''];
const isUnresolved = (a: string): boolean => UNRESOLVED_MARKERS.includes(a.trim().toLowerCase());
const norm = (s: string): string => s.trim().toLowerCase();

/** A question the human (or research) RESOLVED during the grill. */
export interface GoalResolvedQuestion {
  id: string;
  question: string;
  answer: string;
  impact: 'high' | 'medium' | 'low';
}

export interface GoalGrillOptions {
  /** The goal statement to grill (a rough idea is fine — the grill sharpens it). */
  statement: string;
  /** Pre-existing grounding (e.g. an earlier goal being re-seeded). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
  /** Bounded rounds (flow-control §3 — never unbounded). */
  maxRounds?: number;
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

const DEFAULT_MAX_ROUNDS = 3;

export class GoalGrillSession {
  constructor(
    private readonly abilities: Abilities,
    private readonly options: { model?: string; maxTokens?: number } = {},
  ) {}

  async run(opts: GoalGrillOptions): Promise<GoalGrillResult> {
    if (!opts.statement.trim()) {
      return { ok: false, error: { code: 'invalid-config', blocker: 'goal grill: the goal statement must not be empty' } };
    }
    const engine = new DefaultGrillingEngine(adapterFromAbility(this.abilities.llm, this.options.model), {
      model: this.options.model,
      ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
    });
    const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;

    let goal = opts.statement.trim(); // the working goal statement — refined in-session
    const context: GroundingInput[] = [...(opts.context ?? [])];
    const constraints = opts.constraints;
    const resolved: GoalResolvedQuestion[] = [];
    const researchLog: ResearchFinding[] = [];
    const seen = new Set<string>(); // asked question texts — NEVER ask twice
    const researched = new Set<string>(); // research topics already run — no repeat digging
    const open = new Map<string, GrillQuestion>(); // asked + still-open questions (text → q)
    const usedLabels = new Set(context.map((c) => c.label)); // unique provenance labels
    const label = (base: string): string => {
      let l = base;
      for (let i = 2; usedLabels.has(l); i++) l = `${base}-${i}`;
      usedLabels.add(l);
      return l;
    };
    const isResolved = (text: string): boolean => resolved.some((r) => norm(r.question) === norm(text));

    const foldResearch = (findings: ResearchFinding[]): void => {
      for (const f of findings) {
        researchLog.push(f);
        context.push({ label: label(`research:${f.topic.slice(0, 30)}`), text: f.findings, sourceType: 'web source' });
        researched.add(norm(f.topic));
        const key = norm(f.topic);
        if (open.has(key) && !isResolved(f.topic)) {
          const q = open.get(key)!;
          open.delete(key);
          resolved.push({ id: q.id, question: q.question, answer: f.findings, impact: q.impact });
        }
      }
    };

    const resolve = (q: GrillQuestion, answer: string): void => {
      resolved.push({ id: q.id, question: q.question, answer, impact: q.impact });
      open.delete(norm(q.question));
      context.push({ label: label(`answer:${q.id}`), text: answer, sourceType: 'user input' });
    };

    let round = 1;
    while (round <= maxRounds) {
      // 1 — grill the CURRENT goal against all accumulated context (goal mode)
      const g = await engine.grill({ idea: goal, context, constraints, instructions: GOAL_GRILL_MODE });
      if (!g.ok) return g;
      const artifact = g.artifact;
      const goalLine = oneLine(artifact.summary) || goal; // the refined reading — what the human will approve
      const okClaims = artifact.validation.filter((v) => v.verdict === 'ok').map((v) => v.claim);

      // 2 — the read (round N): refined goal · validation · the NEW questions to ask
      const fresh = artifact.questions.filter((q) => !seen.has(norm(q.question)) && !isResolved(q.question));
      const read = [
        `Goal (refined reading): ${goalLine}`,
        '',
        ...artifact.validation.map((v) => `- [${v.verdict}] ${v.claim}${v.basis.length ? ` (ground: ${v.basis.join(', ')})` : ' (inference)'} [${v.confidence}]`),
        ...(fresh.length ? ['', 'New open questions:'] : []),
        ...fresh.map((q) => `- [${q.impact}] ${q.question}${q.default ? ` (recommended default: ${q.default})` : ''}`),
      ].join('\n');
      await this.abilities.interact.present(`── Goal grill — round ${round} of ${maxRounds} ──\n${read}`);

      // 3 — batch-ask ONLY the new questions (dedupe by text; each shows its default)
      let askedThisRound = 0;
      let findingsThisRound = 0;
      for (const q of fresh) {
        const key = norm(q.question);
        if (seen.has(key)) continue; // dedupe — a defensive guard, never ask twice
        seen.add(key);
        open.set(key, q);
        askedThisRound++;
        let answer: string;
        try {
          answer = await this.abilities.interact.ask(q.default ? `${q.question} (recommended default: ${q.default})` : q.question);
        } catch (e) {
          if (e instanceof InteractAbort) return this.reject('aborted', round);
          return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the human channel failed — ${(e as Error).message}` } };
        }
        if (isUnresolved(answer)) continue; // still open → a research topic below (if high-impact)
        resolve(q, answer);
      }

      // 4 — research: high-impact questions still open become topics; findings fold back.
      // A topic is marked researched BEFORE the call so a fruitless dig is not re-run
      // every round (the human can still trigger a deeper RESEARCH at the decision).
      const openHigh = [...open.values()].filter((q) => q.impact === 'high' && !researched.has(norm(q.question)));
      if (openHigh.length) {
        const topics = openHigh.map((q) => q.question);
        for (const t of topics) researched.add(norm(t));
        try {
          const findings = await this.abilities.interact.research(topics);
          findingsThisRound = findings.length;
          foldResearch(findings);
        } catch (e) {
          if (e instanceof InteractAbort) return this.reject('aborted', round);
          return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the research channel failed — ${(e as Error).message}` } };
        }
      }

      // 5 — ROUND SUMMARY — always shown before the verdict
      await this.abilities.interact.present(
        [
          `── Round ${round} summary ──`,
          `This round: asked ${askedThisRound} new question(s) · folded ${findingsThisRound} research finding(s)`,
          `Resolved so far (${resolved.length}):`,
          ...(resolved.length ? resolved.map((r) => `- [${r.impact}] ${r.question} → ${r.answer}`) : ['- (none)']),
          `Still open (${open.size}):`,
          ...(open.size ? [...open.values()].map((q) => `- [${q.impact}] ${q.question}`) : ['- (none)']),
          `Goal as it reads now: ${goalLine}`,
        ].join('\n'),
      );

      // 6 — human decision. GO seeds; REVISE refines IN-SESSION and continues; RESEARCH
      // (offered only while meaningful unknowns remain) digs one more topic; SKIP ends.
      const blocking = artifact.validation.some((v) => v.verdict === 'blocking');
      const meaningfulOpen = [...open.values()].some((q) => q.impact !== 'low');
      const rec = blocking || meaningfulOpen ? 'REVISE' : 'GO';
      const options: string[] = meaningfulOpen ? ['GO', 'REVISE', 'RESEARCH', 'SKIP'] : ['GO', 'REVISE', 'SKIP'];
      let choice: string;
      try {
        choice = await this.abilities.interact.decide(
          `Round ${round}: is the goal solid enough to GO (seed it now)? (recommendation: ${rec})`,
          options,
        );
      } catch (e) {
        if (e instanceof InteractAbort) return this.reject('aborted', round);
        return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the decision channel failed — ${(e as Error).message}` } };
      }

      if (choice === 'GO') {
        return { ok: true, verdict: 'solid', goal: goalLine, okClaims, resolved, researchLog, rounds: round };
      }
      if (choice === 'SKIP') return this.reject('skipped', round);
      if (choice === 'RESEARCH') {
        // deeper research the human can trigger at the summary (only offered above while
        // meaningful unknowns remain)
        let topic = '';
        try {
          topic = (
            await this.abilities.interact.ask(
              `Which unknown should I dig into next?${open.size ? ` (open: ${[...open.values()].map((q) => q.question).join(' · ')})` : ''}`,
            )
          ).trim();
        } catch (e) {
          if (e instanceof InteractAbort) return this.reject('aborted', round);
          return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the human channel failed — ${(e as Error).message}` } };
        }
        if (topic && !isUnresolved(topic)) {
          researched.add(norm(topic));
          try {
            foldResearch(await this.abilities.interact.research([topic]));
          } catch (e) {
            if (e instanceof InteractAbort) return this.reject('aborted', round);
            return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the research channel failed — ${(e as Error).message}` } };
          }
        }
        goal = goalLine; // the refined reading carries into the next round
        round++;
        continue;
      }
      // REVISE — ask WHAT SHOULD CHANGE and refine the statement IN-SESSION; the next
      // round re-grills the refined statement with ALL context carried (nothing repeats).
      let refined = '';
      try {
        refined = (
          await this.abilities.interact.ask('What should change about the goal? Refine the goal statement in your own words — the next round grills what you say here.')
        ).trim();
      } catch (e) {
        if (e instanceof InteractAbort) return this.reject('aborted', round);
        return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the human channel failed — ${(e as Error).message}` } };
      }
      goal = refined && !isUnresolved(refined) ? refined : goalLine; // a non-answer refine keeps the current reading
      round++;
    }

    // Rounds exhausted with no GO — a FULL summary + an honest how-to-continue, never a
    // bare 'NOT seeded'. Nothing was created.
    await this.abilities.interact.present(
      [
        `── Goal grill — no rounds left ──`,
        `The grill ran its ${maxRounds} round(s) without a GO, so nothing was created. Here is where it landed:`,
        `Resolved (${resolved.length}):`,
        ...(resolved.length ? resolved.map((r) => `- [${r.impact}] ${r.question} → ${r.answer}`) : ['- (none)']),
        `Still open (${open.size}):`,
        ...(open.size ? [...open.values()].map((q) => `- [${q.impact}] ${q.question}`) : ['- (none)']),
        `Goal as it reads now: ${goal}`,
        `To continue: re-run goal! seed with a sharper statement, or raise the round bound to keep grilling this one.`,
      ].join('\n'),
    );
    return {
      ok: true,
      verdict: 'exhausted',
      note: `the goal grill ran out of rounds (${maxRounds}) before a GO — nothing was created; re-run sharper or raise the round bound`,
      rounds: maxRounds,
    };
  }

  private reject(reason: 'skipped' | 'aborted', round: number): GoalGrillResult {
    const note =
      reason === 'aborted'
        ? 'the goal grill was aborted — nothing was created (re-run goal! seed when you are ready)'
        : 'the goal was skipped — nothing was created';
    return { ok: true, verdict: 'reject', reason, note, rounds: round };
  }
}
