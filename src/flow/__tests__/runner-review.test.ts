import { describe, it, expect } from 'vitest';
import { ContextPacket } from '../materialize.js';
import { blockingConfusion, reviewRunner, RUNNER_REVIEW_MAX_ITERATIONS } from '../runner-review.js';

/**
 * S6 — THE RUNNER REVIEWER (architecture-v3 §76 — the verify phase). A runner-simulation
 * review per node: can the runner execute without guessing? Blocking confusion → REJECTION
 * with named blockers (never a silent pass). Bounded loops: max iterations, then ESCALATE
 * (never unbounded). Consumed by the F7 gate-2 review.
 */

const NODE = '06-engine-build/09-s6-runner-reviewer';

/** A ready packet — everything the runner needs, nothing to guess at. */
const readyPacket = (over: Partial<ContextPacket> = {}): ContextPacket => ({
  pathDecisions: { nodeId: NODE, isLeg: false, leg: '06-engine-build', route: ['06-engine-build', '09-s6-runner-reviewer'], depth: 2 },
  nodeContract: { intent: 'build the runner reviewer', acceptanceCriteria: ['AC-1'], requiredInputs: [], expectedOutputs: ['src/flow/runner-review.ts'] },
  dependencies: [],
  readiness: { ready: true, blockers: [] },
  siblingStatus: { siblings: [], children: [] },
  bindingState: { links: [] },
  openQuestions: [],
  ...over,
});

const missing = (name: string) => ({ name, status: 'missing' as const, sourceType: 'derived-from' as const, blocker: name });

describe('the runner reviewer — simulation review (AC-1): can the runner execute without guessing?', () => {
  it('passes a ready packet — every input resolved, questions answered, intent + ACs present', () => {
    const r = reviewRunner(readyPacket());
    expect(r.verdict).toBe('pass');
    expect(r.blockers).toEqual([]);
    expect(r.nodeId).toBe(NODE);
    expect(r.iterations).toBe(1);
    expect(blockingConfusion(readyPacket())).toEqual([]);
  });

  it('rejects a packet with a missing requiredInput — the runner would guess its content', () => {
    const p = readyPacket({ dependencies: [missing('x-spec')] });
    const r = reviewRunner(p);
    expect(r.verdict).toBe('reject');
    expect(r.blockers.join('\n')).toContain("missing requiredInput 'x-spec'");
    expect(r.blockers.join('\n')).toContain('guess');
  });

  it('rejects a packet with an unanswered blocking question — the runner would guess the answer', () => {
    const p = readyPacket({
      openQuestions: [{ id: 'Q1', question: 'which way?', impact: 'high', provenance: 'declared at spawn', status: 'open' }],
    });
    const r = reviewRunner(p);
    expect(r.verdict).toBe('reject');
    expect(r.blockers.join('\n')).toContain("blocking question 'Q1' unanswered");
  });

  it('rejects a packet with no intent — the runner would guess what to build', () => {
    const r = reviewRunner(readyPacket({ nodeContract: { ...readyPacket().nodeContract, intent: '   ' } }));
    expect(r.verdict).toBe('reject');
    expect(r.blockers.join('\n')).toContain('no intent declared');
  });

  it('rejects a packet with no acceptanceCriteria — the runner would guess what "done" means', () => {
    const r = reviewRunner(readyPacket({ nodeContract: { ...readyPacket().nodeContract, acceptanceCriteria: [] } }));
    expect(r.verdict).toBe('reject');
    expect(r.blockers.join('\n')).toContain('no acceptanceCriteria declared');
  });
});

describe('blocking confusion is NAMED, never a silent pass (AC-2)', () => {
  it('a non-pass review always carries named blockers — every blocker names the missing thing', () => {
    const p = readyPacket({
      dependencies: [missing('x-spec')],
      nodeContract: { ...readyPacket().nodeContract, acceptanceCriteria: [] },
    });
    const r = reviewRunner(p);
    expect(r.verdict).not.toBe('pass');
    expect(r.blockers.length).toBeGreaterThan(0);
    for (const b of r.blockers) expect(b.length).toBeGreaterThan(10);
    // the two blockers are distinct and both named
    expect(r.blockers.join('\n')).toContain('missing requiredInput');
    expect(r.blockers.join('\n')).toContain('no acceptanceCriteria');
  });

  it('a rejected packet never reports an empty blocker list', () => {
    const r = reviewRunner(readyPacket({ dependencies: [missing('a')] }));
    expect(r.verdict).toBe('reject');
    expect(r.blockers.length).toBeGreaterThan(0);
  });
});

describe('bounded review loops — max iterations, then ESCALATE (AC-3, NFR-CST-1)', () => {
  it('escalates when the caller cannot resolve the confusion within the bound — never unbounded', () => {
    let resolveCalls = 0;
    const r = reviewRunner(readyPacket({ dependencies: [missing('x-spec')] }), {
      // every resolution attempt returns a packet that is STILL confused
      resolve: () => {
        resolveCalls++;
        return readyPacket({ dependencies: [missing('x-spec')] });
      },
    });
    expect(r.verdict).toBe('escalate');
    expect(r.iterations).toBe(RUNNER_REVIEW_MAX_ITERATIONS);
    // the loop is bounded: the resolve seam was consulted maxIterations-1 times, then
    // the bound is exhausted — it did NOT loop forever
    expect(resolveCalls).toBe(RUNNER_REVIEW_MAX_ITERATIONS - 1);
    expect(r.blockers.join('\n')).toContain("missing requiredInput 'x-spec'");
  });

  it('honours maxIterations: 1 → escalate on the first unresolved pass', () => {
    const r = reviewRunner(readyPacket({ dependencies: [missing('x-spec')] }), { maxIterations: 1 });
    expect(r.verdict).toBe('escalate');
    expect(r.iterations).toBe(1);
  });

  it('converges to pass the moment a resolution clears the blockers', () => {
    let calls = 0;
    const r = reviewRunner(readyPacket({ dependencies: [missing('x-spec')] }), {
      resolve: () => {
        calls++;
        return readyPacket(); // the second examination is clean
      },
    });
    expect(r.verdict).toBe('pass');
    expect(r.iterations).toBe(2);
    expect(calls).toBe(1);
  });

  it('a caller that declines to resolve on the first pass gets a REJECT, not an escalate', () => {
    const r = reviewRunner(readyPacket({ dependencies: [missing('x-spec')] }), {
      resolve: () => undefined,
    });
    expect(r.verdict).toBe('reject');
    expect(r.iterations).toBe(1);
  });

  it('without a resolve seam a single pass decides pass/reject — the loop cannot exceed the bound', () => {
    expect(reviewRunner(readyPacket()).verdict).toBe('pass');
    expect(reviewRunner(readyPacket({ dependencies: [missing('x-spec')] })).verdict).toBe('reject');
  });
});
