import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * THE CAPTURE SURFACE (leg 12 task 03 — "the record is a consequence, not a claim").
 *
 * MECHANISM = (a) ENGINE-RUN WITH A CLOSED ALLOWLIST. The engine RUNS the command and
 * records the REAL exit code: `{command, result, exitCode, detail, sha, source:'captured'}`.
 * The caller names a command; it never supplies a command line and never supplies the
 * outcome. Guards, in order:
 *
 *   1. NAME ONLY, CLOSED SET. `ALLOWLIST` maps a NAME to a fixed argv array. A name that
 *      is not one of the five literals is refused by name — nothing else reaches an exec,
 *      so no arbitrary string can ever become a process (`shell: false`, no interpolation,
 *      no caller token in argv).
 *   2. CLEAN TREE. The capture refuses when tracked files outside the ann store have
 *      uncommitted changes, so `sha` (read from git, never typed) really is the repo
 *      state the run saw. The store's own records are excluded — they are the thing being
 *      written, not an input to the project's commands.
 *   3. SHA FROM GIT. The engine reads HEAD; the caller cannot name the bytes.
 *   4. THE GENERAL WRITER REFUSES `source:'captured'` (store.appendEvent), so the fact
 *      can only be written through `Store.appendCaptured` — the capture path.
 *
 * REJECTED: (b) runner-supplied capture with engine validation (the sha resolves in git ·
 * the command is on the allowlist · result ∈ pass|fail). It cannot produce the OUTCOME —
 * `result` stays typed by the reporter — so it leaves the hole this task exists to close
 * (a `pass` that means nothing), while its two guards are a strict subset of (a)'s. It
 * also moves the trust boundary without removing it: the allowlist would be enforced on a
 * STRING the runner typed, not on the argv the engine ran.
 *
 * The engine is NOT a general shell: this module is the only exec surface, and the shell
 * ability stays contract-declared and UNBUILT.
 */

/** The closed allowlist — NAME → fixed argv. The ONLY strings that reach an exec.
 *  FROZEN: the set is closed, and closing it is not a convention (a caller cannot add a
 *  sixth entry and then name it). */
export const ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'npm test': Object.freeze(['npm', 'test']),
  'npm run typecheck': Object.freeze(['npm', 'run', 'typecheck']),
  'npm run build': Object.freeze(['npm', 'run', 'build']),
  'ann check': Object.freeze([process.execPath, fileURLToPath(new URL('../surface/cli.js', import.meta.url)), 'check']),
  'ann verify': Object.freeze([process.execPath, fileURLToPath(new URL('../surface/cli.js', import.meta.url)), 'verify']),
});

export const ALLOWLIST_NAMES = Object.keys(ALLOWLIST);

/** The decided mechanism, in one line — recorded on the command's own help text. */
export const CAPTURE_MECHANISM =
  "engine-run with a CLOSED ALLOWLIST (npm test · npm run typecheck · npm run build · ann check · ann verify) — the name is one of five literals mapped to a fixed argv (shell:false, no arbitrary string reaches an exec), the sha is read from git, and the tree must be clean; runner-supplied capture rejected";

/** The execution seam. PRODUCTION = the real spawns below; tests substitute a stub, which
 *  is how a pass and a fail are exercised without running a suite inside a test. */
export interface CaptureEnv {
  /** Read the sha of the bytes a run would see (git HEAD), or undefined when there is none. */
  head(cwd: string): string | undefined;
  /** Tracked changes OUTSIDE the ann store — the clean-tree guard (empty = clean). */
  dirty(cwd: string): string[];
  /** RUN one allowlisted name; the outcome is the REAL exit code + the run's output
   *  (the two streams kept apart: the digest covers both, the summary is taken from the
   *  one that carries the verdict — a build tool's stderr tail is `$ tsc`, not a result). */
  run(name: string, cwd: string): { exitCode: number; stdout: string; stderr: string };
}

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch {
    return undefined;
  }
};

/** The ann store's own paths — excluded from the clean-tree guard (see the module doc). */
const STORE_PATHS = ['.ann/', 'journey/'];

export const defaultCaptureEnv: CaptureEnv = {
  head(cwd) {
    return git(cwd, ['rev-parse', 'HEAD'])?.trim() || undefined;
  },
  dirty(cwd) {
    const status = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    if (status === undefined) return [];
    return status
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .filter((p) => !STORE_PATHS.some((s) => p.startsWith(s)));
  },
  run(name, cwd) {
    const argv = ALLOWLIST[name];
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', shell: false });
    return {
      // no status = the process never exited (a signal / a failed spawn): recorded as a
      // non-zero status, which is what fail-closed means here.
      exitCode: typeof r.status === 'number' ? r.status : 1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  },
};

/** The output DIGEST + a one-line SUMMARY — the run's `detail`. The digest covers BOTH
 *  streams (it is what makes two records of a run comparable); the summary is the last
 *  non-empty line of STDOUT — where a test runner or a type-checker states its verdict —
 *  falling back to stderr only when stdout says nothing. */
export function outputDetail(stdout: string, stderr: string): string {
  const digest = createHash('sha1').update(stdout + stderr).digest('hex').slice(0, 12);
  const lastLine = lastLineOf(stdout) ?? lastLineOf(stderr);
  const summary = lastLine ? (lastLine.length > 160 ? lastLine.slice(0, 160) + '…' : lastLine) : '(no output)';
  return `sha1:${digest} · ${summary}`;
}

const lastLineOf = (s: string): string | undefined =>
  s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .pop();
