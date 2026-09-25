/**
 * THE ENGINE COMMITS ITS OWN JOURNEY WRITES (leg 12/20).
 *
 * The defect this closes, found live: `store.appendEvent` wrote events.jsonl and STOPPED.
 * Code is committed at delivery (`feat(...)`) and the journey record of a delivery is
 * committed by hand (`journey: ...`), but a HUMAN GESTURE — `gate!` accept, `spawn!`,
 * `submit!`, `evidence!` — wrote events that NOTHING DOWNSTREAM OWNED, so every gesture
 * left the tree dirty and only a person noticing would clear it. Not cosmetic: `goal!`
 * archive refuses on uncommitted tracked `.ann/journey` changes (commands/index.ts, via
 * `uncommittedJourneyChanges()`), so a dirty log blocks a STRUCTURAL RESET at the worst
 * moment. `capture!` is NOT affected — its clean-tree guard excludes the store by
 * construction (`STORE_PATHS = ['.ann/', 'journey/']`) — which is exactly why the dirt
 * stayed invisible until archive time.
 *
 * THE TWO LINES THAT MUST HOLD:
 *  · ONLY `.ann/journey/**`, NEVER CODE. Concluding a deliverable stays the OPERATOR's
 *    move (frame.ts: "concluding is the OPERATOR's move"). A path outside the journey dir
 *    is dropped here even if the journal somehow carried one — INCLUDING the archive
 *    snapshot `goal! archive` writes to `.ann/archive/sessions/**`, which is a deliverable
 *    of the session (the operator commits it) and, being outside `.ann/journey`, is
 *    invisible to the archive's own uncommitted guard. STATED, not accidental: the filter
 *    is what draws the line, and a snapshot left dirty blocks nothing anywhere.
 *  · STAGED BY NAME, FROM THE JOURNAL. The store notes the exact file at the write site,
 *    so the commit is a fact about what was written — never `git status`'s tree, which
 *    would sweep an unrelated change (another agent's in-flight work in the same
 *    checkout, a stray edit) into the engine's commit. `git commit -- <paths>` confines
 *    it further: an ALREADY STAGED unrelated change is not carried in.
 *
 * FAIL-OPEN ON THE COMMIT, FAIL-CLOSED ON THE WRITE. The appended event is the truth; if
 * the commit cannot happen the gesture still SUCCEEDS and the reason is a NAMED warning
 * on stderr, never silence. A write the store refused means the journal is empty, so
 * there is nothing to commit and this is a no-op — the refusal is already the answer.
 *
 * ONE DELIBERATE READING, STATED SO IT IS NOT MISTAKEN FOR THE ONLY ONE: with NO git
 * repository at all the skip is SILENT. There is no record to keep and nothing is left
 * "dirty", and warning on every write in a non-git project would be noise, not
 * information. A repository that is PRESENT but refuses the commit (detached HEAD, unset
 * identity, a lock) is the case the warning exists for.
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { takeWritten, type WriteRecord } from '../store/write-journal.js';

/** The git seam — injectable so a unit test exercises a refusing git without one, and so
 *  no test ever commits into the repository it runs in. */
export interface CommitEnv {
  /** Run git in `cwd`; undefined when git is absent or the command failed. */
  git(cwd: string, args: string[]): string | undefined;
  warn(message: string): void;
}

export const defaultCommitEnv: CommitEnv = {
  git(cwd, args) {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    } catch {
      return undefined;
    }
  },
  warn(message) {
    process.stderr.write(message + '\n');
  },
};

export interface CommitOutcome {
  committed: boolean;
  /** The journaled paths that were in scope (journey-internal), absolute. */
  paths: string[];
  /** The message used, when a commit was attempted. */
  message?: string;
  /** Why it did not commit, when the reason is worth naming. */
  warning?: string;
}

/** The verb an event type reads as in the commit subject — the shape the history already
 *  carries (`journey: 12/20 grill ACCEPTED (ianluo)`), so an engine commit is
 *  indistinguishable in form from the hand ones it replaces. */
const WHAT: Record<string, string> = {
  created: 'spawn',
  confirmed: 'ACCEPTED',
  rejected: 'REJECTED',
  submitted: 'submitted',
  completed: 'completed',
  evidence: 'evidence',
  cancelled: 'cancelled',
  'goal-met': 'goal MET',
  extended: 'note',
  failed: 'failed',
};

/** The commit subject, derived from what LANDED — one clause per node, in write order. */
export function commitMessage(records: WriteRecord[], who: string): string {
  const byNode = new Map<string, WriteRecord[]>();
  for (const r of records) {
    const l = byNode.get(r.node);
    if (l) l.push(r);
    else byNode.set(r.node, [r]);
  }
  const parts: string[] = [];
  for (const [node, recs] of byNode) {
    const words: string[] = [];
    for (const r of recs) {
      // a bare contract write (a spawned leg, which carries no events) reads as the spawn
      if (r.type === 'node.json') {
        if (!recs.some((x) => x.type !== 'node.json')) words.push('spawn');
        continue;
      }
      const w = WHAT[r.type] ?? r.type;
      words.push(r.gate ? `${r.gate} ${w}` : w);
    }
    parts.push(`${node} ${[...new Set(words)].join(' · ')}`);
  }
  return `journey: ${parts.join('; ')} (${who})`;
}

/** Is `p` inside `dir`? The AC-2 hard line — the engine commits the journey and nothing
 *  else, checked rather than assumed (the store journals journey paths only, so this can
 *  only ever drop a path, never a legitimate one). */
function under(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface CommitOptions {
  root: string;          // the project root git runs in
  journeyDir: string;    // <root>/.ann/journey — the ONLY tree this may commit
  who: string;           // RECORDED_BY — the provenance the message carries
  /** The journal to commit. Defaults to TAKING this root's live journal (the binding's
   *  normal call); a test passes an explicit list to commit a known set. */
  records?: WriteRecord[];
  env?: CommitEnv;
}

/**
 * Commit exactly what the store journaled. Never throws: the caller is on the way out of
 * a gesture that already succeeded.
 */
export function commitJourneyWrites(opts: CommitOptions): CommitOutcome {
  const env = opts.env ?? defaultCommitEnv;
  const out = attemptCommit(opts, env);
  // NAMED, never silence: the gesture this records has already succeeded, so a commit
  // that could not happen has exactly one place to become visible
  if (out.warning) env.warn(out.warning);
  return out;
}

function attemptCommit(opts: CommitOptions, env: CommitEnv): CommitOutcome {
  try {
    const records = opts.records ?? takeWritten(opts.root);
    const paths = [...new Set(records.map((r) => r.path))].filter((p) => under(p, opts.journeyDir));
    if (!paths.length) return { committed: false, paths: [] };
    // a hermetic run (the e2e harness) opts out: the engine must not write history into
    // the fixture's repository while the assertion under test is still running
    if (process.env.ANN_NO_COMMIT) return { committed: false, paths };
    // no repository → the feature does not apply (see the module doc's stated reading)
    if (env.git(opts.root, ['rev-parse', '--git-dir']) === undefined) return { committed: false, paths };

    const rel = paths.map((p) => relative(opts.root, p));
    // only the journaled paths decide whether there is anything to do — an unrelated
    // dirty file elsewhere in the tree is not this invocation's business
    const dirty = env.git(opts.root, ['status', '--porcelain', '--', ...rel]);
    if (dirty === undefined || !dirty.trim()) return { committed: false, paths };

    // `add` first (a spawned node is UNTRACKED, and `commit -- <path>` alone cannot pick
    // up a path git does not know), then commit with the pathspec so an already-staged
    // unrelated change is not carried in.
    if (env.git(opts.root, ['add', '--', ...rel]) === undefined) {
      return { committed: false, paths, warning: `ann: ${rel.length} journey file(s) written but not committed — 'git add' failed. Commit by hand (the writes are on disk and are the record).` };
    }
    const staged = env.git(opts.root, ['diff', '--cached', '--name-only', '--', ...rel]);
    if (staged === undefined || !staged.trim()) return { committed: false, paths };

    const message = commitMessage(records, opts.who);
    if (env.git(opts.root, ['commit', '-q', '-m', message, '--', ...rel]) === undefined) {
      return {
        committed: false,
        paths,
        message,
        warning: `ann: the journey write is on disk but the commit failed — the record is safe, the tree is dirty. Commit by hand:\n  git commit -m ${JSON.stringify(message)}`,
      };
    }
    return { committed: true, paths, message };
  } catch (e) {
    // the gesture already succeeded; a commit defect is reported, never thrown
    return { committed: false, paths: [], warning: `ann: journey commit skipped — ${(e as Error).message}` };
  }
}
