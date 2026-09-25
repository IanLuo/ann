import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * E2E — THE DECISION RECORD through the REAL CLI binary (leg 12 task 11).
 *
 * The unit suites pin the derivation (store/__tests__/decisions.test.ts) and the readers
 * (commands · frame · the surface handlers). THIS suite proves the wiring a human meets:
 * `ann decisions <id>` in both renderings, the AC-1 refusal ROUND-TRIPPING as a named
 * error with ZERO writes on disk, and AC-5's no-history-rewrite promise — a LEGACY tail
 * whose whys were never recorded still reads, with the gaps NAMED rather than hidden.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

interface CliResult { code: number | null; stdout: string; stderr: string; }
function cli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json'), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r: CliResult) => r.stdout + r.stderr;

let root: string;
const legs = () => join(root, '.ann', 'journey', 'legs');
const eventsFile = (id: string) => join(legs(), id, 'events.jsonl');
const TASK = '01-leg/01-a';

function writeNode(id: string, events: Array<Record<string, unknown>>, questions: unknown[] = [], contract: unknown = { intent: 'do the thing', acceptanceCriteria: ['it is done'], targetAreas: ['src/store'] }) {
  const dir = join(legs(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, openQuestions: questions, createdAt: '2026-09-01' }));
  writeFileSync(eventsFile(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-01', type, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-e2e-dec-'));
  mkdirSync(legs(), { recursive: true });
  // spawn/append read the project's rules home (the vocab registry) — mirror the repo's
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  mkdirSync(join(legs(), '01-leg'), { recursive: true });
  writeFileSync(join(legs(), '01-leg', 'node.json'), JSON.stringify({ id: '01-leg', contract: { intent: 'the leg', acceptanceCriteria: ['done'] }, createdAt: '2026-09-01' }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('ann decisions — the choice points, through the real binary (AC-2/AC-4)', () => {
  it('reads all four kinds in order, and --json emits the SAME value the text renders', () => {
    writeNode(TASK, [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill', feedback: 'the contract mirrors the plan', note: 'accepted (ianluo)' }),
      ev('evidence', { answers: [{ id: 'Q1', answer: 'the store, not a cache', provenance: 'discussed' }] }),
      ev('gate-revised', { gate: { old: 'confirm', new: 'grill' }, note: 'terms moved (ianluo)' }),
      ev('superseded', { successor: { name: 'the-old-doc', path: 'docs/old.md' }, note: 'replaced (ianluo)' }),
    ], [{ id: 'Q1', question: 'which way?', blocking: true }]);

    const t = cli(root, ['decisions', TASK]);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('DECISIONS — 01-leg/01-a (4 choice points)');
    expect(t.stdout).toContain('accepted at the grill gate · by ianluo');
    expect(t.stdout).toContain('why: the contract mirrors the plan');
    expect(t.stdout).toContain('Q1 resolved: which way? · how: discussed · HIGH-IMPACT');
    expect(t.stdout).toContain('gate terms revised: confirm → grill');
    expect(t.stdout).toContain('artifact superseded: the-old-doc');
    // only the gate decision and the resolution HAVE a why channel (feedback · answers[]);
    // the other two kinds' free text is PROVENANCE, so they read as honestly absent rather
    // than having a reason manufactured out of the author's name (AC-4)
    expect(t.stdout).toContain('WHY MISSING (2)');
    expect(t.stdout).toContain('gate terms revised: confirm → grill — NO WHY RECORDED');
    expect(t.stdout).toContain('artifact superseded: the-old-doc — NO WHY RECORDED');

    const j = cli(root, ['decisions', TASK, '--json']);
    expect(j.code).toBe(0);
    const v = JSON.parse(j.stdout) as { id: string; decisions: Array<Record<string, unknown>>; missingWhy: string[] };
    expect(v.id).toBe(TASK);
    expect(v.decisions.map((d) => d.kind)).toEqual(['gate', 'open-question', 'gate-revised', 'artifact']);
    expect(v.missingWhy).toHaveLength(2);
    // the text rendering is a pure function of that JSON value (one value, two renderings)
    for (const d of v.decisions) expect(t.stdout).toContain(String(d.what));
  });

  it('AC-5 — a LEGACY tail with no recorded whys still reads, with EVERY gap named', () => {
    writeNode(TASK, [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }),        // the 12/08-era bare accept
      ev('submitted', { gate: 'confirm' }),
      ev('confirmed', { gate: 'confirm' }),
    ]);
    const r = cli(root, ['decisions', TASK]);
    expect(r.code).toBe(0); // the record reads — it is not an error to have no reason
    expect(r.stdout).toContain('DECISIONS — 01-leg/01-a (2 choice points)');
    expect(r.stdout).toContain('why: (MISSING — nothing was recorded)');
    expect(r.stdout).toContain('WHY MISSING (2) — the reason was never recorded; it is not inferred here:');
    expect(r.stdout).toContain('accepted at the grill gate — NO WHY RECORDED');
    expect(r.stdout).toContain('accepted at the confirm gate — NO WHY RECORDED');
  });

  it('a node with nothing decided reads as an honest nothing (never an invented choice)', () => {
    writeNode(TASK, [ev('created')]);
    const r = cli(root, ['decisions', TASK]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('(0 choice points)');
    expect(r.stdout).toContain('nothing decided yet');
  });
});

describe('AC-1 — the why is required where it is lost, at the CLI (zero writes on refusal)', () => {
  it('a bare confirm accept is REFUSED by name, exit 1, and NOTHING is written', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' })]);
    const before = readFileSync(eventsFile(TASK), 'utf8');
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept']);
    expect(r.code).toBe(1);
    expect(out(r)).toContain('why-required');
    expect(out(r)).toContain('confirm accept needs a why');
    // the exact gesture that would work is named
    expect(out(r)).toContain(`ann gate! ${TASK} confirm accept`);
    // ZERO WRITES — the events file is byte-identical
    expect(readFileSync(eventsFile(TASK), 'utf8')).toBe(before);

    // with a why it lands ON the decision, and the read finds it
    const ok = cli(root, ['gate!', TASK, 'confirm', 'accept', 'the work is done and the evidence is in']);
    expect(ok.code).toBe(0);
    const after = readFileSync(eventsFile(TASK), 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('the work is done and the evidence is in');
    expect(cli(root, ['decisions', TASK]).stdout).toContain('why: the work is done and the evidence is in');
  });

  it('the ENTRY gate is untouched — a bare grill accept still works (the rule is bounded to the terminal gate)', () => {
    writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' })]);
    const r = cli(root, ['gate!', TASK, 'grill', 'accept']);
    expect(r.code).toBe(0);
    expect(readFileSync(eventsFile(TASK), 'utf8')).toContain('"gate":"grill"');
  });
});
