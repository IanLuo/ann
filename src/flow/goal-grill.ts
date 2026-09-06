import { DefaultGrillingEngine } from './steps/idea-validate/grilling.js';
import { AdapterError } from '../abilities/llm/index.js';
import { GroundingInput, GrillQuestion, renderContext, renderConstraints, unquote } from './steps/shared.js';
import { Abilities, InteractAbort, ResearchFinding } from './types.js';
import { adapterFromAbility } from './steps/engine-adapter.js';

/**
 * L2 · THE GOAL GRILL (goal! seed) v4 — a goal-SCOPE grill that grinds a ROUGH goal into
 * a SHARP one the engine can seed. Deliberately NOT the task idea-validate session: that
 * loop treats a human 'revise' as TERMINAL (bounded out → recommend revise → done), which
 * is right for a task idea but wrong for grilling a GOAL — a goal that needs refining
 * must be refined IN-SESSION and re-grilled, never abandoned mid-thought.
 *
 * The basic unit (v4, the human's model):
 *   ANSWER → LLM RESPONSE → DISCUSS → (next round)
 * After the human answers a batch of questions the LLM must REASON BACK — a real
 * synthesis turn that validates/interprets the answers, says what is now settled and
 * what changed about the reading, names what is still weak/open, and recommends a next
 * move WITH reasoning. A bare list of answers is never acceptable.
 *
 * Loop (bounded — flow-control §3, the same never-unbounded rule). state:
 *   goal (the current working draft) · context (every answer + research finding, as
 *   grounding labels) · resolved[] · open[] · seen (never re-ask) · the discussion
 *   transcript for THIS round.
 *
 *   per round:
 *     1. GRILL the CURRENT goal against all accumulated context (the task grilling
 *        engine + its honesty layer, with a GOAL-MODE instruction appended) → the read:
 *        refined one-line goal · validation · batched NEW questions (frontier, a
 *        recommended default per question, never re-asking what the context answers).
 *        Present the read; the human answers the batch (an unresolved answer stays open).
 *     2. LLM RESPONDS (a synthesis turn over the just-given answers): what is settled,
 *        what changed about the reading, what is still weak/open, a recommended next
 *        move WITH reasoning. Present it.
 *     3. DISCUSS (bounded, maxDiscussTurns): the human types a reply/asks; the LLM
 *        answers in turn from the FULL transcript. It may raise a sub-question, refine
 *        wording, or recommend ONE research topic WITH reasoning — nothing runs until
 *        the human agrees, and when research runs the findings fold into context +
 *        resolved and the LLM responds again to them. The discussion ends when the
 *        human says the point is sorted or the bound is hit.
 *     4. DECISION after each resolved discussion — ask explicitly: GO (seed now) /
 *        dig more (next round, NEW questions built on all prior input) / refine
 *        (reshape the goal in-session, then next round) / skip. GO is ONLY ever the
 *        human's call here.
 *
 * When the rounds run out with no GO the driver ends with a FULL LLM-written synthesis
 * (resolved · still open · the goal as it reads) and an honest continue path — never a
 * bare 'NOT seeded'.
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

/** The REASONING directive shared by the respond (synthesis) and discuss LLM turns — the
 *  half of the grill that thinks the answers BACK to the human instead of asking more.
 *  The grill (GOAL_GRILL_MODE) decides WHAT is unknown; this decides what the answers
 *  MEAN and what the human should do next. Kept as its own exported constant so tests
 *  can prove the reasoning turns actually used it. */
export const GOAL_DISCUSS_MODE = `You are the REASONING half of a goal grill, not another question-asker. New input just arrived and you must think it back to the human.

Read the CURRENT GOAL DRAFT against EVERYTHING in the context — every prior answer and research finding — and the full discussion transcript, before you write anything.

## What your reply must do
- INTERPRET the new input against the goal draft: what is now SETTLED, what CHANGED about how the goal reads, and what is still genuinely WEAK or OPEN. Never a bare restatement of the answers — a bare list is the failure mode this grill was built to avoid.
- RECOMMEND a next move and WHY: seed now (GO), keep grilling new questions (dig more), or reshape the goal in-session (refine).
- If a genuine unknown can ONLY be answered by outside research, recommend ONE research topic with the reason. Nothing runs until the human agrees.

## Hard rules
- Ground every claim in the PROVIDED context labels; never invent facts, numbers, users, or sources.
- Do NOT re-ask anything the context already answers.
- Keep it concrete and honest: name the actual weakness, not a generic 'more clarity needed'.`;

/** ONE LINE — the Goal: section is read as a whole line by store.parseGoalDoc; any
 *  newlines the model put in collapse into spaces so the doc→contract mapping holds. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

/** Answers that do not resolve anything (a skip, a pass, an empty reply). */
const UNRESOLVED_MARKERS = ['unknown', 'skip', 'not sure', 'unsure', 'n/a', 'na', 'dont know', "don't know", ''];
const isUnresolved = (a: string): boolean => UNRESOLVED_MARKERS.includes(a.trim().toLowerCase());
const norm = (s: string): string => s.trim().toLowerCase();

/** A discussion message the human uses to say the current point is sorted → the DECISION.
 *  Everything else is a real message the LLM must answer. */
const DISCUSS_DONE = new Set([
  'sorted',
  'move on',
  'done',
  'that resolves it',
  'resolved',
  'none',
  'nothing',
  'nothing else',
  'no more',
  'wrap up',
  'finished',
  'ok',
  'good',
  'sounds good',
  'thats it',
  "that's it",
  'proceed',
  'go',
]);
const isDiscussionDone = (msg: string): boolean => {
  const t = msg.trim().toLowerCase().replace(/[.?!]+$/, '');
  return t === '' || isUnresolved(t) || DISCUSS_DONE.has(t);
};

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_DISCUSS_TURNS = 6;
const DECISION_OPTIONS = ['GO', 'dig more', 'refine', 'skip'] as const;

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

/** The human channels — every outcome a VALUE (the human walked away / the channel
 *  failed / a value came back). `kind` is the shared discriminant on every arm. */
type Gate<T> = { kind: 'abort' } | { kind: 'error'; error: AdapterError } | { kind: 'value'; value: T };

/** A bare model call (grill aside) — a value or a fail-closed error; the model never
 *  raises InteractAbort, so there is no abort arm. */
type ModelCall = { ok: true; value: string } | { ok: false; error: AdapterError };

/** An LLM reasoning turn's parsed output — the prose `reply` (shown to the human) and an
 *  OPTIONAL single research recommendation that still needs the human's agreement. */
interface DiscussReply {
  reply: string;
  research?: { topic: string; reason?: string };
}

/** An in-discussion LLM reply — strict-JSON, parsed deterministically. */
type ReasoningTurn = { ok: true; value: DiscussReply } | { ok: false; error: AdapterError };

/** A DECISION recommendation — strict-JSON, parsed deterministically (same honesty
 *  layer). The recommendation the human decides against is the LLM's weigh-in on the
 *  WHOLE round, never a bare rule. */
type DecisionReply = { recommendation: (typeof DECISION_OPTIONS)[number]; reason: string };
const parseDecision = (text: string): { ok: true; value: DecisionReply } | { ok: false; blocker: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unquote(text));
  } catch {
    return { ok: false, blocker: 'the decision turn returned unparseable output — treated as failure, never fabricated' };
  }
  const o = parsed as Record<string, unknown> | null;
  if (!o || !(DECISION_OPTIONS as readonly string[]).includes(o.recommendation as string) || typeof o.reason !== 'string' || o.reason.trim().length === 0) {
    return { ok: false, blocker: 'the decision turn output violated the shape contract ({recommendation, reason}) — treated as failure' };
  }
  return { ok: true, value: { recommendation: o.recommendation as DecisionReply['recommendation'], reason: o.reason.trim() } };
};

const renderHistory = (h: { who: string; text: string }[]): string => h.map((e) => `${e.who}: ${e.text}`).join('\n') || '(none yet)';

/** Deterministic parse of the discuss turn's strict-JSON reply (the honesty layer —
 *  unparseable/malformed output is a failure, never fabricated). */
const parseDiscuss = (text: string): { ok: true; value: DiscussReply } | { ok: false; blocker: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unquote(text));
  } catch {
    return { ok: false, blocker: 'the discussion turn returned unparseable output — treated as failure, never fabricated' };
  }
  const o = parsed as Record<string, unknown> | null;
  if (!o || typeof o.reply !== 'string' || o.reply.trim().length === 0) {
    return { ok: false, blocker: 'the discussion turn output violated the shape contract (a non-empty "reply") — treated as failure' };
  }
  let research: DiscussReply['research'];
  if (o.research != null) {
    const r = o.research as Record<string, unknown> | null;
    if (!r || typeof r.topic !== 'string' || r.topic.trim().length === 0) {
      return { ok: false, blocker: 'the discussion turn recommended research without a topic — treated as failure' };
    }
    research = { topic: r.topic.trim(), ...(typeof r.reason === 'string' && r.reason.trim() ? { reason: r.reason.trim() } : {}) };
  }
  return { ok: true, value: { reply: o.reply.trim(), ...(research ? { research } : {}) } };
};

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
    const maxDiscussTurns = opts.maxDiscussTurns ?? DEFAULT_DISCUSS_TURNS;

    let goal = opts.statement.trim(); // the working goal draft — refined in-session
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
        const q = open.get(key); // a finding that answers a still-open question RESOLVES it
        if (q && !isResolved(q.question)) {
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

    /* --- the human channels — every outcome a VALUE (abort / channel failure / value) --- */
    const gateError = (what: string, e: unknown): Gate<never> =>
      e instanceof InteractAbort
        ? { kind: 'abort' }
        : { kind: 'error', error: { code: 'provider-unavailable', blocker: `goal grill: ${what} failed — ${(e as Error).message}` } };

    const ask = async (q: string): Promise<Gate<string>> => {
      try {
        return { kind: 'value', value: await this.abilities.interact.ask(q) };
      } catch (e) {
        return gateError('the human channel', e);
      }
    };
    const decide = async (q: string, options: string[]): Promise<Gate<string>> => {
      try {
        return { kind: 'value', value: await this.abilities.interact.decide(q, options) };
      } catch (e) {
        return gateError('the decision channel', e);
      }
    };
    const research = async (topics: string[]): Promise<Gate<ResearchFinding[]>> => {
      try {
        return { kind: 'value', value: await this.abilities.interact.research(topics) };
      } catch (e) {
        return gateError('the research channel', e);
      }
    };
    /** A bare LLM completion (prose or strict JSON) — provider failures fail CLOSED. */
    const llmText = async (prompt: string): Promise<ModelCall> => {
      try {
        const text = await this.abilities.llm.complete({
          prompt,
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
        });
        return { ok: true, value: text };
      } catch (e) {
        return { ok: false, error: { code: 'provider-unavailable', blocker: `goal grill: the model failed — ${(e as Error).message}` } };
      }
    };
    /** One discussion LLM turn: a strict-JSON reply, parsed deterministically (a bare
     *  model failure passes through fail-closed; an unparseable reply is a failure too). */
    const discussTurn = async (prompt: string): Promise<ReasoningTurn> => {
      const c = await llmText(prompt);
      if (!c.ok) return c;
      const p = parseDiscuss(c.value);
      if (!p.ok) return { ok: false, error: { code: 'bad-response', blocker: `goal grill: ${p.blocker}` } };
      return { ok: true, value: p.value };
    };
    /** One DECISION turn: a strict-JSON weigh-in ({recommendation, reason}) — the LLM's
     *  grounded recommendation the human decides against. Same honesty layer. */
    const decisionTurn = async (prompt: string): Promise<{ ok: true; value: DecisionReply } | { ok: false; error: AdapterError }> => {
      const c = await llmText(prompt);
      if (!c.ok) return c;
      const p = parseDecision(c.value);
      if (!p.ok) return { ok: false, error: { code: 'bad-response', blocker: `goal grill: ${p.blocker}` } };
      return { ok: true, value: p.value };
    };

    const close = (reason: 'skipped' | 'aborted', round: number): GoalGrillResult => {
      const note =
        reason === 'aborted'
          ? 'the goal grill was aborted — nothing was created (re-run goal! seed when you are ready)'
          : 'the goal was skipped — nothing was created';
      return { ok: true, verdict: 'reject', reason, note, rounds: round };
    };

    /** Type guard: a human channel outcome that actually carries a value. After
     *  `if (!isValue(g)) return end(g, round)` the remaining code sees `g.value`. */
    const isValue = <T>(g: Gate<T>): g is { kind: 'value'; value: T } => g.kind === 'value';
    /** A human channel outcome that is NOT a value — the session ends here either way
     *  (an abort is a REJECT, a channel failure fails CLOSED). Call only on non-values. */
    type NotValue<T> = Exclude<Gate<T>, { kind: 'value'; value: T }>;
    const end = <T>(g: NotValue<T>, round: number): GoalGrillResult =>
      g.kind === 'abort' ? close('aborted', round) : { ok: false, error: g.error };

    let round = 1;
    while (round <= maxRounds) {
      // 1 — GRILL the CURRENT goal draft against all accumulated context (goal mode)
      const g = await engine.grill({ idea: goal, context, constraints, instructions: GOAL_GRILL_MODE });
      if (!g.ok) return g;
      const artifact = g.artifact;
      const goalLine = oneLine(artifact.summary) || goal; // the refined reading the human will approve
      const okClaims = artifact.validation.filter((v) => v.verdict === 'ok').map((v) => v.claim);
      const blocking = artifact.validation.some((v) => v.verdict === 'blocking');

      // the read (round N): refined goal · validation · the NEW questions to ask
      const fresh = artifact.questions.filter((q) => !seen.has(norm(q.question)) && !isResolved(q.question));
      const read = [
        `Goal (refined reading): ${goalLine}`,
        '',
        ...artifact.validation.map((v) => `- [${v.verdict}] ${v.claim}${v.basis.length ? ` (ground: ${v.basis.join(', ')})` : ' (inference)'} [${v.confidence}]`),
        ...(fresh.length ? ['', 'New open questions:'] : []),
        ...fresh.map((q) => `- [${q.impact}] ${q.question}${q.default ? ` (recommended default: ${q.default})` : ''}`),
      ].join('\n');
      await this.abilities.interact.present(`── Goal grill — round ${round} of ${maxRounds} ──\n${read}`);

      // batch-ask ONLY the new questions — the answers fold into context + resolved
      let askedThisRound = 0;
      const askedThisRoundAnswers: { question: string; answer: string }[] = [];
      for (const q of fresh) {
        const key = norm(q.question);
        if (seen.has(key)) continue; // dedupe — a defensive guard, never ask twice
        seen.add(key);
        open.set(key, q);
        askedThisRound++;
        const a = await ask(q.default ? `${q.question} (recommended default: ${q.default})` : q.question);
        if (!isValue(a)) return end(a, round);
        askedThisRoundAnswers.push({ question: q.question, answer: isUnresolved(a.value) ? '(skipped — still open)' : a.value });
        if (!isUnresolved(a.value)) resolve(q, a.value);
      }

      // 2 — LLM RESPONDS (synthesis over the answers) + 3 — DISCUSS (bounded). When this
      // round asked nothing AND nothing meaningful is open AND the read has no concern, a
      // reasoning turn has nothing to reason about — go straight to the decision.
      const needsReasoning = askedThisRound > 0 || [...open.values()].some((q) => q.impact !== 'low') || artifact.validation.some((v) => v.verdict !== 'ok');
      const history: { who: string; text: string }[] = []; // THIS round's discussion transcript

      if (needsReasoning) {
        // 2 — the synthesis turn: a PROSE reply (no JSON) reading the answers back.
        const answersSection =
          askedThisRoundAnswers.length > 0
            ? askedThisRoundAnswers.map((a) => `- ${a.question} → ${a.answer}`).join('\n')
            : '(no new questions were asked this round)';
        const synth = await llmText(
          [
            'You are mid-session on a GOAL grill. The human just answered a batch of questions.',
            '',
            `## Current goal draft\n${goal}`,
            `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
            `## Contract constraints\n${renderConstraints(constraints)}`,
            `## The questions asked THIS round and the human's answers\n${answersSection}`,
            '',
            GOAL_DISCUSS_MODE,
            '',
            '## Output\nA PROSE reply to the human (no JSON): reason about the answers against the goal draft — what is now SETTLED, what CHANGED about how the goal reads, what is still WEAK or OPEN — then state your recommended next move (GO / dig more / refine) and WHY.',
          ].join('\n'),
        );
        if (!synth.ok) return synth; // model failure → fail CLOSED, nothing fabricated
        await this.abilities.interact.present(`── Round ${round} — your answers, read back ──\n${synth.value}`);
        history.push({ who: 'grill', text: synth.value });

        // 3 — DISCUSS: bounded human↔LLM exchanges until the human says the point is sorted.
        const discussPrompt = (): string =>
          [
            'You are mid-DISCUSSION on a goal grill. Answer the human\'s latest message.',
            '',
            `## Current goal draft\n${goal}`,
            `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
            `## Contract constraints\n${renderConstraints(constraints)}`,
            `## Discussion transcript (most recent LAST)\n${renderHistory(history)}`,
            '',
            GOAL_DISCUSS_MODE,
            '',
            '## Output — strict JSON, no commentary, no fence',
            '{ "reply": "your message to the human", "research": null | { "topic": "...", "reason": "why this ONE topic, now" } }',
          ].join('\n');

        let discussTurns = 0;
        while (discussTurns < maxDiscussTurns) {
          const m = await ask(`Anything to push back on, add, or clarify? Reply, or type 'sorted' to move on to the decision.`);
          if (!isValue(m)) return end(m, round);
          if (isDiscussionDone(m.value)) break; // the human says the current point is sorted
          history.push({ who: 'human', text: m.value.trim() });

          const turn = await discussTurn(discussPrompt());
          if (!turn.ok) return turn;
          await this.abilities.interact.present(`[grill] ${turn.value.reply}`);
          history.push({ who: 'grill', text: turn.value.reply });
          discussTurns++;

          // research runs ONLY when the LLM advised it (with reasoning) AND the human
          // agrees — never auto-run. Findings fold into context + resolved, and the LLM
          // responds again to them (another reasoning turn over the fuller history).
          const advised = turn.value.research;
          if (advised && !researched.has(norm(advised.topic))) {
            const agree = await decide(
              `The grill recommends researching "${advised.topic}"${advised.reason ? ` — ${advised.reason}` : ''}. Run it now?`,
              ['yes', 'no'],
            );
            if (!isValue(agree)) return end(agree, round);
            if (agree.value.trim().toLowerCase() === 'yes') {
              const findings = await research([advised.topic]);
              if (!isValue(findings)) return end(findings, round);
              foldResearch(findings.value);
              const folded =
                findings.value.length > 0
                  ? findings.value.map((f) => f.findings).join(' ')
                  : '(no findings returned — the topic is a dead end)';
              history.push({ who: 'research', text: `Research on "${advised.topic}": ${folded}` });
              const followUp = await discussTurn(
                [
                  'You are mid-DISCUSSION on a goal grill. The research the human approved just came back — respond to the findings.',
                  '',
                  `## Current goal draft\n${goal}`,
                  `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
                  `## Contract constraints\n${renderConstraints(constraints)}`,
                  `## Discussion transcript (most recent LAST)\n${renderHistory(history)}`,
                  '',
                  GOAL_DISCUSS_MODE,
                  '',
                  '## Output — strict JSON, no commentary, no fence',
                  '{ "reply": "your message to the human — what the findings settle, what they leave open", "research": null }',
                ].join('\n'),
              );
              if (!followUp.ok) return followUp;
              await this.abilities.interact.present(`[grill] ${followUp.value.reply}`);
              history.push({ who: 'grill', text: followUp.value.reply });
            }
          }
        }
      }

      // 4 — DECISION (after each resolved discussion — GO is ONLY the human's call here).
      // The recommendation is the LLM's, grounded in the whole round — never a bare rule:
      // when this round produced reasoning (answers/discussion), one final assessment turn
      // weighs the goal draft + every answer + the discussion and states WHY before the
      // menu. A clean read (nothing to reason about) recommends GO directly.
      const openNow = [...open.values()];
      let recommendation: (typeof DECISION_OPTIONS)[number] = blocking ? 'refine' : openNow.some((q) => q.impact !== 'low') ? 'dig more' : 'GO';
      if (history.length > 0) {
        const a = await decisionTurn([
          'You are the DECISION advisor at the end of a goal-grill round. Weigh the WHOLE round — the goal draft, everything the human answered, and the discussion — and recommend ONE next move.',
          '',
          `## Current goal draft\n${goal}`,
          `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
          `## Contract constraints\n${renderConstraints(constraints)}`,
          `## This round's reasoning/discussion transcript\n${renderHistory(history)}`,
          '',
          'Be honest, never session-shortening: GO only if the goal is genuinely seedable now (a reader can tell when it is done and no meaningful unknown blocks a checkable criterion); dig more if a meaningful unknown still blocks that; refine if the DRAFT itself is weak. Ground the reason in the transcript/context.',
          '## Output — strict JSON, no commentary, no fence',
          '{ "recommendation": "GO" | "dig more" | "refine" | "skip", "reason": "one short paragraph, grounded" }',
        ].join('\n'));
        if (!a.ok) return a;
        recommendation = a.value.recommendation;
        await this.abilities.interact.present(`── Round ${round} — the grill's recommendation ──\n${a.value.reason}\n\nMy recommendation: ${a.value.recommendation}`);
      }
      const c = await decide(
        `Round ${round} decision — resolved so far: ${resolved.length} · still open: ${openNow.length}. Seed now (GO) · dig more (next round, new questions) · refine (reshape the goal in-session) · skip. (recommendation: ${recommendation})`,
        [...DECISION_OPTIONS],
      );
      if (!isValue(c)) return end(c, round);

      const choice = c.value.trim().toLowerCase();
      if (choice === 'go') {
        return { ok: true, verdict: 'solid', goal: goalLine, okClaims, resolved, researchLog, rounds: round };
      }
      if (choice === 'skip') return close('skipped', round);
      if (choice === 'refine') {
        // refine — reshape the goal IN-SESSION; the next round grills the human's words
        const r = await ask('What should change about the goal? Refine the goal statement in your own words — the next round grills what you say here.');
        if (!isValue(r)) return end(r, round);
        goal = r.value.trim() && !isUnresolved(r.value) ? r.value.trim() : goalLine;
      } else {
        goal = goalLine; // dig more — keep the refined reading; the next round asks NEW questions
      }
      round++;
    }

    // Rounds exhausted with no GO — a FULL LLM-written synthesis (resolved · still open ·
    // the goal as it reads) + an honest continue path, never a bare 'NOT seeded'. Nothing
    // was created. If the close-out model call itself fails, a deterministic fallback
    // still says where it landed — nothing is lost.
    const resolvedBlock = (): string =>
      [
        `Resolved (${resolved.length}):`,
        ...(resolved.length ? resolved.map((r) => `- [${r.impact}] ${r.question} → ${r.answer}`) : ['- (none)']),
        `Still open (${open.size}):`,
        ...(open.size ? [...open.values()].map((q) => `- [${q.impact}] ${q.question}`) : ['- (none)']),
        `Goal as it reads now: ${goal}`,
      ].join('\n');
    const closeText = await llmText(
      [
        'You are closing out a GOAL grill that ran its rounds without a GO — nothing was seeded.',
        '',
        `## Current goal draft\n${goal}`,
        `## Grounded context\n${renderContext(context)}`,
        `## Contract constraints\n${renderConstraints(constraints)}`,
        '',
        resolvedBlock(),
        '',
        'Write the human\'s close-out as prose (no JSON): what is now RESOLVED · what is STILL OPEN · the goal AS IT READS now · an honest recommended way to continue (re-run goal! seed sharper, or keep refining this one). Ground claims in the context labels; never invent.',
      ].join('\n'),
    );
    const body = closeText.ok ? closeText.value : resolvedBlock(); // close-out hiccup → deterministic fallback
    await this.abilities.interact.present(
      [
        `── Goal grill — no rounds left ──`,
        `The grill ran its ${maxRounds} round(s) without a GO, so nothing was created. Here is where it landed:`,
        body,
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
}
