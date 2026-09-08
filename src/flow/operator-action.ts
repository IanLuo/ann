import { execFileSync } from 'node:child_process';
import { AdvanceView, Commands, FrontmostReady, GoalView } from '../commands/index.js';
import { docsIndexFresh } from '../store/docs.js';
import { Frame, FrameDeps, FrameResult } from './frame.js';
import { runValidators } from './validators/index.js';
import { JourneyEvent } from '../store/store.js';

/**
 * L2 · THE OPERATOR ACTION `advance!` (functional-spec v2 F5 — the approve→execute
 * half of run-next; flow-control-spec v7 §2/§5; named before it exists on
 * `06-operator-loop/01-spec-amend-f5-execute`).
 *
 * `next` PROPOSES the frontmost-ready action (a derived read, L1 advance()); advance!
 * is the builder's ONE-interaction approve → EXECUTE of that DERIVED advance, under the
 * four deterministic rules of flow-control v7 §2:
 *   1. integrity re-check FIRST — fail closed on any dirty state (store drift ·
 *      uncommitted tracked journey/docs changes · gate gaps · a stale manifest) with the
 *      named blockers — nothing executes on a state the engine does not recognize;
 *   2. the advance is RE-DERIVED at execution, never replayed — the approved proposal
 *      is compared against the logs again right before executing; a mismatch REFUSES
 *      (a stale proposal executes nothing);
 *   3. executed ONLY through the sanctioned writers — for continue-leg that is `run!`:
 *      this module drives the SAME Frame run! dispatches, so every write stays inside
 *      the addressed node through the frame's L1 writes. The action authors no
 *      contract, answers no gate on its own, and self-closes nothing;
 *   4. land at the next human gate, never silently past one.
 * Per-derivation (v7 §2/§5): continue-leg → run the frontmost-ready through the frame;
 * advance-leg / closure-needed / none are NOT machine-executable — present the
 * boundary/closure/goal-consult card and stop (never a machine spawn, never a machine
 * contract author, never a machine closure).
 *
 * The APPROVE is this action's only human decision (over the ADVANCE card). JSON and
 * automated initiators cannot drive it — the approve is a human call (AC-6, recorded on
 * the build task): the carve-out precedents (run! · goal! seed · spec!) all refuse
 * JSON, and an automated product already holds the sanctioned writers directly —
 * advance! adds only the human approve, which by contract is never a machine decision.
 */

export type OperatorStop =
  /** AC-1 — a dirty state refused the action; nothing executed. */
  | 'refused-integrity'
  /** The builder declined the approve; nothing executed. */
  | 'declined'
  /** AC-2 — the re-derivation contradicts the approved proposal; nothing executed. */
  | 'stale-proposal'
  /** AC-4 — advance-leg/closure-needed/none are NOT machine-executable; card + stop. */
  | 'boundary'
  /** AC-3 — continue-leg executed: the frontmost-ready ran through the frame. */
  | 'advanced';

export type OperatorPhase = 'integrity' | 'derive' | 'approve' | 're-derive' | 'execute';

/** Where the journey sits after a continue-leg run — the NEXT human decision, named,
 *  never silent (rule 4). */
export interface OperatorLanding {
  task: string;
  frameStop: string;
  /** completed → its gates were decided by the human channel and the run concluded;
   *  gate → an undecided submission awaits the human (gate!); awaiting-runner → the
   *  runner's evidence commit precedes the task's confirm-result gate; stopped → the
   *  frame refused/stopped with named problems. */
  where: 'completed' | 'gate' | 'awaiting-runner' | 'stopped';
  /** The undecided gate awaiting the human (where='gate'). */
  gate?: 'grill' | 'confirm';
  /** The next derived advance (where='completed' — never assumed, always derived). */
  advance?: string;
  problems?: string[];
}

export interface OperatorActionResult {
  stop: OperatorStop;
  /** The phase the action stopped in. */
  phase: OperatorPhase;
  /** The derivation the action executed (or would have) — advance()'s own view. */
  derivation: AdvanceView;
  /** The RE-derived proposal (AC-2 — stop 'stale-proposal'): what the logs say NOW,
   *  contradicting the approved derivation. */
  reDerivation?: AdvanceView;
  /** The integrity blockers (stop 'refused-integrity'). */
  blockers: string[];
  /** The approved frontmost-ready (continue-leg: the run target). */
  frontmost?: FrontmostReady;
  /** The goal-session view when the derivation is 'none' (the goal consult). */
  goal?: GoalView;
  /** The frame result of the continue-leg run (stop 'advanced'). */
  frame?: FrameResult;
  /** Where the journey landed after the run (stop 'advanced'). */
  landing?: OperatorLanding;
}

/** A point-in-time derivation snapshot — the approved proposal's subject (rule 2). */
interface DerivationSnapshot {
  advance: AdvanceView;
  /** The continue-leg run target — bound at approval so a stale target executes nothing. */
  frontmost?: FrontmostReady;
}

const snapshotOf = (commands: Commands): DerivationSnapshot => {
  const advance = commands.advance();
  const fm = commands.frontmostReady();
  return { advance, ...(fm && advance.action === 'continue-leg' ? { frontmost: fm } : {}) };
};

/* ── AC-1 · the integrity re-check (the check/verify equivalents) ─────────── */

/** The named blockers over the four dirty-state classes — empty = a recognized state.
 *  Mirrors `ann check` (gate gaps + rule findings + the docs-manifest freshness) and
 *  `ann verify` (drift), plus the goal! archive guard (uncommitted TRACKED journey
 *  changes) extended to docs/: ann never advances on a tree whose recorded reality it
 *  does not own. Untracked scratch never refuses (the `??` filter). */
export function operatorIntegrityBlockers(commands: Commands, root: string): string[] {
  const blockers: string[] = [];
  // the CHECK equivalents — gate gaps + the closure/conclusion/contract invariants
  blockers.push(...commands.check());
  // the validator rule findings ann check treats as problems (same severity rule)
  for (const f of runValidators(commands.store)) {
    if (f.severity !== 'error') continue;
    blockers.push(`[${f.code}] ${f.detail}${f.nodeId ? ` (${f.nodeId})` : ''}`);
  }
  // the VERIFY equivalents — drift between the log's claims and fs/git reality
  blockers.push(...commands.verify().map((d) => `verify: ${d}`));
  // the docs manifest freshness — a stale index means docs/ is not the resolution reality
  const { fresh, missing, stale } = docsIndexFresh(root);
  if (!fresh) {
    blockers.push(
      `docs manifest out of sync with docs/: ${[
        ...missing.map((n) => `'${n}' not in the manifest`),
        ...stale.map((n) => `'${n}' has no matching file in docs/`),
      ].join(' · ')} — run 'ann docs --write' and commit`,
    );
  }
  // uncommitted TRACKED changes under the journey tree + the docs home (goal! archive's
  // guard, extended to docs/ per AC-1) — `??` lines are untracked scratch, never a basis
  blockers.push(...uncommittedTracked(root).map((l) => `uncommitted tracked change: ${l.slice(0, 90)}`));
  return blockers;
}

function uncommittedTracked(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', '.ann/journey', 'docs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter((l) => l && !l.startsWith('??'));
  } catch {
    return [];
  }
}

/* ── the interactive pieces ───────────────────────────────────────────────── */

/** The ADVANCE CARD — what the approve will execute, shown before the ONE decision. */
function advanceCard(s: DerivationSnapshot): string {
  const { advance, frontmost } = s;
  const lines = ['ADVANCE — approve → execute the DERIVED advance (F5 run-next)'];
  lines.push('  integrity: clean — re-checked fail-closed (store drift · gate gaps · stale manifest · uncommitted journey/docs)');
  lines.push(`  derivation: ${advance.action} — ${advance.detail}`);
  if (frontmost) {
    lines.push(`  will run the frontmost-ready through the frame (run!): ${frontmost.task} (${frontmost.status})`);
    lines.push('    materialize → gates → activate → execute → verify → confirm → commit — the frame stops at the next');
    lines.push('    human decision. advance! answers no gate, authors no contract, self-closes nothing.');
  }
  lines.push('  your approve is the ONE decision over this card — every task gate stays a human gate (gate! / the frame\'s channel).');
  return lines.join('\n');
}

/** An undecided submission at a task — the gate awaiting the human, if any. */
function undecidedGateOf(events: JourneyEvent[]): 'grill' | 'confirm' | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'submitted' || typeof e.gate !== 'string') continue;
    if (!events.slice(i + 1).some((x) => (x.type === 'confirmed' || x.type === 'rejected') && x.gate === e.gate)) {
      return e.gate === 'grill' ? 'grill' : 'confirm';
    }
  }
  return undefined;
}

/** Where the journey landed after a continue-leg run — derived from the frame stop and
 *  the task's log, never assumed (rule 4: the next human decision is NAMED). */
function landingOf(commands: Commands, task: string, r: FrameResult): OperatorLanding {
  switch (r.stop) {
    case 'completed':
      return { task, frameStop: r.stop, where: 'completed', advance: r.advance };
    case 'blocked-at-gate':
      return { task, frameStop: r.stop, where: 'gate', gate: undecidedGateOf(commands.events(task)) };
    case 'blocked-waiting':
      // the two-phase wait: the confirm gate is decided (or verify waits for the empty
      // chain) and the RUNNER's evidence commit precedes the task's confirm-result gate
      return { task, frameStop: r.stop, where: 'awaiting-runner', gate: 'confirm' };
    default:
      return { task, frameStop: r.stop, where: 'stopped', problems: r.problems };
  }
}

/* ── the action ───────────────────────────────────────────────────────────── */

export async function runOperatorAction(deps: FrameDeps): Promise<OperatorActionResult> {
  const { commands, root, abilities } = deps;

  // AC-1 — integrity re-check FIRST, fail closed on any dirty state
  const blockers = operatorIntegrityBlockers(commands, root);
  if (blockers.length) {
    return { stop: 'refused-integrity', phase: 'integrity', derivation: commands.advance(), blockers };
  }

  // derive the proposal — a point-in-time derivation, bound to what the approve covers
  const approved = snapshotOf(commands);
  const { advance } = approved;

  // AC-4 — the NOT-machine-executable derivations: present the boundary/closure/goal
  // consult card and stop. No approve is asked (nothing would execute); no writes.
  if (advance.action !== 'continue-leg') {
    const goal = advance.action === 'none' ? okGoal(commands) : undefined;
    return { stop: 'boundary', phase: 'derive', derivation: advance, blockers, ...(goal ? { goal } : {}) };
  }

  // AC-6 — the ADVANCE card + the builder's ONE approve (the frame's gates stay human)
  await abilities.interact.present(advanceCard(approved));
  const answer = await abilities.interact.decide(
    'approve executing the derived advance (the card above)? — approve runs it through the frame · decline stops with no writes',
    ['approve', 'decline'],
  );
  if (answer !== 'approve') {
    return { stop: 'declined', phase: 'approve', derivation: advance, blockers, frontmost: approved.frontmost };
  }

  // AC-2 — re-derived at execution, never replayed: a proposal the logs no longer match
  // executes nothing (derivation stays the APPROVED proposal; reDerivation is the now)
  const now = snapshotOf(commands);
  if (JSON.stringify(now) !== JSON.stringify(approved)) {
    return { stop: 'stale-proposal', phase: 're-derive', derivation: advance, reDerivation: now.advance, blockers, frontmost: approved.frontmost };
  }

  // AC-3 — execute through the frame (run!) and land at the next human gate
  const task = now.frontmost!.task;
  const frame = new Frame(deps);
  const result = await frame.run(task);
  return {
    stop: 'advanced',
    phase: 'execute',
    derivation: now.advance,
    blockers,
    frontmost: now.frontmost,
    frame: result,
    landing: landingOf(commands, task, result),
  };
}

/** Narrow the goal view to its value — the consult never fails (reads only). */
function okGoal(commands: Commands): GoalView | undefined {
  const g = commands.goal();
  return g.ok ? g.value : undefined;
}
