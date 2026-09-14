import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { integritySnapshot, whatsNext } from '../approve.js';

/**
 * THE CARD'S READ IS FAST BECAUSE IT DOES NOT RUN THE PRE-CHECK (leg 12/07
 * `07-implementation-responsive-card`) — asserted AT THE CALL, not at the clock.
 *
 * `operatorIntegrityBlockers` IS the full fail-closed pre-check (commands.check() + the S4
 * validators + verify + the docs manifest + a git subprocess). MEASURED on the live journey:
 * 3.32 / 3.31 / 3.30s per `GET /api/whatsnext`, while every other read is 5–7ms — the page
 * blocked ~3.3s per load because `whatsNext()` ran it synchronously on every read.
 *
 * The spy is the DETERMINISTIC form of "the read is in the fast class": a wall-clock assertion
 * would depend on the machine, while "the read does not call the pre-check" cannot pass while
 * the pre-check is back on the read path. The WRITE's own call cannot be seen through this spy
 * (the action calls the function through a module-internal binding) — its guard is pinned by
 * its own tests, which this task did not touch.
 */
const spy = vi.hoisted(() => ({ preChecks: 0 }));
vi.mock('../../flow/operator-action.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../flow/operator-action.js')>();
  return {
    ...actual,
    operatorIntegrityBlockers: (...args: Parameters<typeof actual.operatorIntegrityBlockers>) => {
      spy.preChecks += 1;
      return actual.operatorIntegrityBlockers(...args);
    },
  };
});

const REPO = process.cwd();
let root: string;
const dir = (id: string): string => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ at: '2026-08-27', type, ...extra });
const TASK = '01-leg/01-a';
/** An `implementation` contract → the EMPTY chain (no provider is ever called). */
const CONTRACT = { intent: 'Build the thing', acceptanceCriteria: ['AC-1'], workType: 'implementation' };
const git = (...args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};
function writeNode(id: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract: CONTRACT, createdAt: '2026-08-27' }));
  writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
/** A committed docs/ home + a grill-accepted queued task (the frontmost-ready). */
function readyJourney(): void {
  writeNode('01-leg', []);
  writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe committed bytes\n');
  writeFileSync(join(root, 'docs', 'manifest.json'), JSON.stringify({ thing: 'docs/thing.md' }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-qm', 'the fixture journey');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-wn-read-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  process.env.ANN_CONFIG = join(root, '.e2e-config.json');
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git('init', '-q');
  git('config', 'user.name', 'unit');
  git('config', 'user.email', 'unit@ann.test');
  spy.preChecks = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the card's read never runs the integrity pre-check (leg 12/07)", () => {
  it('whatsNext() calls it ZERO times — on a clean tree and on a dirty one', () => {
    readyJourney();
    const clean = whatsNext(root);
    expect(spy.preChecks, 'the read ran the pre-check — the ~3.3s page load is back').toBe(0);
    expect(clean.integrity.state).toBe('unchecked');
    expect(clean.advance.action).toBe('continue-leg');

    // a dirty tree makes no difference: the read does not look (the verdict is not its job)
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    whatsNext(root);
    expect(spy.preChecks).toBe(0);
  });

  it('the LAZY snapshot calls it EXACTLY once — the verdict the card displays', () => {
    readyJourney();
    spy.preChecks = 0;
    const snap = integritySnapshot(root);
    expect(spy.preChecks).toBe(1);
    expect(snap).toEqual({ clean: true, blockers: [] });

    // …and it is the REAL pre-check: dirty the tracked doc and the blocker is named
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    const dirty = integritySnapshot(root);
    expect(dirty.clean).toBe(false);
    expect(dirty.blockers.some((b) => b.includes('uncommitted tracked change:') && b.includes('docs/thing.md'))).toBe(true);
  });

  // The WRITE's own call is NOT observable through this spy — `runOperatorAction` calls the
  // function through its module-internal binding, not through this module's namespace — so the
  // guard is pinned where it always was, by its own tests: `approve.test.ts`'s "a dirty state
  // refuses FIRST with the named blockers and writes NOTHING" (zero writes) and the e2e's
  // refused-integrity round trip. THE GUARD IS UNCHANGED; this file only proves the READ moved.
});
