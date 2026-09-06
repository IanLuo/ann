import { Commands, CommandError, GOAL_SEED_GUARD } from '../commands/index.js';
import { Abilities, InteractAbort } from './types.js';
import { GroundingInput } from './steps/shared.js';
import { GoalGrillSession, GoalResolvedQuestion } from './goal-grill.js';

/**
 * L2 · THE `goal! seed` MATERIALIZE PATH (the v6 composite the plan deferred: seedGoal
 * exists, but nothing drives the grill → doc → seed that goal.md is authored for).
 * This runs the GOAL GRILL at SESSION scope on the user's goal — a dedicated goal-mode
 * loop (src/flow/goal-grill) that grinds the rough goal into a sharp one — then, on a
 * HUMAN `GO`, synthesizes goal.md deterministically and seeds it through L1
 * (goalSeed = seedGoal + the goal.md artifact-lock on the goal root).
 *
 * The grill is NOT the task idea-validate session (whose 'revise' is terminal — right for
 * a task idea, wrong for a goal): revising a goal refines the statement IN-SESSION and the
 * next round re-grills it with all context carried; the rounds end with a GO (→ seed), a
 * SKIP/abort (→ nothing), or the bound running out (→ a FULL summary + how to continue).
 *
 * NOTHING IS CREATED unless the human says GO: skip/reject/abort → nothing · rounds run
 * out → nothing, with an honest note. The goal! seed gate (goalSeedGate — an EMPTY
 * journey seeds fresh; a RE-SEEDABLE sole unconsumed goal is REPLACED; consumed/met
 * refuses) runs BEFORE any provider call, so the refusal is dogfoodable on a non-empty
 * repo with no provider configured.
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
 * Deterministic synthesis: the grill's converged outcome → goal.md (the fixed
 * Goal:/Success criteria: sections store.seedGoal parses 1:1). NO second model call —
 * the seed lands the moment the human says GO, from what the grill already converged.
 *
 * The criteria are REAL checkable commitments, not the vacuous 'The validated goal is
 * realized: <the whole idea>':
 *  - criterion 1 is the REFINED goal statement — the concrete outcome sentence the human
 *    just approved (it ALWAYS seeds, so the AC list can never be empty and the met gate
 *    names the outcome to seal);
 *  - the claims the final read validated as 'ok' follow as commitments the realized goal
 *    must keep true;
 *  - every resolved HIGH/MEDIUM answer imposes a constraint the goal must honor, and
 *    lands as its own commitment (question → answer).
 * Low-impact answers and open questions are deliberately NOT criteria: they guide the
 * FIRST task's shaping, not the met gate (goal-session-design §3/§8 — the doc stays a
 * machine contract + the human one-liner, never a transcript dump).
 */
export const goalDocFrom = (g: { goal: string; okClaims: string[]; resolved: GoalResolvedQuestion[] }): string => {
  const goal = oneLine(g.goal);
  const criteria = new Set<string>([goal]); // criterion 1 — the concrete outcome sentence
  for (const c of g.okClaims) {
    const line = oneLine(c);
    if (line) criteria.add(line);
  }
  for (const r of g.resolved) {
    if (r.impact === 'low') continue; // only high/medium answers impose goal criteria
    const q = oneLine(r.question);
    const a = oneLine(r.answer);
    if (q && a) criteria.add(`${q} → ${a}`);
  }
  return `# Goal

Goal: ${goal}

Success criteria:
${[...criteria].map((c) => `- ${c}`).join('\n')}
`;
};

/**
 * The driver — the whole seed as a VALUE (guarded-write style, no throw-as-flow): the
 * pre-guard, the idea gather (argv, else the human channel), the goal grill, and the
 * on-GO materialize through L1. Returns the seeded doc's identity on GO; on
 * skip/reject/abort it returns seeded:false with a human note; on rounds run out it
 * returns seeded:false (the driver already showed the full summary) with an honest note;
 * provider/guard failures return the L1-shaped error the CLI already renders.
 */
export const runGoalSeed = async (
  commands: Commands,
  abilities: Abilities,
  opts: GoalSeedOptions = {},
): Promise<GoalSeedResult> => {
  // GUARD — EMPTY journey (fresh seed) OR a RE-SEEDABLE goal (sole, unconsumed → the
  // reseed REPLACES it). Consumed/met refuses with the WHY. Runs before any provider
  // call (dogfoodable: a non-seedable journey refuses with the gate message even with
  // no provider configured); the gate is the SAME one the L1 composite enforces.
  const gate = commands.goalSeedGate();
  if (!gate.allow) {
    return { ok: false, error: { code: 'not-empty', blocker: gate.blocker ?? GOAL_SEED_GUARD } };
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

  // GRILL — the dedicated GOAL grill (goal-mode rounds → GO / REVISE-in-session / SKIP).
  // Provider/adapter failures fail CLOSED here (same as `ann run!`): the session returns
  // ok:false and nothing is created.
  const r = await new GoalGrillSession(abilities).run({
    statement: idea,
    ...(opts.context?.length ? { context: opts.context } : {}),
    ...(opts.constraints?.length ? { constraints: opts.constraints } : {}),
    ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.verdict !== 'solid') {
    return { ok: true, seeded: false, verdict: r.verdict === 'exhausted' ? 'revise' : 'reject', note: r.note };
  }

  // GO — the seed only on the HUMAN's GO (a round with remaining unknowns that the human
  // accepts still seeds; skipping/aborting never does).
  const seeded = commands.goalSeed(goalDocFrom(r));
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
