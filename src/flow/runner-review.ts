import { ContextPacket } from './materialize.js';

/**
 * S6 — THE RUNNER REVIEWER (architecture-v3 §76: "runner reviewer → the verify phase").
 *
 * A runner-SIMULATION review per node: given a node's context packet, CAN THE RUNNER
 * EXECUTE WITHOUT GUESSING? The reviewer walks the packet the way the runner would —
 * every input resolved, every blocking question answered, the intent and the acceptance
 * criteria present — and returns a verdict:
 *
 *   pass      — the runner has everything it needs: execute without guessing
 *   reject    — BLOCKING CONFUSION, named (never a silent pass): something the runner
 *               would have to guess — an unresolved input, an unanswered blocking
 *               question, an absent intent, or absent ACs
 *   escalate  — the review LOOP did not converge within maxIterations (bounded,
 *               NFR-CST-1: never unbounded) — a caller driving the loop must escalate
 *               to a human design decision instead of re-reviewing forever
 *
 * The S4 validators refuse judgment calls ("refuses judgment calls (that is the runner
 * reviewer, S6)" — validators/index.ts); THIS is where the judgment is made. Consumed
 * by the F7 gate-2 review: the confirm gate reviews whether the node was executable
 * (and therefore verifiable) without guessing.
 */

export type RunnerReviewVerdict = 'pass' | 'reject' | 'escalate';

export interface RunnerReview {
  nodeId: string;
  verdict: RunnerReviewVerdict;
  /** NAMED blockers — never empty on a non-pass verdict (no silent pass). */
  blockers: string[];
  /** The iterations the review ran (1..maxIterations — bounded, never unbounded). */
  iterations: number;
}

/** The review-loop bound (flow-control §3's 3-cycle pattern; NFR-CST-1: never open). */
export const RUNNER_REVIEW_MAX_ITERATIONS = 3;

export interface RunnerReviewOptions {
  /** The review bound. Default `RUNNER_REVIEW_MAX_ITERATIONS`. */
  maxIterations?: number;
  /** A caller-driven RESOLUTION seam, what makes the loop a real loop: between
   *  iterations the caller receives the current blockers and may resolve the confusion
   *  (e.g. re-assemble the packet after a resolution-ladder rung) and return the fresh
   *  packet to re-examine — or `undefined` to REJECT on the first un-resolved pass.
   *  Absent → a single pass decides pass/reject. */
  resolve?: (blockers: string[]) => ContextPacket | undefined;
}

/**
 * THE SIMULATION — one pass: the named blockers a runner would hit trying to execute
 * this node without guessing. An EMPTY result means pass (nothing to guess at).
 * Each blocker names the specific thing the runner is missing — never a silent pass.
 */
export function blockingConfusion(packet: ContextPacket): string[] {
  const blockers: string[] = [];
  const id = packet.pathDecisions.nodeId;

  for (const d of packet.dependencies) {
    if (d.status === 'missing') {
      blockers.push(`${id}: missing requiredInput '${d.name}' — the runner would have to guess its content`);
    }
  }
  for (const q of packet.openQuestions) {
    if (q.status === 'open' && q.impact === 'high') {
      blockers.push(`${id}: blocking question '${q.id}' unanswered — the runner would have to guess the answer`);
    }
  }
  const intent = packet.nodeContract.intent;
  if (!intent || !intent.trim()) {
    blockers.push(`${id}: no intent declared — the runner would have to guess what to build`);
  }
  const acs = packet.nodeContract.acceptanceCriteria ?? [];
  if (!acs.length) {
    blockers.push(`${id}: no acceptanceCriteria declared — the runner would have to guess what 'done' means`);
  }
  return blockers;
}

/**
 * THE BOUNDED REVIEW LOOP (AC-3): runs the simulation up to `maxIterations`, re-examining
 * a caller-resolved packet between iterations. Converged → pass. Exhausted the bound with
 * blockers still standing → ESCALATE (never unbounded — a caller must escalate, not loop).
 * The caller declining to resolve on the first pass → reject, blockers named.
 */
export function reviewRunner(packet: ContextPacket, opts: RunnerReviewOptions = {}): RunnerReview {
  const nodeId = packet.pathDecisions.nodeId;
  const max = Math.max(1, Math.floor(opts.maxIterations ?? RUNNER_REVIEW_MAX_ITERATIONS));
  let current = packet;

  for (let i = 1; i <= max; i++) {
    const blockers = blockingConfusion(current);
    if (!blockers.length) return { nodeId, verdict: 'pass', blockers: [], iterations: i };
    if (i === max) return { nodeId, verdict: 'escalate', blockers, iterations: i };
    const resolved = opts.resolve?.(blockers);
    if (!resolved) return { nodeId, verdict: 'reject', blockers, iterations: i };
    current = resolved;
  }

  // unreachable — the loop always returns at i === max; kept for the type checker
  return { nodeId, verdict: 'escalate', blockers: blockingConfusion(current), iterations: max };
}
