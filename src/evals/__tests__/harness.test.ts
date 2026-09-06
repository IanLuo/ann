import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { NAV_FIXTURES, FLOW_FIXTURES, writeNode, writeJourney, ev } from '../fixtures.js';
import { runEvalSuite, measureK1, measureK2, measureK3, measureK4, measureK5, runDogfood, renderEvalReport } from '../harness.js';
import { EvalFixture, FlowFixture } from '../types.js';

/**
 * S9 — THE EVAL HARNESS (requirements-spec v3 §5, ann-system-design §1): the suite
 * measures K1–K5 against GROUND-TRUTH fixtures. These tests pin the MEASUREMENT ENGINE:
 * every KPI derives from the fixtures' hardcoded expectations (never from the code under
 * test), the negative controls are counted honestly, and the failure signal arms exactly
 * when a KPI is below target.
 */

function tempRoot(prefix = 'ann-evaltest-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}

/** Build a nav fixture in a temp root and return a Commands over it. */
function commandsFor(fixture: EvalFixture): { root: string; commands: Commands } {
  const root = tempRoot();
  fixture.build(root);
  return { root, commands: new Commands(new Store(root), 'test') };
}

describe('measureK1 — locate accuracy', () => {
  it('derives the status the event log dictates — 100% on every nav fixture', () => {
    for (const fixture of NAV_FIXTURES) {
      const { root, commands } = commandsFor(fixture);
      const k = measureK1(commands.store, fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true);
      expect(k.value).toMatch(/100%/);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('measureK2 — locate ease', () => {
  it('resolves status + history in ≤ 2 interactions on every nav fixture', () => {
    for (const fixture of NAV_FIXTURES) {
      const { root, commands } = commandsFor(fixture);
      const k = measureK2(commands, fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true);
      expect(k.value).toMatch(/2 interactions/);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('measureK3 — advance ease', () => {
  it('reaches the right next action in ≤ 1 interaction', () => {
    for (const fixture of NAV_FIXTURES) {
      const { root, commands } = commandsFor(fixture);
      const k = measureK3(commands, fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('measureK4 — advance correctness', () => {
  it('proposes the right next action per the flow rules on every nav fixture', () => {
    for (const fixture of NAV_FIXTURES) {
      const { root, commands } = commandsFor(fixture);
      const k = measureK4(commands, fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an empty expectedNext means NO task should be proposed (leg done → no "next task:")', () => {
    const fixture = NAV_FIXTURES.find((f) => f.expectedNext === '')!;
    const { root, commands } = commandsFor(fixture);
    expect(commands.advance().detail).not.toMatch(/next task:/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('measureK5 — completion success on first pass', () => {
  it('the positive fixtures (spec, multi) first-pass — staged doc + commit evidence, concluded two-phase', async () => {
    for (const fixture of FLOW_FIXTURES.filter((f) => f.expectedFirstPass)) {
      const k = await measureK5(fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true);
      expect(k.value).toBe('first-pass ✓');
    }
  });

  it('the negative controls (rework, empty chain) are NOT counted as passes', async () => {
    for (const fixture of FLOW_FIXTURES.filter((f) => !f.expectedFirstPass)) {
      const k = await measureK5(fixture);
      expect(k.pass, `${fixture.id}: ${k.detail}`).toBe(true); // honest: expected not-first-pass and got it
      expect(k.value).toBe('NOT first-pass');
    }
  });

  it('NEVER counts unverified ACs as passes — an empty staged doc is not first-pass', async () => {
    // A stage-doc with only whitespace bytes: the frame itself fails verify on an empty
    // doc (no staged bytes to conclude), so stop ≠ completed; and even the eval's own
    // `verified` gate (a non-empty docs/<name>.md AND evidence.commits[]) is false.
    // Either layer alone is enough — together they prove the honesty guarantee.
    const emptyDoc: FlowFixture = {
      id: 'flow-empty-doc',
      name: 'an empty staged doc is NOT verifiable work',
      chain: ['spec'],
      steps: [
        {
          id: 'spec',
          execute: async () => ({
            ok: true,
            artifact: 'spec artifact',
            intents: [{ kind: 'stage-doc', name: 'spec-result', content: '   \n  ' }],
          }),
        },
      ],
      interactAnswers: ['accept', 'accept'],
      expectedFirstPass: false,
    };
    const k = await measureK5(emptyDoc);
    expect(k.pass, k.detail).toBe(true);
    expect(k.detail).toContain('NOT counted');
  });
});

describe('runEvalSuite — the KPI report', () => {
  it('measures K1–K5 at target on the shipped suite and leaves the failure signal unarmed', async () => {
    const report = await runEvalSuite({ nav: NAV_FIXTURES, flow: FLOW_FIXTURES });
    expect(report.k1.pass).toBe(true);
    expect(report.k2.pass).toBe(true);
    expect(report.k3.pass).toBe(true);
    expect(report.k4.pass).toBe(true);
    expect(report.k4.value).toBe('100% (4/4)');
    expect(report.k5.pass).toBe(true);
    expect(report.k5.value).toBe('100% (2/2)');
    expect(report.failureSignal).toBe(false);
  });

  it('a K1 miss in ONE fixture fails the aggregate and arms the signal (never masked by the first fixture)', async () => {
    const wrongStatus: EvalFixture = {
      id: 'nav-wrong-status',
      name: 'a fixture whose derived status ground truth is wrong — K1 must catch it',
      build: (root) =>
        writeJourney(root, [
          { id: '01-leg', tasks: [{ id: '01-a', events: [ev('created'), ev('completed')] }] },
        ]),
      expectedStatuses: { '01-leg/01-a': 'queued', '01-leg': 'queued' }, // wrong: 01-a is done
      locateTarget: '01-leg/01-a',
      expectedNext: '',
    };
    const report = await runEvalSuite({ nav: [wrongStatus, ...NAV_FIXTURES], flow: [] });
    expect(report.k1.pass).toBe(false);
    expect(report.k1.value).toMatch(/(4\/5|80%)/); // 4/5 fixtures accurate
    expect(report.failureSignal).toBe(true);
  });

  it('the failure signal arms when a KPI is below target (a wrong expectedNext fails K3+K4)', async () => {
    const wrongNext: EvalFixture = {
      id: 'nav-wrong-next',
      name: 'a fixture whose expected next action is wrong — K4 must catch it',
      build: (root) =>
        writeJourney(root, [
          { id: '01-leg', tasks: [{ id: '01-a', events: [ev('created')] }] },
        ]),
      expectedStatuses: { '01-leg/01-a': 'queued', '01-leg': 'queued' },
      locateTarget: '01-leg/01-a',
      expectedNext: '01-leg/definitely-not-the-next-task',
    };
    const report = await runEvalSuite({ nav: [wrongNext], flow: [] });
    expect(report.k3.pass).toBe(false);
    expect(report.k4.pass).toBe(false);
    expect(report.failureSignal).toBe(true);
  });

  it('K5 fails the honesty check when a negative control first-passes', async () => {
    // A malformed negative: expected NOT first-pass but the fixture actually completes —
    // the suite must flag the dishonesty, never celebrate it.
    const lyingNegative: FlowFixture = {
      ...FLOW_FIXTURES.find((f) => f.id === 'flow-spec')!,
      id: 'flow-lying-negative',
      expectedFirstPass: false,
    };
    const report = await runEvalSuite({ nav: NAV_FIXTURES, flow: [lyingNegative] });
    expect(report.k5.pass).toBe(false);
    expect(report.k5.detail).toContain('FAILED THE HONESTY CHECK');
    expect(report.failureSignal).toBe(true);
  });
});

describe('runDogfood — the engine measures its own journey (F-AC8)', () => {
  it('derives a valid status for every node and an advance decision', () => {
    const root = tempRoot('ann-dogfood-');
    writeNode(root, '01-leg', { intent: 'leg', acceptanceCriteria: ['done'] }, [ev('created')]);
    writeNode(root, '01-leg/01-a', { intent: 'do the thing', acceptanceCriteria: ['it is done'] }, [ev('created')]);
    writeNode(root, '01-leg/02-b', { intent: 'do the thing', acceptanceCriteria: ['it is done'] }, [ev('created'), ev('completed')]);
    const { k1, k4, detail } = runDogfood(root);
    expect(k1.pass, k1.detail).toBe(true);
    expect(k1.detail).toContain('3 nodes');
    expect(k4.pass, k4.detail).toBe(true);
    expect(detail).toContain('dogfood');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('renderEvalReport — the eval-results artifact', () => {
  it('renders a markdown KPI table with the failure-signal line', async () => {
    const report = await runEvalSuite({ nav: NAV_FIXTURES, flow: FLOW_FIXTURES });
    const md = renderEvalReport(report, { k1: report.k1, k4: report.k4, detail: 'dogfood round-trip' });
    expect(md).toContain('# Eval results');
    expect(md).toContain('| KPI | measured | target | verdict |');
    expect(md).toContain('| K1 — locate accuracy');
    expect(md).toContain('| K5 — completion success');
    expect(md).toContain('## Failure signal: **not armed**');
    expect(md).toContain('## Dogfooding round-trip');
  });
});
