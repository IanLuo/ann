import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * E2E — THE HALF ACCEPT through the REAL CLI binary (leg 12 task 12).
 *
 * The unit suites pin the gesture's refusals and the close rule; THIS proves what a human
 * meets: the two flags parse at the CLI, the refusal ROUND-TRIPS as a named error with ZERO
 * writes on disk, and the record reads as MOVED — the successor on the accept decision, the
 * ACs named as transferred, and never "every AC claimed".
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

interface CliResult { code: number | null; stdout: string; stderr: string; }
function cli(root: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json') },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r: CliResult) => r.stdout + r.stderr;

let root: string;
const legs = () => join(root, '.ann', 'journey', 'legs');
const eventsFile = (id: string) => join(legs(), id, 'events.jsonl');
const TASK = '01-leg/01-a';
const NEXT = '01-leg/02-b';
const C3 = { intent: 'do three things', acceptanceCriteria: ['the first is done', 'the second is done', 'the third is done'] };
const SCOPE = 'AC-2: the second is done\nAC-3: the third is done';

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = C3) {
  const dir = join(legs(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-09-01' }));
  if (events.length) writeFileSync(eventsFile(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-01', type, ...extra });
const atConfirm = () =>
  writeNode(TASK, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' })]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-e2e-xfer-'));
  mkdirSync(legs(), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  writeNode('01-leg', [], C3);
  writeNode(NEXT, [ev('created')]);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the half accept, at the CLI (AC-1/AC-2)', () => {
  it('refuses an unknown successor BY NAME, with ZERO writes on disk', () => {
    atConfirm();
    const before = readFileSync(eventsFile(TASK), 'utf8');
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept', 'the rest moves', '--transfer', '01-leg/ghost', '--scope', SCOPE]);
    expect(r.code).toBe(1);
    expect(out(r)).toContain('transfer-no-target');
    expect(out(r)).toContain('F-AC16');
    expect(out(r)).toContain('spawn the successor first'); // the exact gesture that would work
    expect(readFileSync(eventsFile(TASK), 'utf8')).toBe(before);
  });

  it('the flags must go together, and a lone one is a usage error (nothing written)', () => {
    atConfirm();
    const before = readFileSync(eventsFile(TASK), 'utf8');
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept', 'the rest moves', '--transfer', NEXT]);
    expect(r.code).toBe(2);
    expect(out(r)).toContain('go together');
    expect(readFileSync(eventsFile(TASK), 'utf8')).toBe(before);
  });

  it('ONE gesture lands the accept + the transfer, and the record reads MOVED everywhere', () => {
    atConfirm();
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept', 'the first half landed; the rest moves with it', '--transfer', NEXT, '--scope', SCOPE]);
    expect(r.code).toBe(0);
    const tail = readFileSync(eventsFile(TASK), 'utf8');
    expect(tail).toContain('"type":"transferred"');
    expect(tail).toContain(`"target":"${NEXT}"`);

    // the read: the conclusion names the successor and NEVER claims the ACs were met
    const brief = cli(root, ['brief', TASK]);
    expect(brief.code).toBe(0);
    expect(brief.stdout).toContain('TRANSFERRED (moved to a successor — not claimed as met)');
    expect(brief.stdout).toContain(`AC-2 → ${NEXT}`);
    expect(brief.stdout).not.toContain('every AC claimed');
    // the ONE AC still owed is named, and the two that MOVED are not among the gaps
    expect(brief.stdout).toContain('UNCLAIMED: AC-1');
    expect(brief.stdout).not.toContain('AC-1, AC-2');

    // the choices: the accept carries the why AND the successor it moved the scope to
    const dec = cli(root, ['decisions', TASK]);
    expect(dec.code).toBe(0);
    expect(dec.stdout).toContain('why: the first half landed; the rest moves with it');
    expect(dec.stdout).toContain(`scope moved to ${NEXT}`);

    // the close is NOT promised: the evidence is still owed, and THAT is the named blocker
    // (a moved AC is no longer a reason to refuse — the ACs left `unclaimed`)
    expect(brief.stdout).toContain('close: REFUSED now — no-evidence');
    // and the journey's own integrity check is silent — the transfer is a legal record
    expect(cli(root, ['check']).stdout).not.toContain('F-AC16');
  });

  it('the WHY is required first — --transfer cannot smuggle a silent accept through', () => {
    atConfirm();
    const before = readFileSync(eventsFile(TASK), 'utf8');
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept', '', '--transfer', NEXT, '--scope', SCOPE]);
    expect(r.code).toBe(1);
    expect(out(r)).toContain('why-required');
    expect(readFileSync(eventsFile(TASK), 'utf8')).toBe(before);
  });

  it('a transfer to another LEG is allowed — the format target is a leg/task id', () => {
    atConfirm();
    writeNode('02-other', [], C3);
    writeNode('02-other/01-c', [ev('created')]);
    const r = cli(root, ['gate!', TASK, 'confirm', 'accept', 'the remainder belongs with the next leg', '--transfer', '02-other/01-c', '--scope', SCOPE]);
    expect(r.code).toBe(0);
    expect(readFileSync(eventsFile(TASK), 'utf8')).toContain('"target":"02-other/01-c"');
    expect(cli(root, ['brief', TASK]).stdout).toContain('AC-3 → 02-other/01-c');
  });
});
