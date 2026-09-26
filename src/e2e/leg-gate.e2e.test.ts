import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { Store } from '../store/store.js';

/**
 * E2E — ONE READ, ONE LEG-GATE VERDICT (leg 12 task 14, AC-1).
 *
 * THE DISEASE, as the adversarial review found it: `ann next` printed `leg gate: MET` and,
 * two lines later, `leg gate UNMET: 4 done, 9 blocked` — the first from `legGateMet` (is the
 * leg's PREDECESSOR finished?), the second from the empty-ready-set branch (is the leg
 * ITSELF finished?). Two different facts wearing one label inside ONE read, so the
 * contradiction was invisible until someone read both lines.
 *
 * THIS FILE IS THE LIVE SHAPE. Not a leg-gate unit fixture: the same 13-child leg the
 * review's journey had — 4 done, 9 blocked, no ready task — read by the REAL `ann next`
 * over the REAL store, and the read's own TEXT is what is asserted on. The test cannot pass
 * while any second leg-gate verdict appears in that one read, whatever wording carries it.
 *
 * The fixture is written as a PRE-STATE (node.json + events.jsonl, the `fixtureProject`
 * precedent in whats-next.e2e.test.ts), not driven through the CLI: the 4 done children each
 * need captured commit evidence, and every `capture!` runs the allowlisted suite — a drive
 * would take minutes per child. Nothing about the shape is therefore ASSUMED: the test first
 * asserts the store derives exactly the shape it claims (4 done · 9 blocked · gate MET), and
 * `ann check` + `ann verify` are run over the same fixture so a shape the engine would
 * reject cannot pass as the fixture's proof.
 *
 * `npm run build` first — the CLI is spawned as `node dist/surface/cli.js`.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };
/** Pre-v9 createdAt → grandfathered at CHECK-REPORTING: the closed children carry their
 *  lifecycle events without a v18 conclusion, which is a store rule for concluded work
 *  the fixture is not about. */
const OLD = '2026-08-20';

const PREV = '01-leg';
const LEG = '02-leg';
const DONE_CHILDREN = 4;
const BLOCKED_CHILDREN = 9;

interface CliResult { code: number | null; stdout: string; stderr: string }
function cli(root: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json') },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r: CliResult): string => r.stdout + r.stderr;

const git = (root: string, args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
};

const ev = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ at: OLD, type, ...extra });
/** A CLOSED child: the whole lifecycle behind it, nothing for anyone to decide. */
const DONE = [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed')];
/** A BLOCKED child — exactly the live state: the entry gate is SUBMITTED and undecided, so
 *  the task derives `blocked` (nothing proposes it) while staying OPEN (the leg's counts
 *  and its gate still see it). */
const BLOCKED = [ev('created'), ev('submitted', { gate: 'grill' })];

function writeNode(root: string, id: string, events: Array<Record<string, unknown>>): void {
  const dir = join(root, '.ann', 'journey', 'legs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract: { intent: `the work of ${id}`, acceptanceCriteria: ['it is done'], workType: 'implementation' }, createdAt: OLD }));
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * THE LIVE-SHAPED FIXTURE: a leg with 4 done and 9 blocked children and NO ready task,
 * behind a FINISHED predecessor — so its own gate reads MET (the predecessor is done) while
 * the leg is unfinished (its children are not). That is the exact pair of facts that used to
 * be printed as two `leg gate` verdicts.
 *
 * `first: true` moves the same 13 children into the FIRST leg instead: the gate then has no
 * predecessor to read, and the two facts still have to keep their own labels.
 */
function liveShapedFixture(opts: { first?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-leggate-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);

  const leg = opts.first ? PREV : LEG;
  if (!opts.first) {
    writeNode(root, PREV, []);
    writeNode(root, `${PREV}/01-a`, DONE); // the predecessor FINISHED — the successor's gate is met
  }
  writeNode(root, leg, []);
  for (let i = 1; i <= DONE_CHILDREN; i++) writeNode(root, `${leg}/0${i}-a`, DONE);
  for (let i = DONE_CHILDREN + 1; i <= DONE_CHILDREN + BLOCKED_CHILDREN; i++) writeNode(root, `${leg}/${String(i).padStart(2, '0')}-b`, BLOCKED);

  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'the live-shaped fixture journey']);
  return root;
}

/** EVERY leg-gate verdict the text states, whatever the wording around it — a line that
 *  labels itself a leg gate and names MET/UNMET. The SET is the check: one read naming the
 *  same fact twice in two words is a FAILURE, and so is one naming two verdicts. */
const legGateVerdicts = (text: string): string[] =>
  text
    .split('\n')
    .filter((l) => /leg\s*gate/i.test(l))
    .flatMap((l) => l.match(/\b(MET|UNMET)\b/g) ?? []);

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ONE read, ONE leg-gate verdict — the live shape (leg 12 task 14, AC-1)', () => {
  beforeEach(() => { root = liveShapedFixture(); });

  it('4 done, 9 blocked behind a FINISHED predecessor: one read, one verdict, and the counts beside it', () => {
    // THE FIXTURE IS WHAT IT CLAIMS FIRST — the read below is only evidence if the store
    // derives the live shape from it (4 done · 9 blocked · no ready task · gate MET)
    const store = new Store(root);
    const gate = store.legGate(LEG);
    expect(gate).toMatchObject({ met: true, total: 13, done: 4, blocked: 9, open: 9, complete: false });
    expect(store.status(`${LEG}/01-a`)).toBe('done');
    expect(store.status(`${LEG}/05-b`)).toBe('blocked');
    expect(store.tasksOf(LEG).filter((t) => ['queued', 'active'].includes(store.status(t)))).toEqual([]); // no ready task

    const read = out(cli(root, ['next'])); // ── ONE READ ──

    // THE DEFECT, ASSERTED AGAINST: exactly one leg-gate verdict, and it is the one the
    // derivation gives. Two labels for two facts is fine; two VERDICTS for one is not.
    expect(legGateVerdicts(read)).toEqual(['MET']);
    expect(read).toContain('  leg gate: MET');
    expect(read).not.toContain('leg gate UNMET');

    // …and the leg's own incompleteness is stated as what it is, with the counts from the
    // SAME derivation (`done`/`blocked`/`open` off the one `legGate` call, never a recount)
    expect(read).toContain(`leg ${LEG} unfinished: ${gate.done} done, ${gate.blocked} blocked`);
    expect(read).toContain('advance: closure-needed');
    expect(read).not.toContain('advance: continue-leg'); // no ready task was invented

    // the read is a JOURNEY the engine accepts, so the shape is not an artefact of a broken
    // fixture: the same contradiction-free read over a traversal that reports no gate gaps
    expect(cli(root, ['check']).code).toBe(0);
    expect(out(cli(root, ['check']))).toContain('OK —');
    expect(out(cli(root, ['verify']))).toContain('verify: clean');
  });

  it('the same 13 children in the FIRST leg — the gate has no predecessor, the count line still keeps its own label', () => {
    root = liveShapedFixture({ first: true });
    const gate = new Store(root).legGate(PREV);
    expect(gate).toMatchObject({ met: true, done: 4, blocked: 9 }); // no predecessor ⇒ nothing holds the gate

    const read = out(cli(root, ['next'])); // ── ONE READ ──

    expect(legGateVerdicts(read)).toEqual(['MET']); // one verdict, whatever leg the gate reads
    expect(read).toContain(`leg ${PREV} unfinished: ${gate.done} done, ${gate.blocked} blocked`);
    expect(read).not.toContain('leg gate UNMET');
  });
});
