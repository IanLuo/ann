import { Commands, CommandError, GOAL_SEED_GUARD } from '../commands/index.js';
import { Abilities, InteractAbort } from './types.js';
import { GroundingInput } from './steps/shared.js';
import { IdeaValidationDoc, IdeaVerdict, IdeaValidationSession } from './steps/idea-validate/session.js';

/**
 * L2 · THE `goal! seed` MATERIALIZE PATH (the v6 composite the plan deferred: seedGoal
 * exists, but nothing drives the grill → doc → seed that goal.md is authored for).
 * This runs the idea-validation session at SESSION scope on the user's goal — the SAME
 * grill → batch-ask → research → converge loop as the flow-1 validate step — then, on a
 * HUMAN `solid`, synthesizes goal.md deterministically and seeds it through L1
 * (goalSeed = seedGoal + the goal.md artifact-lock on the goal root).
 *
 * NOTHING IS CREATED unless the human says GO: revise → the grill recommends refining
 * (re-run with a sharper statement) · reject → the idea does not get a session ·
 * abort → the human walked away. The empty-journey guard runs BEFORE any provider call,
 * so the refusal is dogfoodable on a non-empty repo with no provider configured.
 */

export interface GoalSeedOptions {
  /** The goal statement. Absent/blank → gathered from the human channel. */
  idea?: string;
  context?: GroundingInput[];
  constraints?: string[];
  /** Bounded rounds (the flow-control 3-reject pattern — never unbounded). */
  maxRounds?: number;
}

export type GoalSeedResult =
  | {
      ok: true;
      seeded: true;
      goalId: string;
      contract: { intent: string; acceptanceCriteria: string[] };
      docPath: string;
      sha: string;
      verdict: 'solid';
    }
  | { ok: true; seeded: false; verdict: 'revise' | 'reject'; note: string }
  | { ok: false; error: CommandError };

/** ONE LINE — the Goal: section is read as a whole line by store.parseGoalDoc; any
 *  newlines the model put in collapse into spaces so the doc→contract mapping holds. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

/**
 * Deterministic synthesis: IdeaValidationDoc → goal.md (the fixed Goal:/Success
 * criteria: sections store.seedGoal parses 1:1). NO second model call — the seed lands
 * the moment the human says solid, from what the grill already converged.
 *
 * The criteria are the session's commitments, not its whole transcript:
 *  - criterion 1 is the validated one-line goal (ALWAYS present — the AC list can
 *    never be empty, and the met gate names the outcome to seal);
 *  - the claims the grill validated as ok follow as commitments the realized goal must
 *    keep true.
 * Resolved questions / remaining unknowns are deliberately NOT criteria: they guide the
 * FIRST task's shaping, not the met gate (goal-session-design §3/§8 — the doc stays a
 * machine contract + the human one-liner, never a transcript dump).
 */
export const goalDocFrom = (doc: IdeaValidationDoc): string => {
  const goal = oneLine(doc.summary) || oneLine(doc.idea);
  const criteria = new Set<string>([`The validated goal is realized: ${goal}`]);
  for (const a of doc.validatedAssumptions) {
    const claim = oneLine(a.claim);
    if (claim) criteria.add(claim);
  }
  return `# Goal

Goal: ${goal}

Success criteria:
${[...criteria].map((c) => `- ${c}`).join('\n')}
`;
};

/**
 * The driver — the whole seed as a VALUE (guarded-write style, no throw-as-flow): the
 * pre-guard, the idea gather (argv, else the human channel), the session, and the
 * on-solid materialize through L1. Returns the seeded doc's identity on GO; on
 * revise/reject/abort it returns seeded:false with a human note; provider/guard
 * failures return the L1-shaped error the CLI already renders.
 */
export const runGoalSeed = async (
  commands: Commands,
  abilities: Abilities,
  opts: GoalSeedOptions = {},
): Promise<GoalSeedResult> => {
  // GUARD — EMPTY-JOURNEY ONLY. Before any provider call (dogfoodable: the non-empty
  // repo refuses with the guard message even with no provider configured).
  if (commands.ids().length > 0) {
    return { ok: false, error: { code: 'not-empty', blocker: GOAL_SEED_GUARD } };
  }

  // GATHER — from argv when given, else the human channel.
  let idea = (opts.idea ?? '').trim();
  if (!idea) {
    try {
      idea = (await abilities.interact.ask('What is the goal you want to grill? (a rough idea is fine)')).trim();
    } catch (e) {
      if (e instanceof InteractAbort) {
        return { ok: true, seeded: false, verdict: 'reject', note: 'no goal statement was given (the session was aborted) — nothing was created' };
      }
      return { ok: false, error: { code: 'interact-failed', blocker: `goal seed: the human channel failed — ${(e as Error).message}` } };
    }
    if (!idea) return { ok: true, seeded: false, verdict: 'reject', note: 'no goal statement given — nothing was created' };
  }

  // GRILL — the interactive idea-validation session (grill → batch-ask → research →
  // converge → human verdict). Provider/adapter failures fail CLOSED here (same as
  // `ann run!`): the session returns ok:false and nothing is created.
  const r = await new IdeaValidationSession(abilities).run({
    idea,
    ...(opts.context?.length ? { context: opts.context } : {}),
    ...(opts.constraints?.length ? { constraints: opts.constraints } : {}),
    ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const doc = r.doc;

  // GO — the seed only on the HUMAN's solid (recommendation ≠ verdict: a session that
  // recommends solid but the human revises/rejects seeds nothing, and vice versa).
  if (doc.verdict !== 'solid') {
    const note =
      doc.verdict === 'revise'
        ? 'the grill recommends REVISING the goal — refine the statement and re-run: goal! seed \'<goal>\' (nothing was created)'
        : 'the grill REJECTED the goal — nothing was created';
    return { ok: true, seeded: false, verdict: doc.verdict, note };
  }

  const seeded = commands.goalSeed(goalDocFrom(doc));
  if (!seeded.ok) return { ok: false, error: seeded.error };
  return {
    ok: true,
    seeded: true,
    goalId: seeded.value.id,
    contract: seeded.value.contract,
    docPath: seeded.value.doc.path,
    sha: seeded.value.doc.sha,
    verdict: 'solid',
  };
};

/** Convenience type for the seeded verdict value (keeps the result narrowing honest). */
export type { IdeaVerdict };
