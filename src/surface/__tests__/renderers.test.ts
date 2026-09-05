import { describe, it, expect } from 'vitest';
import { TaskDetail, ResultItem } from '../../store/store.js';
import type { GoalView } from '../../commands/index.js';
import { renderStatusTree, renderGateCard, renderPlan, renderGoal, redact, hasSecret, hasScalarProgress, renderDrift, renderLedger } from '../renderers.js';

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  id: '06-engine-build/09-s6-runner-reviewer',
  isLeg: false,
  status: 'queued',
  superseded: false,
  contract: {
    intent: 'the runner reviewer',
    acceptanceCriteria: ['AC one', 'AC two'],
    targetAreas: ['src/flow/'],
  },
  gates: {
    grill: { state: 'confirmed', at: '2026-08-28' },
    confirm: { state: 'submitted', at: '2026-08-28' },
  },
  artifacts: [{ name: 'runner-review', path: '.ann/journey/legs/06-engine-build/09/artifacts/runner-review.md', sha: 'abc1234', role: 'current' }],
  events: [],
  blockers: [],
  ...over,
});

describe('renderStatusTree (F10 — tree view)', () => {
  it('renders one padded line per node with status + superseded marker', () => {
    const text = renderStatusTree([
      { id: '06-engine-build', status: 'queued', superseded: false },
      { id: '06-engine-build/09-s6-runner-reviewer', status: 'queued', superseded: false },
      { id: '06-engine-build/20-journey-format-v14', status: 'done', superseded: true },
    ]);
    const v14Line = text.split('\n').find((l) => l.includes('06-engine-build/20-journey-format-v14'));
    expect(v14Line).toContain('done · artifact superseded');
    expect(text).toContain('06-engine-build/09-s6-runner-reviewer');
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('renderGateCard (F11 — step card)', () => {
  it('renders intent, ACs, artifacts, gates, results', () => {
    const results: ResultItem[] = [
      { kind: 'commit', label: '01a10ca slice 1' },
      { kind: 'ref', label: 'src/flow/runner-review.ts' },
    ];
    const text = renderGateCard({ detail: detail(), results });
    expect(text).toContain('GATE CARD: 06-engine-build/09-s6-runner-reviewer');
    expect(text).toContain('intent: the runner reviewer');
    expect(text).toContain('AC-1: AC one');
    expect(text).toContain('AC-2: AC two');
    expect(text).toContain('✓ grilling (entry) — confirmed (2026-08-28)');
    expect(text).toContain('… confirm-result (exit) — submitted (2026-08-28)');
    expect(text).toContain('commit');
    expect(text).toContain('runner-review.md');
    expect(text).toContain('verify each AC against the artifact + evidence');
  });

  it('renders the rejected and none gate states distinctly', () => {
    const text = renderGateCard({
      detail: detail({
        gates: { grill: { state: 'rejected', at: '2026-08-28' }, confirm: { state: 'none' } },
      }),
    });
    expect(text).toContain('✗ grilling (entry) — rejected (2026-08-28)');
    expect(text).toContain('· confirm-result (exit) — none');
  });

  it('renders blockers as a named wait, never a silent pass', () => {
    const text = renderGateCard({ detail: detail({ status: 'blocked', blockers: ['waiting on the confirm gate decision'] }) });
    expect(text).toContain('BLOCKED — waiting on human');
    expect(text).toContain('waiting on the confirm gate decision');
  });
});

describe('renderPlan (F12 — full plan)', () => {
  it('renders every leg with tasks + the look-back ahead', () => {
    const text = renderPlan(
      [
        { id: '01-goal', status: 'done', superseded: false },
        { id: '06-engine-build', status: 'queued', superseded: false, tasks: [{ id: '06-engine-build/09-s6-runner-reviewer', status: 'queued' }] },
      ],
      {
        activeLeg: '06-engine-build',
        activeLegStatus: 'queued',
        frontmostReady: { task: '06-engine-build/09-s6-runner-reviewer', status: 'queued' },
        alsoReady: [{ task: '06-engine-build/10-s7-github-binding', status: 'queued' }],
        legGate: { met: true },
      },
    );
    expect(text).toContain('=== WHERE WE ARE ===');
    expect(text).toContain('09-s6-runner-reviewer:queued');
    expect(text).toContain('frontmost-ready: 06-engine-build/09-s6-runner-reviewer (queued)');
    expect(text).toContain('also ready: 06-engine-build/10-s7-github-binding (queued)');
  });
});

describe('renderGoal — the goal-session view (goal-session-design §9)', () => {
  const base: GoalView = {
    present: true,
    goalId: '01-goal',
    goalStatus: 'done',
    structural: { exhausted: true, detail: 'every leg derived done — the session is structurally complete; a HUMAN verdict seals it (goal! met)' },
    verdict: 'unconfirmed',
    legs: [
      { id: '01-goal', status: 'done' },
      { id: '02-shaping', status: 'done' },
    ],
  };

  it('renders the goal id, status, verdict and legs — STATUS WORDS only', () => {
    const text = renderGoal(base);
    expect(text).toContain('GOAL: 01-goal  [done]');
    expect(text).toContain('verdict: unconfirmed');
    expect(text).toContain('structurally complete');
    expect(text).toContain('02-shaping done');
  });

  it('renders the LOCKED doc + the generated contract + the met record when present', () => {
    const text = renderGoal({
      ...base,
      verdict: 'met',
      goalDoc: { name: 'goal', path: '.ann/journey/legs/01-goal/artifacts/goal.md', sha: 'abc1234' },
      contract: { intent: 'build a goal session', acceptanceCriteria: ['it works end to end', 'archive is faithful'] },
      metEvent: { at: '2026-09-01', type: 'goal-met', decision: 'met', note: 'goal met (ian)', feedback: 'criteria confirmed' },
    });
    expect(text).toContain('doc: goal @ abc1234');
    expect(text).toContain('intent: build a goal session');
    expect(text).toContain('AC-2: archive is faithful');
    expect(text).toContain('met: 2026-09-01 — goal met (ian) · feedback: criteria confirmed');
    expect(text).toContain('verdict: met — session sealed');
  });

  it('renders the no-goal state with its structural detail', () => {
    const text = renderGoal({ present: false, structural: { exhausted: false, detail: 'no goal — the journey is empty: grill & seed a goal (goal.md + the generated contract)' }, verdict: 'open', legs: [] });
    expect(text).toContain('GOAL: (none)');
    expect(text).toContain('journey is empty');
  });

  it('surfaces the RE-SEEDABLE state: YES only while fresh + unconsumed; NO names the consumer or the seal', () => {
    const yes = renderGoal({
      ...base,
      reseed: { reseedable: true, why: "fresh & unconsumed — the goal leg is the journey's only node: nothing spawned under or after it, nothing derived from goal.md yet" },
    });
    expect(yes).toContain('reseed: YES — fresh & unconsumed');
    const no = renderGoal({
      ...base,
      reseed: { reseedable: false, why: 'consumed by 02-shaping — work spawned under/after the goal derives from goal.md; change the goal via goal! archive → a new goal' },
    });
    expect(no).toContain('reseed: NO — consumed by 02-shaping');
    const sealed = renderGoal({
      ...base,
      verdict: 'met',
      metEvent: { at: '2026-09-01', type: 'goal-met', decision: 'met', note: 'goal met (ian)' },
      reseed: { reseedable: false, why: 'goal sealed (met) — the session is terminal; change the goal via goal! archive → a new goal' },
    });
    expect(sealed).toContain('reseed: NO — goal sealed (met)');
  });

  it('never emits scalar progress (AC5 — the goal surface is status words only)', () => {
    const texts = [
      renderGoal(base),
      renderGoal({ ...base, verdict: 'met', metEvent: { at: '2026-09-01', type: 'goal-met', decision: 'met', note: 'goal met (ian)' } }),
      renderGoal({
        ...base,
        reseed: { reseedable: true, why: "fresh & unconsumed — the goal leg is the journey's only node: nothing spawned under or after it, nothing derived from goal.md yet" },
      }),
      renderGoal({
        ...base,
        reseed: { reseedable: false, why: 'consumed by 02-shaping — work spawned under/after the goal derives from goal.md; change the goal via goal! archive → a new goal' },
      }),
      renderGoal({ present: false, structural: { exhausted: false, detail: 'no goal leg — work legs without a seeded goal (a legacy journey): archive & reseed for the goal-session shape' }, verdict: 'open', legs: [{ id: '01-leg', status: 'done' }] }),
    ];
    for (const t of texts) expect(hasScalarProgress(t)).toBe(false);
  });
});

describe('renderDrift — the `ann verify` DRIFT line', () => {
  it('prefixes DRIFT and passes the claim-vs-reality message through verbatim', () => {
    expect(renderDrift('locksha: design — recorded lockSha 257cb79 vs file content b8c3629')).toBe('DRIFT locksha: design — recorded lockSha 257cb79 vs file content b8c3629');
    expect(renderDrift('artifact-orphan: 01-goal/artifacts/goal.md vs no artifact-locked event of this node names it')).toContain('artifact-orphan: 01-goal/artifacts/goal.md');
    // the store-external kind rides the same renderer — the CLI just prints it to stderr
    expect(renderDrift('store-external: 01-leg/01-a — events.jsonl differs vs ann wrote rev 3 at 2026-08-29; class=append')).toContain('store-external: 01-leg/01-a');
  });
});

describe('renderLedger — the `ann ledger` write-rev view', () => {
  it('renders the rev header and one padded line per tracked node', () => {
    const text = renderLedger({
      rev: 3,
      bootstrappedAt: '2026-08-30T10:00:00.000Z',
      nodes: {
        '06-engine-build/13-format-amendment-v9': { eventsSha: 'a'.repeat(40), nodeSha: 'b'.repeat(40), lastEventAt: '2026-08-22', lastRev: 2 },
      },
    });
    expect(text).toContain('LEDGER rev 3 (bootstrapped 2026-08-30)');
    expect(text).toContain('06-engine-build/13-format-amendment-v9');
    expect(text).toContain('rev 2 @ 2026-08-22');
    expect(text).toContain('events aaaaaaa · node bbbbbbb');
  });

  it('renders the no-ledger state', () => {
    expect(renderLedger({ rev: 0, bootstrappedAt: '', nodes: {} })).toContain('no ledger yet');
  });
});

describe('redaction — NFR-SEC-1 (no secrets rendered)', () => {
  it('redacts tokens, keys, Authorization headers, PATs', () => {
    expect(redact('token: sk-abc123def456ghi789')).toContain('[REDACTED]');
    expect(redact('api_key=super_secret_value')).toContain('[REDACTED]');
    expect(redact('authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toContain('[REDACTED]');
    expect(redact('password: hunter2')).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    const s = 'intent: the runner reviewer — src/flow/runner-review.ts';
    expect(redact(s)).toBe(s);
  });

  it('hasSecret flags a leaked secret and is quiet on clean text', () => {
    expect(hasSecret('the token is sk-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(hasSecret('the token field is not rendered')).toBe(false);
  });
});

describe('no scalar progress — AC5', () => {
  it('renderers never emit percentages or counts-as-progress', () => {
    const card = renderGateCard({ detail: detail() });
    const tree = renderStatusTree([{ id: 'x', status: 'queued', superseded: false }]);
    const plan = renderPlan([{ id: '01-goal', status: 'done', superseded: false }], {
      activeLeg: '01-goal',
      activeLegStatus: 'done',
      alsoReady: [],
      legGate: { met: true },
    });
    expect(hasScalarProgress(card)).toBe(false);
    expect(hasScalarProgress(tree)).toBe(false);
    expect(hasScalarProgress(plan)).toBe(false);
  });

  it('the guard itself catches a scalar-progress signal', () => {
    expect(hasScalarProgress('done: 5 of 7 tasks')).toBe(true);
    expect(hasScalarProgress('progress 42%')).toBe(true);
  });
});
