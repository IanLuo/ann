import { DefaultGrillingEngine } from './steps/idea-validate/grilling.js';
import { AdapterError } from '../abilities/llm/index.js';
import { GroundingInput, GrillQuestion, renderContext, renderConstraints, unquote } from './steps/shared.js';
import { Abilities, ResearchFinding } from './types.js';
import { adapterFromAbility } from './steps/engine-adapter.js';
import { isUnresolved, makeDedupeLabeler, humanChannel } from './session-shared.js';

/**
 * THE PORTABLE GRILLING ENGINE (the grilling loop extracted from the goal grill, made
 * AREA-NEUTRAL). The BEHAVIOR — grill a subject against accumulating context → batch
 * answers → LLM RESPONSE → DISCUSS → LLM-assessed DECISION, exhaustion-driven end, never
 * re-ask, research only on advice + agreement, anti-runaway ceiling, fail-closed — is
 * portable and lives here. What VARIES per area (what may be grilled, what is out of
 * bounds, what counts as converged) is injected as a {@link GrillProfile}; this module
 * knows nothing about 'goal', 'product', or any specific area.
 *
 * The basic unit (the human's model):
 *   ANSWER → LLM RESPONSE → DISCUSS → (next round)
 * After the human answers a batch of questions the LLM must REASON BACK — a real
 * synthesis turn that validates/interprets the answers, says what is now settled and
 * what changed about the reading, names what is still weak/open, and recommends a next
 * move WITH reasoning. A bare list of answers is never acceptable.
 *
 * Loop (EXHAUSTION-DRIVEN — rounds advance only while the human still digs; the one
 * hard bound left is an anti-runaway ceiling, a safety net never the UX driver).
 * state: subject (the current working draft) · context (every answer + research finding,
 * as grounding labels) · resolved[] · open[] · seen (never re-ask) · the discussion
 * transcript for THIS round.
 *
 *   per round:
 *     1. GRILL the CURRENT subject against all accumulated context (the task grilling
 *        engine + its honesty layer, with the AREA'S directive appended — that directive
 *        carries the AREA'S BOUNDARY) → the read: the refined reading · validation ·
 *        batched NEW questions (frontier, a recommended default per question, never
 *        re-asking what the context answers). Present the read; the human answers the
 *        batch (an unresolved answer stays open).
 *     2. LLM RESPONDS (a synthesis turn over the just-given answers): what is settled,
 *        what changed about the reading, what is still weak/open, a recommended next
 *        move WITH reasoning. Present it.
 *     3. DISCUSS (bounded, maxDiscussTurns): the human types a reply/asks; the LLM
 *        answers in turn from the FULL transcript. It may raise a sub-question, refine
 *        wording, or recommend ONE research topic WITH reasoning — nothing runs until
 *        the human agrees, and when research runs the findings fold into context +
 *        resolved and the LLM responds again to them. The discussion ends when the
 *        human says the point is sorted or the bound is hit.
 *     4. DECISION after each resolved discussion — ask explicitly, and the menu depends
 *        on whether the round is EXHAUSTED. A round is exhausted when its grill raised NO
 *        fresh questions, nothing meaningful (non-low impact) stays open, and no blocking
 *        concern stands in the way — the frontier is empty, so the menu is GO / refine /
 *        skip with NO 'dig more', and GO is the natural call (refine if a blocking
 *        concern). When NOT exhausted the menu is GO / dig more (next round, NEW questions
 *        built on all prior input) / refine (reshape the subject in-session, then next
 *        round) / skip, and the session continues while the human digs. GO is ONLY ever
 *        the human's call.
 *
 * The session ends on a GO (converged), a skip / abort (the human quits), or — only if
 * the loop keeps being asked to continue without converging — the anti-runaway ceiling.
 * That ceiling stop is never the normal end; it closes with a FULL LLM-written synthesis
 * (resolved · still open · the subject as it reads) and an honest continue path — never a
 * bare 'NOT converged'.
 *
 * Provider/adapter failures fail CLOSED ({ok:false}) — nothing is fabricated, nothing is
 * seeded. An InteractAbort (the human walked away) is a REJECT with an honest note.
 */

/** What a grilling SESSION's AREA supplies — ONLY what varies by area. Everything the
 *  engine needs that does NOT vary (bounded discussion, dedupe/never-re-ask, the honesty
 *  layer, provider fail-closed, research only on advice+agreement, GO only the human's
 *  call) lives in the loop, not here. */
export interface GrillProfile {
  /** The area id, e.g. 'goal'. */
  id: string;
  /** Human-facing area title used in headers, e.g. 'Goal grill'. */
  title: string;
  /** The subject noun in prose ('goal'), used as "the goal", "## Current goal draft". */
  noun: string;
  /** The seed command phrase the close-out/abort copy points at ('goal! seed'). */
  seedVerb: string;
  /** The GO action copy in the decision menu ('Seed now') — what a GO lands for THIS
   *  area. The decision OPTION itself stays the area-neutral 'GO'; only the verb the
   *  human reads before it comes from the profile. */
  goAction: string;
  /** ONE LINE on the area + the boundary it grills within (documentation; never read by
   *  the loop). */
  focus: string;

  /** THE GRILL DIRECTIVE — appended to the shared grilling engine (via
   *  GrillingRequest.instructions). It makes the shared engine grill THIS AREA's subject
   *  (what a 'summary' must be, what the frontier is) AND carries the AREA-SCOPED
   *  BOUNDARY — the elevation band the session may ask within and what is explicitly OUT
   *  (deferred to a later stage). */
  grilling: string;
  /** THE REASONING DIRECTIVE — shared by the synthesis (respond) turn, the discussion
   *  turns, and the research follow-up turn. It thinks the answers BACK to the human and
   *  must stay aligned to the same boundary as {@link GrillProfile.grilling}. */
  reasoning: string;
  /** The DECISION-weigh-in guidance — what the LLM weighs when it recommends ONE next
   *  move at the end of a round. Two shapes: an EXHAUSTED round (frontier empty — no
   *  'dig more') vs an open round (GO must be genuinely earned). The area says what
   *  'converged enough to GO' means for ITS subject. */
  decisionWeighIn: { exhausted: string; open: string };
  /** The in-session refine ask — how the human reshapes the subject mid-session. */
  refineAsk: string;

  /** Bounded rounds / in-discussion exchanges per round — the area's defaults (a caller
   *  overrides per-run; flow-control §3 — never unbounded). */
  defaultMaxRounds: number;
  defaultMaxDiscussTurns: number;
}

/** A question the human (or research) RESOLVED during the grill. */
export interface ResolvedQuestion {
  id: string;
  question: string;
  answer: string;
  impact: 'high' | 'medium' | 'low';
}

export interface GrillOptions {
  /** The subject to grill (the working draft; a rough one is fine — the grill sharpens it). */
  subject: string;
  /** Pre-existing grounding (e.g. an earlier subject being re-grilled). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
  /** Bounded rounds (flow-control §3 — never unbounded). */
  maxRounds?: number;
  /** Bounded in-discussion exchanges per round (flow-control §3 — never unbounded). */
  maxDiscussTurns?: number;
}

export type GrillResult =
  | {
      ok: true;
      verdict: 'solid';
      /** The REFINED reading — the subject as it read when the human said GO. */
      statement: string;
      /** The last round's 'ok' validation claims (the read the human approved). */
      okClaims: string[];
      resolved: ResolvedQuestion[];
      researchLog: ResearchFinding[];
      rounds: number;
    }
  | { ok: true; verdict: 'reject'; reason: 'skipped' | 'aborted'; note: string; rounds: number }
  | { ok: true; verdict: 'exhausted'; note: string; rounds: number }
  | { ok: false; error: AdapterError };

/** ONE LINE — the Goal: section is read as a whole line by store.parseGoalDoc; any
 *  newlines the model put in collapse into spaces so the doc→contract mapping holds. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The ROUND READ — what the human sees FIRST each round, rendered SHOW-ME (the smallest
 *  view that makes the point clear): the refined reading on top; ONLY the concern/blocking
 *  validation rows as the 'in the way' list (no ground/confidence noise); the 'ok' rows
 *  collapsed to a '✓ N settled' count; then the numbered answer batch with each recommended
 *  default inline and exactly ONE '← frontier' marker on the question to answer first
 *  (GOAL_GRILL_MODE already orders frontier-first, so that is the first listed question).
 *  When there is nothing in the way and nothing to ask, only the header + the reading stay.
 *  Returns the full present text including the header. */
export const roundRead = (
  title: string,
  noun: string,
  round: number,
  subjectLine: string,
  validation: readonly { verdict: string; claim: string }[],
  questions: readonly GrillQuestion[],
): string => {
  const inTheWay = validation.filter((v) => v.verdict !== 'ok');
  const settled = validation.length - inTheWay.length;
  const lines = [`── ${title} · round ${round} ──`, `${noun.toUpperCase()} (as it reads): ${subjectLine}`];
  if (inTheWay.length > 0) {
    lines.push('', 'In the way (fix these):');
    inTheWay.forEach((v) => lines.push(`  ▸ ${v.claim}`));
  }
  if (settled > 0) lines.push('', `✓ ${settled} settled`);
  if (questions.length > 0) {
    lines.push('', 'Answer (one word — default = my pick):');
    questions.forEach((q, i) => {
      const line = `  ${i + 1}. ${q.question}${q.default ? `  → ${q.default}` : ''}`;
      lines.push(i === 0 ? `${line}  ← frontier` : line);
    });
  }
  return lines.join('\n');
};

const norm = (s: string): string => s.trim().toLowerCase();

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
/** A discussion message the human uses to say the current point is sorted → the DECISION.
 *  Everything else is a real message the LLM must answer. (The unresolved-answer markers
 *  + isUnresolved live in the shared session mechanics — session-shared.ts.) */
const isDiscussionDone = (msg: string): boolean => {
  const t = msg.trim().toLowerCase().replace(/[.?!]+$/, '');
  return t === '' || isUnresolved(t) || DISCUSS_DONE.has(t);
};

/** The DECISION options for a NON-exhausted round (a frontier is still open). */
export const DECISION_OPTIONS = ['GO', 'dig more', 'refine', 'skip'] as const;
/** The DECISION options when the round is EXHAUSTED — the frontier is empty, so there is
 *  nothing left to dig: GO / refine / skip only. */
export const EXHAUSTED_OPTIONS = ['GO', 'refine', 'skip'] as const;

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

/** A DECISION recommendation — strict-JSON, parsed deterministically (same honesty
 *  layer). The recommendation the human decides against is the LLM's weigh-in on the
 *  WHOLE round, never a bare rule. */
interface DecisionReply {
  recommendation: (typeof DECISION_OPTIONS)[number];
  reason: string;
}
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

export class GrillSession {
  constructor(
    private readonly abilities: Abilities,
    private readonly profile: GrillProfile,
    private readonly options: { model?: string; maxTokens?: number } = {},
  ) {}

  async run(opts: GrillOptions): Promise<GrillResult> {
    const { noun, title, seedVerb, reasoning } = this.profile;
    if (!opts.subject.trim()) {
      return { ok: false, error: { code: 'invalid-config', blocker: `${noun} grill: the ${noun} statement must not be empty` } };
    }
    const engine = new DefaultGrillingEngine(adapterFromAbility(this.abilities.llm, this.options.model), {
      model: this.options.model,
      ...(this.options.maxTokens ? { maxTokens: this.options.maxTokens } : {}),
    });
    const maxRounds = opts.maxRounds ?? this.profile.defaultMaxRounds;
    const maxDiscussTurns = opts.maxDiscussTurns ?? this.profile.defaultMaxDiscussTurns;

    let subject = opts.subject.trim(); // the working draft — refined in-session
    const context: GroundingInput[] = [...(opts.context ?? [])];
    const constraints = opts.constraints;
    const resolved: ResolvedQuestion[] = [];
    const researchLog: ResearchFinding[] = [];
    const seen = new Set<string>(); // asked question texts — NEVER ask twice
    const researched = new Set<string>(); // research topics already run — no repeat digging
    const open = new Map<string, GrillQuestion>(); // asked + still-open questions (text → q)
    const label = makeDedupeLabeler(context.map((c) => c.label)); // unique provenance labels
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

    /* --- the human channels — every outcome a VALUE (abort / channel failure / value);
     * the fail-closed wrapper is the shared session mechanics (session-shared.ts) --- */
    const ask = async (q: string): Promise<Gate<string>> => humanChannel(`${noun} grill: the human channel failed`, () => this.abilities.interact.ask(q));
    const decide = async (q: string, options: string[]): Promise<Gate<string>> =>
      humanChannel(`${noun} grill: the decision channel failed`, () => this.abilities.interact.decide(q, options));
    const research = async (topics: string[]): Promise<Gate<ResearchFinding[]>> =>
      humanChannel(`${noun} grill: the research channel failed`, () => this.abilities.interact.research(topics));
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
        return { ok: false, error: { code: 'provider-unavailable', blocker: `${noun} grill: the model failed — ${(e as Error).message}` } };
      }
    };
    /** One discussion LLM turn: a strict-JSON reply, parsed deterministically (a bare
     *  model failure passes through fail-closed; an unparseable reply is a failure too). */
    const discussTurn = async (prompt: string): Promise<{ ok: true; value: DiscussReply } | { ok: false; error: AdapterError }> => {
      const c = await llmText(prompt);
      if (!c.ok) return c;
      const p = parseDiscuss(c.value);
      if (!p.ok) return { ok: false, error: { code: 'bad-response', blocker: `${noun} grill: ${p.blocker}` } };
      return { ok: true, value: p.value };
    };
    /** One DECISION turn: a strict-JSON weigh-in ({recommendation, reason}) — the LLM's
     *  grounded recommendation the human decides against. Same honesty layer. */
    const decisionTurn = async (prompt: string): Promise<{ ok: true; value: DecisionReply } | { ok: false; error: AdapterError }> => {
      const c = await llmText(prompt);
      if (!c.ok) return c;
      const p = parseDecision(c.value);
      if (!p.ok) return { ok: false, error: { code: 'bad-response', blocker: `${noun} grill: ${p.blocker}` } };
      return { ok: true, value: p.value };
    };

    const close = (reason: 'skipped' | 'aborted', round: number): GrillResult => {
      const note =
        reason === 'aborted'
          ? `the ${title.toLowerCase()} was aborted — nothing was created (re-run ${seedVerb} when you are ready)`
          : `the ${noun} was skipped — nothing was created`;
      return { ok: true, verdict: 'reject', reason, note, rounds: round };
    };

    /** Type guard: a human channel outcome that actually carries a value. After
     *  `if (!isValue(g)) return end(g, round)` the remaining code sees `g.value`. */
    const isValue = <T>(g: Gate<T>): g is { kind: 'value'; value: T } => g.kind === 'value';
    /** A human channel outcome that is NOT a value — the session ends here either way
     *  (an abort is a REJECT, a channel failure fails CLOSED). Call only on non-values. */
    type NotValue<T> = Exclude<Gate<T>, { kind: 'value'; value: T }>;
    const end = <T>(g: NotValue<T>, round: number): GrillResult =>
      g.kind === 'abort' ? close('aborted', round) : { ok: false, error: g.error };

    let round = 1;
    while (round <= maxRounds) {
      // 1 — GRILL the CURRENT subject against all accumulated context (this area's mode)
      const g = await engine.grill({ idea: subject, context, constraints, instructions: this.profile.grilling });
      if (!g.ok) return g;
      const artifact = g.artifact;
      const subjectLine = oneLine(artifact.summary) || subject; // the refined reading the human will approve
      const okClaims = artifact.validation.filter((v) => v.verdict === 'ok').map((v) => v.claim);
      const blocking = artifact.validation.some((v) => v.verdict === 'blocking');

      // the read (round N): refined reading on top · only the concern/blocking rows · the
      // 'ok' rows collapsed to a count · the NEW questions to ask (numbered, default inline,
      // the frontier marked). Present it, then batch-ask ONLY the new questions below.
      const fresh = artifact.questions.filter((q) => !seen.has(norm(q.question)) && !isResolved(q.question));
      await this.abilities.interact.present(roundRead(this.profile.title, this.profile.noun, round, subjectLine, artifact.validation, fresh));

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
            `You are mid-session on a ${title}. The human just answered a batch of questions.`,
            '',
            `## Current ${noun} draft\n${subject}`,
            `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
            `## Contract constraints\n${renderConstraints(constraints)}`,
            `## The questions asked THIS round and the human's answers\n${answersSection}`,
            '',
            reasoning,
            '',
            '## Output — a PROSE reply to the human (no JSON), CONCLUSION-FIRST and SHORT',
            `First line, as 'My call: <GO | dig more | refine> — <one-line why>': your recommended next move and the reason, in ONE line.`,
            'Then at most a tight read-back, one short line each:',
            "- 'Settled: …' — what the answers now settle about the draft (omit if nothing settled);",
            "- 'Still weak: …' — what genuinely remains open or weak (omit if nothing);",
            `Keep the WHOLE reply to a few short lines — never a paragraph dump, never a bare list of the answers. Reason only against the ${noun} draft and the grounded context.`,
          ].join('\n'),
        );
        if (!synth.ok) return synth; // model failure → fail CLOSED, nothing fabricated
        await this.abilities.interact.present(`── Round ${round} — your answers, read back ──\n${synth.value}`);
        history.push({ who: 'grill', text: synth.value });

        // 3 — DISCUSS: bounded human↔LLM exchanges until the human says the point is sorted.
        const discussPrompt = (): string =>
          [
            `You are mid-DISCUSSION on a ${title.toLowerCase()}. Answer the human's latest message.`,
            '',
            `## Current ${noun} draft\n${subject}`,
            `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
            `## Contract constraints\n${renderConstraints(constraints)}`,
            `## Discussion transcript (most recent LAST)\n${renderHistory(history)}`,
            '',
            reasoning,
            '',
            '## Style — CONCLUSION-FIRST and SHORT',
            'The "reply" is 1-3 short sentences max: answer the human\'s point, then if relevant ONE research ask. No transcript restatement, no build-up.',
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
                  `You are mid-DISCUSSION on a ${title.toLowerCase()}. The research the human approved just came back — respond to the findings.`,
                  '',
                  `## Current ${noun} draft\n${subject}`,
                  `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
                  `## Contract constraints\n${renderConstraints(constraints)}`,
                  `## Discussion transcript (most recent LAST)\n${renderHistory(history)}`,
                  '',
                  reasoning,
                  '',
                  '## Style — CONCLUSION-FIRST and SHORT',
                  'The "reply" is 1-3 short sentences max: what the findings settle, what they leave open, your read. No restatement of the transcript.',
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
      // weighs the subject draft + every answer + the discussion and states WHY before the
      // menu. A clean read (nothing to reason about) recommends GO directly.
      const openNow = [...open.values()];
      // EXHAUSTED = this round's grill raised NO fresh questions AND nothing meaningful
      // (non-low impact) stays open AND no blocking concern blocks GO. The frontier is
      // empty — nothing is left to dig — so the menu drops 'dig more' and GO is the
      // natural call (refine if a blocking concern). A round that raised a fresh question
      // is never exhausted, even if the human answered every one of them.
      const exhausted = fresh.length === 0 && !openNow.some((q) => q.impact !== 'low') && !blocking;
      const decisionOptions: string[] = exhausted ? [...EXHAUSTED_OPTIONS] : [...DECISION_OPTIONS];
      const baseline = (): (typeof DECISION_OPTIONS)[number] =>
        blocking ? 'refine' : exhausted ? 'GO' : openNow.some((q) => q.impact !== 'low') ? 'dig more' : 'GO';
      let recommendation: (typeof DECISION_OPTIONS)[number] = baseline();
      if (history.length > 0) {
        // the decision weigh-in may recommend only within THIS round's menu — an exhausted
        // round has empty branches and must not be told to 'dig more'.
        const allowed = decisionOptions.map((o) => `"${o}"`).join(' | ');
        const a = await decisionTurn([
          `You are the DECISION advisor at the end of a ${noun}-grill round. Weigh the WHOLE round — the ${noun} draft, everything the human answered, and the discussion — and recommend ONE next move.`,
          '',
          `## Current ${noun} draft\n${subject}`,
          `## Grounded context (cite ONLY these labels; never invent)\n${renderContext(context)}`,
          `## Contract constraints\n${renderConstraints(constraints)}`,
          `## This round's reasoning/discussion transcript\n${renderHistory(history)}`,
          '',
          exhausted ? this.profile.decisionWeighIn.exhausted : this.profile.decisionWeighIn.open,
          '## Style — CONCLUSION-FIRST and SHORT',
          'The "reason" is one short GROUNDED sentence naming the concrete why (a second sentence only if genuinely needed — never a paragraph).',
          '## Output — strict JSON, no commentary, no fence',
          `{ "recommendation": ${allowed}, "reason": "one short grounded sentence" }`,
        ].join('\n'));
        if (!a.ok) return a;
        // the model's weigh-in stands only inside this round's menu; an overreach (e.g.
        // 'dig more' on an exhausted round) falls back to the baseline call.
        recommendation = decisionOptions.includes(a.value.recommendation) ? a.value.recommendation : baseline();
        await this.abilities.interact.present(`── Round ${round} — the grill's recommendation ──\nRecommendation: ${recommendation}\n\n${a.value.reason}`);
      }
      const go = `${this.profile.goAction} (GO)`; // the GO verb is the AREA's — the option stays neutral
      const actions = exhausted
        ? `${go} · refine (reshape the ${noun} in-session) · skip`
        : `${go} · dig more (next round, new questions) · refine (reshape the ${noun} in-session) · skip`;
      const c = await decide(
        `Round ${round} decision — resolved so far: ${resolved.length} · still open: ${openNow.length}. ${actions}. (recommendation: ${recommendation})`,
        decisionOptions,
      );
      if (!isValue(c)) return end(c, round);

      const choice = c.value.trim().toLowerCase();
      if (choice === 'go') {
        return { ok: true, verdict: 'solid', statement: subjectLine, okClaims, resolved, researchLog, rounds: round };
      }
      if (choice === 'skip') return close('skipped', round);
      if (choice === 'refine') {
        // refine — reshape the subject IN-SESSION; the next round grills the human's words
        const r = await ask(this.profile.refineAsk);
        if (!isValue(r)) return end(r, round);
        subject = r.value.trim() && !isUnresolved(r.value) ? r.value.trim() : subjectLine;
      } else {
        // dig more — keep the refined reading and advance. On an EXHAUSTED round this is
        // only reachable defensively (the human typed it against a menu that excluded it):
        // the next grill of an empty frontier is again exhausted, so it converges; the
        // anti-runaway ceiling catches any loop that never does.
        subject = subjectLine;
      }
      round++;
    }

    // The ANTI-RUNAWAY backstop was hit: the loop kept being asked to continue across round
    // after round without converging on a GO. This is the safety net, never the normal end —
    // a healthy grill stops at exhaustion with a converged decision. Close with a FULL
    // LLM-written synthesis (resolved · still open · the subject as it reads) + an honest
    // continue path — never a bare 'NOT converged'. If the close-out model call itself fails,
    // a deterministic fallback still says where it landed — nothing is lost.
    const resolvedBlock = (): string =>
      [
        `Resolved (${resolved.length}):`,
        ...(resolved.length ? resolved.map((r) => `- [${r.impact}] ${r.question} → ${r.answer}`) : ['- (none)']),
        `Still open (${open.size}):`,
        ...(open.size ? [...open.values()].map((q) => `- [${q.impact}] ${q.question}`) : ['- (none)']),
        `${cap(noun)} as it reads now: ${subject}`,
      ].join('\n');
    const closeText = await llmText(
      [
        `You are closing out a ${title} that hit its anti-runaway round ceiling without a GO — nothing was seeded.`,
        '',
        `## Current ${noun} draft\n${subject}`,
        `## Grounded context\n${renderContext(context)}`,
        `## Contract constraints\n${renderConstraints(constraints)}`,
        '',
        resolvedBlock(),
        '',
        `Write the human's close-out as prose (no JSON): what is now RESOLVED · what is STILL OPEN · the ${noun} AS IT READS now · an honest recommended way to continue (re-run ${seedVerb} sharper, or keep refining this one). Ground claims in the context labels; never invent.`,
      ].join('\n'),
    );
    const body = closeText.ok ? closeText.value : resolvedBlock(); // close-out hiccup → deterministic fallback
    await this.abilities.interact.present(
      [
        `── ${title} — anti-runaway stop ──`,
        `The ${title.toLowerCase()} was asked to keep going across ${maxRounds} round(s) without converging on a GO, so the round ceiling stopped it. This is the anti-runaway safety net — it is NOT the normal end. Nothing was created. Here is where it landed:`,
        body,
        `To continue: re-run ${seedVerb} with a sharper statement — or raise the round ceiling if the grill genuinely has more to cover.`,
      ].join('\n'),
    );
    return {
      ok: true,
      verdict: 'exhausted',
      note: `the ${title.toLowerCase()} hit its anti-runaway round ceiling (${maxRounds}) without a GO — nothing was created; re-run sharper or raise the ceiling`,
      rounds: maxRounds,
    };
  }
}
