import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../store/store.js';
import { Approver, DaemonInteract, DaemonPromptRefused, StaleProposalRefused, whatsNext } from '../approve.js';
import { OperatorActionResult } from '../../flow/operator-action.js';

/**
 * THE DAEMON'S OPERATE LOOP (leg 11) at the unit grain: the human channel that REFUSES to
 * prompt (care a) and the single-flight that serialises the write (care b), plus the card's
 * read carrying the integrity blockers (care c). The HTTP round trip is the e2e's job
 * (`src/e2e/whats-next.e2e.test.ts`); this file pins the pieces the e2e cannot reach —
 * the `ask` / second-`decide` / malformed-branch refusals and the claim/release rule — and
 * runs the approve in-process over a fixture journey.
 */

const REPO = process.cwd();
let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });
/** An `implementation` contract → the EMPTY chain (the runner does the work). The default
 *  chain is the SHAPING one, whose steps would call a provider. */
const TASK_CONTRACT = { intent: 'Build the thing', acceptanceCriteria: ['AC-1'], workType: 'implementation' };
const TASK = '01-leg/01-a';
const NEXT = `next task: ${TASK} (queued)`;

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = TASK_CONTRACT, createdAt = '2026-08-27'): void {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract, createdAt }));
  if (events.length) writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const git = (...args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};
const types = (c: Store, id: string): string[] => c.events(id).map((e) => e.type);
/** A grill-accepted queued task — the frontmost-ready. */
const readyTask = (): void => {
  writeNode('01-leg', []);
  writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
};
/** A committed docs/ with one manifest'd doc — the tracked-change fixtures dirty it. */
const docs = (): void => {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nthe committed bytes\n');
  writeFileSync(join(root, 'docs', 'manifest.json'), JSON.stringify({ thing: 'docs/thing.md' }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-qm', 'the fixture journey');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-approve-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  // the approver builds the CLI's own deps (the provider adapter reads the registry):
  // ANN_CONFIG keeps the user overlay out of the test, exactly as the CLI would.
  process.env.ANN_CONFIG = join(root, '.e2e-config.json');
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git('init', '-q');
  git('config', 'user.name', 'unit');
  git('config', 'user.email', 'unit@ann.test');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('care a — the daemon never prompts: every prompt but the ONE approve refuses by name', () => {
  const derive = () => ({ leg: '01-leg', action: 'continue-leg', detail: NEXT } as const);

  it('answers the approve the request carries — exactly once', async () => {
    const ch = new DaemonInteract(undefined, derive);
    await ch.present('the ADVANCE card');
    expect(ch.presented).toEqual(['the ADVANCE card']); // the card is echoed, never prompted
    expect(await ch.decide('approve executing the derived advance?', ['approve', 'decline'])).toBe('approve');
    const err = await ch.decide('approve again?', ['approve', 'decline']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(DaemonPromptRefused);
    expect((err as DaemonPromptRefused).code).toBe('daemon-prompt');
    expect((err as Error).message).toContain('a second decision');
  });

  it("a gate the frame wants to decide LIVE refuses — 'no submission: the UI must submit first'", async () => {
    const ch = new DaemonInteract(undefined, derive);
    const err = await ch.decide("decide gate 'grill' for 01-leg/01-a", ['accept', 'reject']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(DaemonPromptRefused);
    expect((err as Error).message).toContain('this gate has no submission — the UI must submit first; the daemon never prompts');
    expect((err as Error).message).toContain("decide gate 'grill' for 01-leg/01-a"); // which prompt it was
  });

  it('a step asking the daemon anything refuses too (ask · research) — never a fabricated answer', async () => {
    const ch = new DaemonInteract(undefined, derive);
    await expect(ch.ask('why is the gate rejected?')).rejects.toThrow(/never prompts/);
    await expect(ch.research(['the topic'])).rejects.toThrow(DaemonPromptRefused);
  });

  it('a proposal the logs no longer derive refuses AT the approve, carrying both sides', async () => {
    const ch = new DaemonInteract({ action: 'continue-leg', detail: 'next task: 01-leg/99-ghost (queued)' }, derive);
    const err = (await ch.decide('approve?', ['approve', 'decline']).catch((e: Error) => e)) as StaleProposalRefused;
    expect(err).toBeInstanceOf(StaleProposalRefused);
    expect(err.code).toBe('stale-proposal');
    expect(err.derivation.detail).toBe('next task: 01-leg/99-ghost (queued)'); // what the human approved
    expect(err.reDerivation.detail).toBe(NEXT); // what the logs derive now
    expect(err.message).toContain('nothing executed');
  });
});

describe('care b — the single-flight: ONE approve at a time', () => {
  it('the synchronous claim admits one and refuses the rest until release', () => {
    const a = new Approver(root);
    expect(a.claim()).toBe(true); // the first request takes the slot (before its first await)
    expect(a.claim()).toBe(false); // a concurrent one is refused — never queued, never interleaved
    expect(a.claim()).toBe(false);
    a.release();
    expect(a.claim()).toBe(true); // released on every path, so the next approve proceeds
    a.release();
  });
});

describe("care c — the card's read names the integrity blockers (and stops offering the approve)", () => {
  it('a clean journey is executable; a dirty one is not — the blocker is NAMED', () => {
    readyTask();
    docs();
    const clean = whatsNext(root);
    expect(clean.advance).toEqual({ leg: '01-leg', action: 'continue-leg', detail: NEXT });
    expect(clean.frontmost).toEqual({ leg: '01-leg', task: TASK, status: 'queued' });
    expect(clean.legGate).toEqual({ met: true });
    expect(clean.integrity).toEqual({ clean: true, blockers: [] });
    expect(clean.executable).toBe(true);

    // an uncommitted TRACKED docs change: the op the operator owes is named by the blocker
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    const dirty = whatsNext(root);
    expect(dirty.advance.action).toBe('continue-leg'); // the derivation is unchanged…
    expect(dirty.integrity.clean).toBe(false); // …but the card CANNOT claim it can advance
    expect(dirty.integrity.blockers.some((b) => b.includes('uncommitted tracked change:') && b.includes('docs/thing.md'))).toBe(true);
    expect(dirty.executable).toBe(false);
  });

  it('a boundary derivation (advance-leg) is never executable', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')], { intent: 'the done work', acceptanceCriteria: ['done'] }, '2026-08-20');
    writeNode('02-leg', []);
    docs();
    const v = whatsNext(root);
    expect(v.advance.action).toBe('advance-leg');
    expect(v.advance.detail).toContain('02-leg'); // the empty front leg — authored work, not machine work
    expect(v.executable).toBe(false);
  });
});

describe("the approve in-process — the operator action's own rules, carried through (AC-1/AC-2)", () => {
  it('a dirty state refuses FIRST with the named blockers and writes NOTHING', async () => {
    readyTask();
    docs();
    appendFileSync(join(root, 'docs', 'thing.md'), '\nhand edit\n');
    const out = await new Approver(root).approve();
    expect(out.status).toBe(409);
    const error = out.body.error as { code: string; message: string };
    expect(error.code).toBe('refused-integrity');
    expect(error.message).toContain('nothing executed');
    expect((out.body.blockers as string[]).some((b) => b.includes('uncommitted tracked change'))).toBe(true);
    expect(types(new Store(root), TASK)).toEqual(['created', 'submitted', 'confirmed']); // zero writes
  });

  it('a clean state runs the frontmost-ready through the FRAME — activate + the verify wait, nothing else', async () => {
    readyTask();
    docs();
    const out = await new Approver(root).approve({ action: 'continue-leg', detail: NEXT });
    expect(out.status).toBe(200);
    const value = out.body.value as OperatorActionResult;
    expect(value.stop).toBe('advanced');
    expect(value.frontmost?.task).toBe(TASK);
    expect(value.frame?.stop).toBe('blocked-waiting');
    expect(value.landing).toEqual({ task: TASK, where: 'awaiting-runner', gate: 'confirm', frameStop: 'blocked-waiting' });
    expect(types(new Store(root), TASK)).toEqual(['created', 'submitted', 'confirmed', 'activated', 'waiting']);
  });
});
