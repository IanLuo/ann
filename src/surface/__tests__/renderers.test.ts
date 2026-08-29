import { describe, it, expect } from 'vitest';
import { TaskDetail, ResultItem } from '../../store/store.js';
import { renderStatusTree, renderGateCard, renderPlan, redact, hasSecret, hasScalarProgress, renderDrift } from '../renderers.js';

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

describe('renderDrift — the `ann verify` DRIFT line', () => {
  it('prefixes DRIFT and passes the claim-vs-reality message through verbatim', () => {
    expect(renderDrift('locksha: design — recorded lockSha 257cb79 vs file content b8c3629')).toBe('DRIFT locksha: design — recorded lockSha 257cb79 vs file content b8c3629');
    expect(renderDrift('artifact-orphan: 01-goal/artifacts/goal.md vs no artifact-locked event of this node names it')).toContain('artifact-orphan: 01-goal/artifacts/goal.md');
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
