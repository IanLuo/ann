/**
 * THE ENGINE COMMITS ITS OWN JOURNEY WRITES (leg 12/20; widened by leg 12/21 to EVERY
 * WRITE — the journal's record is the WRITE, not the event, and a DELETION is a write).
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
 *  · THE ENGINE'S OWN TRACKED TREES, NEVER CODE. Concluding a deliverable stays the
 *    OPERATOR's move (frame.ts: "concluding is the OPERATOR's move"). The trees in scope
 *    are NAMED — the journey, plus `engineWriteDirs()`: the idea area, `docs/**`, the
 *    rules registry and the archive tree. A path outside them is dropped here even if the
 *    journal somehow carried one. 12/20 read the archive snapshot as the OPERATOR's
 *    deliverable and left `.ann/archive/**` out of scope; 12/21 REVERSES that, NAMED, and
 *    for the reason the reversal names (AC-2): half a rename is not a smaller commit, it
 *    is a dirty tree. The SAME gesture removes the live `.ann/journey/**` entries and adds
 *    the snapshot, so a reviewer reads one change — and `uncommittedJourneyChanges()`,
 *    which counts ` D` and only drops `??`, stops refusing the NEXT archive over the
 *    previous one's leftovers. A source file edited alongside a tooling write is out of
 *    scope by the same filter: NEVER CODE, unchanged from 12/20.
 *  · STAGED BY NAME, FROM THE JOURNAL. The store notes the exact file at the write site,
 *    so the commit is a fact about what was written — never `git status`'s tree, which
 *    would sweep an unrelated change (another agent's in-flight work in the same
 *    checkout, a stray edit) into the engine's commit. `git commit -- <paths>` confines
 *    it further: an ALREADY STAGED unrelated change is not carried in.
 *  · AND NOT EVERY PATH IN THOSE TREES. `neverStaged()` names the exclusions INSIDE the
 *    engine's own trees (12/21 AC-4): the write-rev ledger, `logs/**` — the provider
 *    op-log records prompts — and the provider config, which can hold the API key. One
 *    readable list, read by the staging filter, so the boundary is a DECISION a reviewer
 *    can check rather than an accident of where a filter happened to be written.
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
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { takeWritten, type WriteRecord } from '../store/write-journal.js';
import { IDEAS_DIRNAME } from '../store/ideas.js';
import { LOG_DIR } from '../abilities/obs/log.js';
import { configPath } from '../abilities/llm/config.js';

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
  // the idea area's verbs (leg 12/10) — the same derived-subject rule, a different noun
  'idea-added': 'added',
  'idea-promoted': 'promoted',
  'idea-dropped': 'dropped',
  // the EDITOR's own writes (leg 12/21, AC-3) — a write that lands no event still says
  // what it was, so `docs --write` reads as a manifest write and not a bare path
  'goal-doc': 'goal doc',
  'spec-doc': 'spec doc',
  'design-brief': 'design brief',
  'stage-doc': 'staged doc',
  'docs-manifest': 'manifest',
  'rules-registry': 'rules registry',
  archived: 'archived',
};

/** THE TRACKED TREES OUTSIDE THE JOURNEY THAT THE ENGINE'S OWN WRITES OWN. One list,
 *  consumed by every commit call site, so "what does the engine commit" is answerable in
 *  one place: the journey (always) plus these. Adding a tree here is a decision about
 *  ownership, never a side effect of where a filter happened to be written.
 *
 *  `docs` and the rules registry are the EDITOR's deliverables (12/21 AC-3): a doc or a
 *  brief is REVIEWABLE BECAUSE IT IS COMMITTED — the operator's rule — so the writer that
 *  produced it commits it at the moment of writing. `.ann/archive` is the archive's own
 *  destination: the rename's other half, in the same commit by decision (AC-2). */
export function engineWriteDirs(root: string): string[] {
  return [join(root, '.ann', IDEAS_DIRNAME), join(root, 'docs'), join(root, '.ann', 'rules'), join(root, '.ann', 'archive')];
}

/** THE PATHS THE ENGINE WILL NEVER COMMIT (leg 12/21, AC-4), read by the staging filter
 *  below — so a reviewer reads one list instead of reconstructing a predicate:
 *
 *   · THE WRITE-REV LEDGER (and its `.tmp`). Derived integrity state: `.gitignore` keeps
 *     it out so a fresh checkout re-bootstraps from the store's current state, which IS
 *     the baseline. (The copy INSIDE an archived session rides with the snapshot: it is
 *     that snapshot's own baseline, tracked since the first archive.)
 *   · `logs/**` — the per-run operational log and the PROVIDER OP-LOG, which records
 *     prompts. `.gitignore` says of it: "never source data … must never be committed".
 *   · THE PROVIDER CONFIG `~/.ann/config.json` (mode 0600, `$ANN_CONFIG` to relocate) —
 *     it may hold the API key. Outside the repo, so this can only ever drop a path
 *     somebody journaled by mistake; that is exactly what the pin is for.
 */
export function neverStaged(root: string): string[] {
  const journey = join(root, '.ann', 'journey');
  return [join(journey, '.ledger.json'), join(journey, '.ledger.json.tmp'), join(root, LOG_DIR), configPath()];
}

/** The commit subject, derived from what LANDED — one clause per node, in write order.
 *  The noun is the record's SCOPE (`journey` when absent — every store write), so an
 *  idea gesture reads `ideas: <id> added (…)` and never claims to be the journey.
 *
 *  A whole-journey write (node '') gets no node clause: the archive's gesture is the
 *  journey's own, and `'' archived · manifest` would read as a node named nothing. A
 *  record's `kind` DELIBERATELY does not change the word — what happened is named once,
 *  by the writer, and the diff carries the rest; the `detail` tail is where a gesture
 *  with a name of its own (the archive's destination) says it. */
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
    const clause = [...new Set(words)].join(' · ');
    parts.push(node ? `${node} ${clause}` : clause);
  }
  const detail = records.find((r) => r.detail)?.detail;
  return `${records[0]?.scope ?? 'journey'}: ${parts.join('; ')}${detail ? ` — ${detail}` : ''} (${who})`;
}

/** Is `p` inside `dir`? The AC-2 hard line — the engine commits the trees it OWNS and
 *  nothing else, checked rather than assumed (the store journals those paths only, so
 *  this can only ever drop a path, never a legitimate one). */
function under(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The path GIT can be handed — never the journaled path itself, for two reasons. A writer
 *  may write THROUGH A SYMLINK (`rules → .ann/rules` is the shipped layout, and git
 *  refuses a pathspec beyond one: "is beyond a symbolic link"), and a DELETED path has no
 *  real path of its own, so its PARENT is resolved and the name re-joined. EVERY side of
 *  every comparison below goes through here: the macOS temp dir is itself a symlink
 *  (`/var → /private/var`), so resolving one side only would make a real path look out of
 *  scope. A path that cannot be resolved is returned as given, so the filters compare like
 *  with like and drop it rather than hand git something the caller never wrote. */
function resolveForGit(p: string, missing = false): string {
  try {
    if (!missing && existsSync(p)) return realpathSync(p);
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return p;
  }
}

/** THE PATHSPECS GIT CAN ACT ON for one record. A write is its own path. A `kind:'delete'`
 *  record names what the writer REMOVED — usually a DIRECTORY (the archive moves whole leg
 *  dirs out of the live tree) — and MEASURED, not assumed, a pathspec naming a gone (or
 *  still present but EMPTY) DIRECTORY stages NOTHING once it is mixed with other
 *  pathspecs, while a pathspec naming a gone FILE stages its removal even in a mixed list.
 *  So a deletion is EXPANDED into the files the INDEX says were under it (`git ls-files`
 *  — the index, never a worktree scan). A path the index does not know (an untracked file
 *  the writer removed) stands as itself, which stages nothing and commits nothing. */
function stagedPaths(env: CommitEnv, root: string, r: WriteRecord, p: string): string[] {
  const l = relative(root, p);
  if (r.kind !== 'delete') return [l];
  const tracked = (env.git(root, ['ls-files', '-z', '--', l]) ?? '').split('\0').filter(Boolean);
  return tracked.length ? tracked : [l];
}

export interface CommitOptions {
  root: string;          // the project root git runs in
  journeyDir: string;    // <root>/.ann/journey — always in scope
  /** The other trees in scope (engineWriteDirs). Defaults to NONE, so a caller that
   *  names only the journey commits only the journey. */
  extraDirs?: string[];
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
    // resolved ONCE, so every comparison and every git call below speaks the same form
    const root = resolveForGit(opts.root);
    const dirs = [opts.journeyDir, ...(opts.extraDirs ?? [])].map((d) => resolveForGit(d));
    const never = neverStaged(opts.root).map((p) => resolveForGit(p));
    // THE TWO FILTERS, one pass: in the engine's own trees, and not on the never-staged
    // list. The reported `paths` stay the JOURNALED ones — that is what the caller says
    // it wrote; the resolved form is only ever what git is handed.
    const kept = [...new Map(records.map((r) => [r.path, r])).values()]
      .map((r) => ({ r, p: resolveForGit(r.path, r.kind === 'delete') }))
      .filter(({ p }) => dirs.some((d) => under(p, d)) && !never.some((n) => p === n || under(p, n)));
    const paths = kept.map(({ r }) => r.path);
    if (!paths.length) return { committed: false, paths: [] };
    // a hermetic run (the e2e harness) opts out: the engine must not write history into
    // the fixture's repository while the assertion under test is still running
    if (process.env.ANN_NO_COMMIT) return { committed: false, paths };
    // no repository → the feature does not apply (see the module doc's stated reading)
    if (env.git(root, ['rev-parse', '--git-dir']) === undefined) return { committed: false, paths };

    const rel = [...new Set(kept.flatMap(({ r, p }) => stagedPaths(env, root, r, p)))];
    // only the journaled paths decide whether there is anything to do — an unrelated
    // dirty file elsewhere in the tree is not this invocation's business
    const dirty = env.git(root, ['status', '--porcelain', '--', ...rel]);
    if (dirty === undefined || !dirty.trim()) return { committed: false, paths };

    // `add` first (a spawned node is UNTRACKED, and `commit -- <path>` alone cannot pick
    // up a path git does not know), then commit with the pathspec so an already-staged
    // unrelated change is not carried in. A DELETION stages through the same call — one
    // ` D` entry the archive's own guard counts, which is what makes the move out of the
    // live tree committed rather than left dirty.
    if (env.git(root, ['add', '--', ...rel]) === undefined) {
      return { committed: false, paths, warning: `ann: ${rel.length} journey file(s) written but not committed — 'git add' failed. Commit by hand (the writes are on disk and are the record).` };
    }
    const staged = env.git(root, ['diff', '--cached', '--name-only', '--', ...rel]);
    if (staged === undefined || !staged.trim()) return { committed: false, paths };

    const message = commitMessage(records, opts.who);
    if (env.git(root, ['commit', '-q', '-m', message, '--', ...rel]) === undefined) {
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
