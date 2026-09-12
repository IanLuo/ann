import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../index.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';

/**
 * THE L1 DERIVED VIEWS (core-design §1) — frontmostReady · lookBack · advance.
 *
 * They live at L1 because they are DERIVATIONS OVER THE LOG, not coordination: the
 * frame reads them, it does not compute them, and nothing may assume them. Ported here
 * from the superseded planner kernel, which is where they used to live.
 */

let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = { intent: 'Build the thing', acceptanceCriteria: ['AC-1'] }) {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
  writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const commands = () => new Commands(new Store(root), 'test');

/** v6 — the seeded goal leg: CHILDLESS, created+completed on its root → legStatus
 *  derives done, and the first work leg's legGateMet opens. (goal-session-design §2) */
const seedGoal = (contract: unknown = { intent: 'Build the goal', acceptanceCriteria: ['the goal is met'] }) =>
  writeNode('01-goal', [ev('created'), ev('completed')], contract);
/** A done work leg under the goal — a completed task derives the leg done. */
const doneWork = (id = '02-work') => {
  writeNode(id, []);
  writeNode(`${id}/01-a`, [ev('created'), ev('completed')]);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-views-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('frontmostReady — prefix order over the log', () => {
  it('takes the first queued/active task in prefix order', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created')]);
    writeNode('01-leg/02-b', [ev('created')]);
    expect(commands().frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/01-a', status: 'queued' });
  });

  it('skips failed, superseded, and blocked siblings — a pending human gate is NOT ready', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('failed')]);
    writeNode('01-leg/02-b', [ev('created'), ev('superseded')]);
    writeNode('01-leg/03-c', [ev('created')]);
    writeNode('01-leg/04-d', [ev('created'), ev('submitted', { gate: 'grill' })]);
    expect(commands().frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/03-c', status: 'queued' });
  });
});

describe('lookBack — the observer view', () => {
  it('reports the active leg, the frontmost-ready task, and the UNDECIDED human gates', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('activated'), ev('completed')]);
    writeNode('01-leg/02-b', [ev('created')]);
    writeNode('01-leg/03-c', [ev('created'), ev('submitted', { gate: 'grill' })]);
    const lb = commands().lookBack();
    expect(lb.activeLeg).toBe('01-leg');
    expect(lb.frontmostReady).toEqual({ leg: '01-leg', task: '01-leg/02-b', status: 'queued' });
    expect(lb.pendingGates).toEqual([{ task: '01-leg/03-c', gate: 'grill' }]);
  });

  it('a DECIDED submission is not a pending gate', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    expect(commands().lookBack().pendingGates).toEqual([]);
  });
});

describe('pendingGates — the WHOLE-JOURNEY gate queue (the service/UI WAITING ON YOU view)', () => {
  it('surfaces an undecided submission the ACTIVE-LEG look-back scopes away', () => {
    // A DONE task can still hide a stray submission (it never overrides `done`), so a
    // pending gate can live in a leg that already derives done — the whole-journey read
    // is the one that shows it.
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed'), ev('submitted', { gate: 'grill' })]);
    writeNode('02-leg', []);
    writeNode('02-leg/01-a', [ev('created')]);
    expect(commands().status('01-leg')).toBe('done');
    expect(commands().lookBack().pendingGates).toEqual([]); // the active leg is 02-leg
    // the row carries the STEP (v08/10): role · whose step (leg + intent) · what is delivered
    expect(commands().pendingGates()).toEqual([
      {
        task: '01-leg/01-a',
        gate: 'grill',
        role: 'entry',
        leg: '01-leg',
        intent: 'Build the thing',
        since: '2026-08-27',
        delivered: { commits: 0, claims: 0, unclaimed: 1, checks: 0, bound: 0 },
      },
    ]);
  });

  it('covers every leg, in id order, and skips cancelled/deferred escape hatches', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('submitted', { gate: 'grill' })]);
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' }), ev('cancelled', { reason: 'not needed' })]);
    writeNode('02-leg', []);
    writeNode('02-leg/01-a', [ev('created'), ev('submitted', { gate: 'confirm' })]);
    const rows = commands().pendingGates();
    expect(rows.map((r) => `${r.task}@${r.gate}(${r.role})`)).toEqual(['01-leg/01-a@grill(entry)', '02-leg/01-a@confirm(exit)']);
    expect(rows.map((r) => r.leg)).toEqual(['01-leg', '02-leg']);
  });
});

describe('advance — the leg gate validated from the logs, never assumed', () => {
  it('tasks remaining → continue-leg, naming the frontmost', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created')]);
    writeNode('02-leg', []);
    const a = commands().advance();
    expect(a.action).toBe('continue-leg');
    expect(a.detail).toContain('01-leg/01-a');
  });

  it('leg gate met → advance-leg, naming the next leg', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);
    writeNode('02-leg', []);
    const a = commands().advance();
    expect(a.action).toBe('advance-leg');
    expect(a.detail).toContain('02-leg');
  });

  it('gate unmet with remaining work → closure-needed; closure stays a GATED human decision', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' })]);
    const a = commands().advance();
    expect(a.action).toBe('closure-needed');
    expect(a.detail).toContain('closure');
  });
});

describe('advance — the FOUR-STATE GOAL CONSULT (goal-session-design §5)', () => {
  it('no goal (empty journey) → none, pointing at grill & seed, never a blind "complete"', () => {
    const a = commands().advance();
    expect(a.action).toBe('none');
    expect(a.detail).toContain('no goal');
    expect(a.detail).toContain('grill & seed');
  });

  it('seeded goal with NO work spawned → open (a goal alone is never exhausted)', () => {
    seedGoal();
    const a = commands().advance();
    expect(a.action).toBe('none');
    expect(a.detail).toContain('session open');
    expect(a.detail).not.toContain('UNCONFIRMED');
  });

  it('structurally exhausted without a verdict → the CHOICE MENU (met / subtle task / archive)', () => {
    seedGoal();
    doneWork();
    const a = commands().advance();
    expect(a.action).toBe('none');
    expect(a.detail).toContain('UNCONFIRMED');
    expect(a.detail).toContain('goal! met');
    expect(a.detail).toContain('subtle task');
    expect(a.detail).toContain('goal! archive');
    expect(a.detail).not.toMatch(/next task:/); // matchesAdvance: exhausted proposes no task
  });

  it('met → session complete → archive & start a new goal', () => {
    seedGoal();
    doneWork();
    const c = commands();
    c.goalVerdict('met');
    const a = c.advance();
    expect(a.action).toBe('none');
    expect(a.detail).toContain('session complete');
    expect(a.detail).toContain('goal! archive');
  });
});

describe('goal() — the goal-session read (goal-session-design §9)', () => {
  it('present:false on an empty journey — verdict open, detail names grill & seed', () => {
    const v = valueOf(commands().goal());
    expect(v.present).toBe(false);
    expect(v.verdict).toBe('open');
    expect(v.structural.exhausted).toBe(false);
    expect(v.structural.detail).toContain('grill & seed');
    expect(v.legs).toEqual([]);
  });

  it('present:false on a legacy journey (work legs, no seeded goal) — detail names the legacy shape', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);
    const v = valueOf(commands().goal());
    expect(v.present).toBe(false);
    expect(v.structural.detail).toContain('legacy journey');
  });

  it('present + open — the seeded goal leg derives done; a goal alone is not exhausted', () => {
    seedGoal();
    const v = valueOf(commands().goal());
    expect(v.present).toBe(true);
    expect(v.goalId).toBe('01-goal');
    expect(v.goalStatus).toBe('done');
    expect(v.verdict).toBe('open');
    expect(v.structural.exhausted).toBe(false);
  });

  it('exhausted-unconfirmed once work exists and every leg derives done — the contract reads from the node', () => {
    seedGoal({ intent: 'Build the goal session', acceptanceCriteria: ['the session archives faithfully'] });
    doneWork();
    const v = valueOf(commands().goal());
    expect(v.verdict).toBe('unconfirmed');
    expect(v.structural.exhausted).toBe(true);
    expect(v.structural.detail).toContain('structurally complete');
    expect(v.contract).toEqual({ intent: 'Build the goal session', acceptanceCriteria: ['the session archives faithfully'] });
    expect(v.metEvent).toBeUndefined();
  });

  it('goalDoc appears once the goal doc is written to docs/ and named by the manifest', () => {
    seedGoal();
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'goal.md'), '# Goal\n\nGoal: Build the goal session\n\nSuccess criteria:\n- the session archives faithfully\n');
    writeDocsManifest(root, scanDocsDir(root));
    const v = valueOf(commands().goal());
    expect(v.goalDoc).toMatchObject({ name: 'goal', path: 'docs/goal.md' });
    expect(v.goalDoc!.sha).toMatch(/^[0-9a-f]{7}$/);
  });

  it('met once a HUMAN verdict is recorded — metEvent rides the view, goal-met is status-inert', () => {
    seedGoal();
    doneWork();
    const c = commands();
    valueOf(c.goalVerdict('met', 'criteria confirmed'));
    const v = valueOf(c.goal());
    expect(v.verdict).toBe('met');
    expect(v.goalStatus).toBe('done'); // goal-met does not change the status
    expect(v.metEvent).toMatchObject({ type: 'goal-met', decision: 'met' });
    expect(v.metEvent!.feedback).toBe('criteria confirmed');
  });
});

/** Narrow a CommandResult to its value (a failure here means the view was refused). */
function valueOf<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}`);
  return r.value;
}
