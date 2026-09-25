/**
 * 12/20 — THE ENGINE COMMITS ITS OWN JOURNEY WRITES.
 *
 * The two hard lines (only `.ann/journey/**`; staged by name from the journal, never a
 * `git status` sweep) and the fail-open/fail-closed split, each proved against a REAL
 * git in a temp repo — never the repo this suite runs in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitJourneyWrites, commitMessage, defaultCommitEnv, type CommitEnv } from '../commit-journey.js';
import { noteWrite, takeWritten, clearWritten, type WriteRecord } from '../../store/write-journal.js';

let root: string;
const journeyDir = () => join(root, '.ann', 'journey');
const EV = () => join(journeyDir(), 'legs', '01-leg', '01-a', 'events.jsonl');

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

/** A real, disposable, git-backed project. */
function repo(): string {
  root = mkdtempSync(join(tmpdir(), 'ann-commit-'));
  mkdirSync(join(journeyDir(), 'legs', '01-leg', '01-a'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'unit']);
  git(root, ['config', 'user.email', 'unit@ann.test']);
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

/** The subject + the paths the LAST commit actually carries. */
function lastCommit(r: string): string[] {
  return git(r, ['show', '--name-only', '--format=%s', 'HEAD']).split('\n').filter(Boolean);
}

/** A git that answers everything except the verb named — the refusing-repo seam. */
function refusing(verb: string, warns: string[]): CommitEnv {
  return {
    git(cwd, args) {
      return args[0] === verb ? undefined : defaultCommitEnv.git(cwd, args);
    },
    warn(m) { warns.push(m); },
  };
}

const rec = (path: string, node: string, type: string, gate?: string): WriteRecord =>
  ({ path, node, type, ...(gate ? { gate } : {}) });

beforeEach(() => { repo(); });
afterEach(() => { clearWritten(root); rmSync(root, { recursive: true, force: true }); });

describe('12/20 — the commit subject is DERIVED from what landed', () => {
  it('reads exactly as the hand-written history does', () => {
    expect(commitMessage([rec('/p/events.jsonl', '12-operate-loop/20-x', 'confirmed', 'grill')], 'ianluo'))
      .toBe('journey: 12-operate-loop/20-x grill ACCEPTED (ianluo)');
  });

  it('a bare contract write (a spawned leg carries no events) reads as the spawn', () => {
    expect(commitMessage([rec('/p/node.json', '01-leg', 'node.json')], 'ianluo'))
      .toBe('journey: 01-leg spawn (ianluo)');
  });

  it('a seed says spawn ONCE, not once per file', () => {
    const msg = commitMessage([
      rec('/p/node.json', '01-goal', 'node.json'),
      rec('/p/events.jsonl', '01-goal', 'created'),
      rec('/p/events.jsonl', '01-goal', 'completed'),
    ], 'ianluo');
    expect(msg).toBe('journey: 01-goal spawn · completed (ianluo)');
  });

  it('one clause per node, in write order', () => {
    const msg = commitMessage([
      rec('/p/a.jsonl', '01-leg/01-a', 'submitted', 'confirm'),
      rec('/p/b.jsonl', '01-leg/01-b', 'evidence'),
      rec('/p/a.jsonl', '01-leg/01-a', 'confirmed', 'confirm'),
    ], 'ianluo');
    expect(msg).toBe('journey: 01-leg/01-a confirm submitted · confirm ACCEPTED; 01-leg/01-b evidence (ianluo)');
  });
});

describe('12/20 — AC-2: only the journey, never code', () => {
  it('drops a path outside the journey dir, and touches nothing', () => {
    writeFileSync(join(root, 'src-x.ts'), 'export const x = 1;\n');
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      records: [rec(join(root, 'src-x.ts'), '', 'created')],
    });
    expect(out).toEqual({ committed: false, paths: [] });
    // still untracked and uncommitted — the engine never staged it
    expect(git(root, ['status', '--porcelain'])).toContain('?? src-x.ts');
    expect(git(root, ['log', '--oneline'])).not.toContain('src-x');
  });

  it('drops the archive snapshot too — `.ann/archive/**` is not `.ann/journey/**`', () => {
    const snap = join(root, '.ann', 'archive', 'sessions', 'ts-slug', 'journey', 'legs', 'x', 'node.json');
    mkdirSync(join(snap, '..'), { recursive: true });
    writeFileSync(snap, '{}\n');
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', records: [rec(snap, 'x', 'node.json')],
    });
    expect(out.committed).toBe(false);
    expect(out.paths).toEqual([]);
  });
});

describe('12/20 — AC-1: staged by name, from the journal', () => {
  it('commits exactly the journaled path; an unrelated dirty file AND an unrelated STAGED file survive', () => {
    writeFileSync(EV(), '{"at":"2026-09-25","type":"created"}\n');
    writeFileSync(join(root, 'not-mine.txt'), 'another agent is mid-edit\n');
    writeFileSync(join(root, 'staged.txt'), 'someone staged this\n');
    git(root, ['add', 'staged.txt']);

    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      records: [rec(EV(), '01-leg/01-a', 'created')],
    });

    expect(out.committed).toBe(true);
    expect(lastCommit(root)).toEqual([
      'journey: 01-leg/01-a spawn (unit)',
      '.ann/journey/legs/01-leg/01-a/events.jsonl',
    ]);
    // the already-staged file was NOT carried in, and is still staged for its owner
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('staged.txt');
    expect(existsSync(join(root, 'not-mine.txt'))).toBe(true);
  });

  it('makes no empty commit when the journaled path is already committed', () => {
    writeFileSync(EV(), '{}\n');
    git(root, ['add', '.ann/journey/legs/01-leg/01-a/events.jsonl']);
    git(root, ['commit', '-qm', 'already']);
    const before = git(root, ['rev-parse', 'HEAD']);
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', records: [rec(EV(), '01-leg/01-a', 'created')],
    });
    expect(out.committed).toBe(false);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(before);
  });
});

describe('12/20 — AC-3: fail-open on the commit', () => {
  it('a repo that refuses the commit WARNS BY NAME, never throws, and leaves the record on disk', () => {
    writeFileSync(EV(), '{"at":"2026-09-25","type":"created"}\n');
    const warns: string[] = [];
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      records: [rec(EV(), '01-leg/01-a', 'created')],
      env: refusing('commit', warns),
    });
    expect(out.committed).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('the commit failed');
    expect(warns[0]).toContain('git commit -m');           // the by-hand recipe
    expect(readFileSync(EV(), 'utf8')).toContain('created'); // the truth is the appended event
  });

  it('a repo that refuses `git add` also warns by name', () => {
    writeFileSync(EV(), '{}\n');
    const warns: string[] = [];
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      records: [rec(EV(), '01-leg/01-a', 'created')],
      env: refusing('add', warns),
    });
    expect(out.committed).toBe(false);
    expect(warns[0]).toContain("'git add' failed");
  });

  it('a project with NO git repository skips SILENTLY — there is nothing left dirty', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true });
    writeFileSync(EV(), '{}\n');
    const warns: string[] = [];
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      records: [rec(EV(), '01-leg/01-a', 'created')],
      env: { git: defaultCommitEnv.git, warn: (m) => warns.push(m) },
    });
    expect(out.committed).toBe(false);
    expect(warns).toEqual([]);
  });
});

describe('12/20 — the skips', () => {
  it('with nothing journaled it does not ask git anything', () => {
    const calls: string[][] = [];
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', records: [],
      env: { git: (_c, args) => { calls.push(args); return ''; }, warn: () => {} },
    });
    expect(out).toEqual({ committed: false, paths: [] });
    expect(calls).toEqual([]);
  });

  it('ANN_NO_COMMIT opts out — the engine must not write history mid-assertion', () => {
    writeFileSync(EV(), '{}\n');
    process.env.ANN_NO_COMMIT = '1';
    try {
      const out = commitJourneyWrites({
        root, journeyDir: journeyDir(), who: 'unit', records: [rec(EV(), '01-leg/01-a', 'created')],
      });
      expect(out.committed).toBe(false);
      expect(out.paths).toEqual([EV()]);
    } finally {
      delete process.env.ANN_NO_COMMIT;
    }
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe('baseline'); // nothing new committed
  });

  it('the default journal is TAKEN — a long-lived process never re-commits what it committed', () => {
    writeFileSync(EV(), '{}\n');
    noteWrite(root, rec(EV(), '01-leg/01-a', 'created'));
    const first = commitJourneyWrites({ root, journeyDir: journeyDir(), who: 'unit' });
    expect(first.committed).toBe(true);
    // same call again: the journal is empty, so there is nothing to do
    const second = commitJourneyWrites({ root, journeyDir: journeyDir(), who: 'unit' });
    expect(second).toEqual({ committed: false, paths: [] });
    expect(takeWritten(root)).toEqual([]);
  });
});

describe('12/20 — the write journal', () => {
  it('dedupes a re-write of the same path, type and gate — one file, said once', () => {
    noteWrite(root, rec('/p/events.jsonl', 'a', 'confirmed', 'grill'));
    noteWrite(root, rec('/p/events.jsonl', 'a', 'confirmed', 'grill'));
    noteWrite(root, rec('/p/events.jsonl', 'a', 'confirmed', 'confirm'));
    expect(takeWritten(root)).toHaveLength(2);
  });

  it('take CLEARS: what was committed is never committed twice', () => {
    noteWrite(root, rec('/p/events.jsonl', 'a', 'created'));
    expect(takeWritten(root)).toHaveLength(1);
    expect(takeWritten(root)).toEqual([]);
  });
});
