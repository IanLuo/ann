/**
 * 12/20 — THE ENGINE COMMITS ITS OWN JOURNEY WRITES.
 *
 * The two hard lines (only `.ann/journey/**`; staged by name from the journal, never a
 * `git status` sweep) and the fail-open/fail-closed split, each proved against a REAL
 * git in a temp repo — never the repo this suite runs in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { commitJourneyWrites, commitMessage, defaultCommitEnv, engineWriteDirs, neverStaged, type CommitEnv } from '../commit-journey.js';
import { noteWrite, takeWritten, clearWritten, type WriteRecord } from '../../store/write-journal.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';
import { configPath } from '../../abilities/llm/config.js';
import { Store } from '../../store/store.js';

let root: string;
const journeyDir = () => join(root, '.ann', 'journey');
const EV = () => join(journeyDir(), 'legs', '01-leg', '01-a', 'events.jsonl');
/** EVERY engine tree, as the real bindings pass them (handlers.ts, service.ts). */
const dirs = () => engineWriteDirs(root);

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

/** EVERY path the last commit touches, by status line — `--name-only` collapses a rename
 *  to its destination, and a move (the archive's) is exactly what this reads. */
function lastTouched(r: string): string[] {
  return git(r, ['show', '--name-status', '--format=%s', 'HEAD'])
    .split('\n')
    .slice(1)
    .flatMap((l) => l.split('\t').slice(1))
    .filter(Boolean);
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

  it('drops a tree NO caller named — the scope is the list the caller passes, never more', () => {
    const snap = join(root, '.ann', 'archive', 'sessions', 'ts-slug', 'journey', 'legs', 'x', 'node.json');
    mkdirSync(join(snap, '..'), { recursive: true });
    writeFileSync(snap, '{}\n');
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', records: [rec(snap, 'x', 'node.json')],
    });
    expect(out.committed).toBe(false);
    expect(out.paths).toEqual([]);
  });

  /* 12/20 SAID: "the archive snapshot … is a deliverable of the session (the operator
   * commits it) and, being out of scope, is invisible to the archive's own uncommitted
   * guard." 12/21 REVERSES THAT READING, NAMED (AC-2), and this test is the reversal:
   * half a rename is not a smaller commit, it is a dirty tree. The real bindings pass
   * `engineWriteDirs(root)`, which names `.ann/archive` — so the snapshot is IN scope for
   * every gesture, and the archive's two halves land together. */
  it('12/21 (reversing 12/20): `.ann/archive/**` IS in scope for the bindings that name it', () => {
    const snap = join(root, '.ann', 'archive', 'sessions', 'ts-slug', 'journey', 'legs', 'x', 'node.json');
    mkdirSync(join(snap, '..'), { recursive: true });
    writeFileSync(snap, '{}\n');
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', extraDirs: dirs(),
      records: [rec(snap, 'x', 'node.json')],
    });
    expect(out.committed).toBe(true);
    expect(lastCommit(root)).toEqual([
      'journey: x spawn (unit)',
      '.ann/archive/sessions/ts-slug/journey/legs/x/node.json',
    ]);
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

describe('12/21 — AC-1: the journal records WRITES, not events', () => {
  it('a writer that lands NO event is journaled at ITS write site — the manifest, and nothing else happened', () => {
    // The command under the pin is `ann docs --write`: it writes a tracked file and
    // appends NO event. The old journal was noted at the EVENT-write site, so it was
    // structurally blind to this — the case AC-1 names.
    const p = writeDocsManifest(root, scanDocsDir(root));
    expect(takeWritten(root)).toEqual([{ path: p, node: '', type: 'docs-manifest', scope: 'docs' }]);
  });

  it('…and the gesture COMMITS it: the tree is left clean with no event and no hand-commit', () => {
    writeDocsManifest(root, scanDocsDir(root));
    const out = commitJourneyWrites({ root, journeyDir: journeyDir(), who: 'unit', extraDirs: dirs() });
    expect(out.committed).toBe(true);
    expect(out.message).toBe('docs: manifest (unit)');
    expect(lastCommit(root)).toEqual(['docs: manifest (unit)', 'docs/manifest.json']);
    expect(git(root, ['status', '--porcelain'])).toBe(''); // the atomic tmp is gone, the write is committed
  });

  it('commits a write made THROUGH the `rules → .ann/rules` symlink — git refuses a pathspec beyond one', () => {
    mkdirSync(join(root, '.ann', 'rules', 'check'), { recursive: true });
    symlinkSync('.ann/rules', join(root, 'rules'));
    const p = join(root, 'rules', 'check', 'rules.json');
    writeFileSync(p, '{}\n');
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit', extraDirs: dirs(),
      records: [{ path: p, node: '', type: 'rules-registry', scope: 'rules' }],
    });
    expect(out.committed).toBe(true);
    expect(out.paths).toEqual([p]); // reported as the writer wrote it…
    expect(lastCommit(root)).toEqual(['rules: rules registry (unit)', '.ann/rules/check/rules.json']); // …staged as git can address it
  });
});

describe('12/21 — AC-2: a DELETION is a change', () => {
  it('the archive\'s move lands as ONE commit: the live deletions, the snapshot, and nothing left dirty', () => {
    const node = join(journeyDir(), 'legs', '01-leg', '01-a');
    writeFileSync(join(node, 'node.json'), '{}\n');
    writeFileSync(join(node, 'events.jsonl'), '{"at":"2026-09-26","type":"created"}\n');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'goal.md'), '# Goal\n\nGoal: ship it\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'the session']);

    const { dest } = new Store(root).archiveJourney('demo');
    const out = commitJourneyWrites({ root, journeyDir: journeyDir(), who: 'unit', extraDirs: dirs() });

    expect(out.committed).toBe(true);
    expect(out.message).toBe(`journey: archived · manifest — the session moved to ${relative(root, dest)} (unit)`);
    const carried = lastTouched(root);
    // the DELETION half (the ` D` entry the guard counts) …
    expect(carried).toContain('.ann/journey/legs/01-leg/01-a/node.json');
    // … and the ADDITION half — ONE commit, both sides of the same move
    expect(carried).toContain(`${relative(root, dest)}/legs/01-leg/01-a/node.json`);
    expect(carried).toContain('docs/goal.md'); // the goal doc left the live docs/ home
    // THE ASSERTION THE AC NAMES: `uncommittedJourneyChanges()` (tracked, `??` dropped) is EMPTY
    expect(git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.ann/journey']).trim()).toBe('');
    expect(git(root, ['status', '--porcelain', '--untracked-files=no']).trim()).toBe('');
  });
});

describe('12/21 — AC-4: the exclusions are NAMED and PINNED', () => {
  it('names the ledger, the logs and the provider config — the list a reviewer reads', () => {
    expect(neverStaged(root)).toEqual([
      join(journeyDir(), '.ledger.json'),
      join(journeyDir(), '.ledger.json.tmp'),
      join(root, 'logs'),
      configPath(),
    ]);
  });

  it('drops them even when the SCOPE would include them — the boundary is not a side effect of the path filter', () => {
    const ledger = join(journeyDir(), '.ledger.json');
    const log = join(root, 'logs', 'provider.jsonl');
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(ledger, '{"rev":1}\n');
    writeFileSync(log, '{"prompt":"a secret the op-log must never commit"}\n');
    const calls: string[][] = [];
    // journaled, not passed by hand: the take path is what the bindings run
    noteWrite(root, rec(ledger, '', 'created'));
    noteWrite(root, rec(log, '', 'created'));
    noteWrite(root, rec(configPath(), '', 'created'));
    const out = commitJourneyWrites({
      root, journeyDir: journeyDir(), who: 'unit',
      // a deliberately OVER-wide scope: the trees the named list has to hold against
      extraDirs: [...dirs(), join(root, 'logs'), dirname(configPath())],
      env: { git: (_c, args) => { calls.push(args); return ''; }, warn: () => {} },
    });
    expect(out).toEqual({ committed: false, paths: [] });
    expect(calls).toEqual([]); // dropped BEFORE git is asked anything
    expect(takeWritten(root)).toEqual([]);
  });
});

describe('12/21 — AC-5: the hard line stands under the widened journal', () => {
  it('never CODE: a source file edited alongside a tooling write commits the tooling path ONLY', () => {
    writeFileSync(join(root, 'src-x.ts'), 'export const x = 1;\n');
    writeDocsManifest(root, scanDocsDir(root));
    const out = commitJourneyWrites({ root, journeyDir: journeyDir(), who: 'unit', extraDirs: dirs() });
    expect(out.committed).toBe(true);
    expect(lastCommit(root)).toEqual(['docs: manifest (unit)', 'docs/manifest.json']);
    expect(git(root, ['status', '--porcelain'])).toContain('?? src-x.ts'); // still the operator's to commit
  });
});
