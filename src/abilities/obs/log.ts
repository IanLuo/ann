import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * THE OPERATIONAL LOG (leg 12 task 05) — the THIRD view of the trace, and the debugger
 * of the operate loop. Design record: `.agents/plan/self-driving-design.md` §Observability.
 *
 *   provider.jsonl  (abilities/llm/oplog.ts) — every MODEL CALL: provider · model ·
 *                   promptChars · tokens · latency · retries · error (payload bytes are
 *                   NOT here; the prompt is a COUNT, never text).
 *   events.jsonl    (per node) — the RECORD: the journey's facts, DATE-only.
 *   operation.jsonl (THIS module) — the OPERATIONAL view: one line per engine ACTION —
 *                   commands · writes · frame phases · driver turns · stops — with a
 *                   WALL-CLOCK timestamp (the events carry a date; time lives HERE) and a
 *                   CORRELATION ID (runId · taskId · turn) so a whole run rebuilds in order.
 *
 * SCRATCH, NEVER THE RECORD (AC-3): the log lives at `<root>/logs/operation.jsonl` — next
 * to the provider op-log, inside the gitignored `logs/` tree. It is never read by the
 * engine for state and never authoritative: the journey events stay the record.
 *
 * THE FOUR INVARIANTS (each is an AC, each is tested):
 *   1. NEVER THROWS INTO THE FLOW — `OpLog.line` is fail-open: a write failure WARNS on
 *      stderr and the engine proceeds (observability must not break the engine).
 *   2. REDACTION (NFR-SEC-1) — no api key, no header/token/secret, and no verbatim
 *      prompt ever reaches the file: values under a secret-looking KEY are dropped, a
 *      value that matches a known secret is dropped, and a prompt-like value is stored
 *      as {chars, sha} (the op-log's own rule).
 *   3. BOUNDED — the file rotates at a size cap, keeping ONE rotated generation: the
 *      worst case on disk is 2×cap, never unbounded growth.
 *   4. SCRATCH — gitignored (`.gitignore`: `logs/`), and no engine read path depends on it.
 *
 * ONE LINE (documented shape; `ann log` renders it, `GET /api/log` serves it):
 *
 *   {ts, level, event, actor, runId, taskId?, turn?, command?, phase?, inputs?, outcome, durationMs?, error?}
 *
 *   ts          the WALL-CLOCK ISO instant the action ENDED (the journey's `at` is a date)
 *   level       info | warn | error      — `ann log --level warn` shows warn+error
 *   event       command | write | phase | turn | stop
 *   actor       provenance (RECORDED_BY / 'agent' / 'server' / 'engine') — never a guess
 *   runId       the CORRELATION id: one command invocation / one driver run / one serve
 *   taskId      the addressed node, when the action addresses one
 *   turn        the driver's turn number, when the action is a loop turn
 *   command     the verb (the CLI command name, `<mutator>!`, `drive`, …)
 *   phase       the frame phase (materialize · gate:grill · activate · execute · verify ·
 *               gate:confirm · commit · advance) — `outcome:enter` opens it, the closing
 *               line carries the phase's outcome + durationMs
 *   inputs      the action's inputs, REDACTED (see redaction below)
 *   outcome     what happened: ok · refused:<code> · enter · completed · blocked · …
 *   durationMs  the action's wall-clock duration
 *   error       {code, message} when the action failed
 */

/** The scratch home — the SAME `logs/` the provider op-log writes (one place per project). */
export const LOG_DIR = 'logs';
export const LOG_FILE = 'operation.jsonl';
/** The size cap: the live file rotates to `<file>.1` at this size (2×cap on disk, max). */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** A stored string longer than this is truncated (a body is never dumped into the log). */
const MAX_STRING = 512;
/** Depth cap for a redacted structure — inputs are a summary, not a copy of the payload. */
const MAX_DEPTH = 6;

export type LogLevel = 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/** ONE line of the operational log — the shape documented in the module head. */
export interface OpLogLine {
  ts: string;
  level: LogLevel;
  event: string;
  actor: string;
  runId: string;
  taskId?: string;
  turn?: number;
  command?: string;
  phase?: string;
  inputs?: unknown;
  outcome: string;
  durationMs?: number;
  error?: { code: string; message: string };
}

/** What a caller supplies — the correlation + timing fields the OpLog itself owns. */
export interface LogInput {
  event: string;
  outcome: string;
  level?: LogLevel;
  command?: string;
  phase?: string;
  taskId?: string;
  turn?: number;
  inputs?: unknown;
  durationMs?: number;
  error?: { code: string; message: string };
}

/* ── REDACTION (NFR-SEC-1) ─────────────────────────────────────────────────── */

/** A KEY that names a secret: its value is dropped, never logged. */
const SECRET_KEY = /(api[-_]?key|apikey|token|secret|password|passwd|passphrase|credential|authorization|auth|bearer|cookie|headers?)/i;
/** A KEY that names MODEL TEXT: prompts and completions are never logged verbatim (the
 *  op-log's own rule — a COUNT and a hash, never the bytes). Everything else a line
 *  carries (an event note, a report) is ordinary payload: truncated by length, not by name. */
const TEXT_KEY = /^(prompt|completion|messages|system)$/i;
/** An ISO-ish wall-clock stamp (never truncated, never treated as a secret). */
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** The secrets a log line must never echo: env values whose NAME looks like a secret
 *  (ANN_API_KEY · OPENAI_API_KEY · GH_TOKEN · …). A value shorter than 8 chars is not
 *  probed — the false-positive cost of matching a short word outweighs the risk. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): string[] {
  const out = [...extra];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (SECRET_KEY.test(k)) out.push(v);
  }
  return out;
}

const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * The REDACTED form of any value (AC-3 · NFR-SEC-1):
 *   · a value under a secret-looking KEY  → '[redacted]'
 *   · a prompt/completion-looking KEY     → {chars, sha} (never the text)
 *   · a string that CONTAINS a known secret → '[redacted]'
 *   · a string longer than MAX_STRING      → truncated with its true length
 *   · deeper than MAX_DEPTH                → '[deep]'
 * Pure and total: it never throws on any input (the caller is a fail-open path too).
 */
export function redact(value: unknown, secrets: string[] = [], depth = 0): unknown {
  try {
    return redactInner(value, secrets, depth);
  } catch {
    return '[unloggable]';
  }
}

function redactInner(value: unknown, secrets: string[], depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[unloggable]';
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redactInner(v, secrets, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, secrets) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string' && TEXT_KEY.test(k)) out[k] = { chars: v.length, sha: sha12(v) };
    else out[k] = redactInner(v, secrets, depth + 1);
  }
  return out;
}

function redactString(s: string, secrets: string[]): string {
  if (s && ISO.test(s)) return s; // a timestamp is structure, not payload
  for (const secret of secrets) if (secret && s.includes(secret)) return '[redacted]';
  if (s.length > MAX_STRING) return `${s.slice(0, MAX_STRING)}…[truncated ${s.length} chars]`;
  return s;
}

/* ── THE WRITER (fail-open, bounded) ───────────────────────────────────────── */

export interface OpLogOptions {
  /** The rotation cap (tests use a small one; production uses DEFAULT_MAX_BYTES). */
  maxBytes?: number;
  /** Extra secrets to scrub beyond the env-derived set. */
  secrets?: string[];
}

/** A fresh correlation id — one per command invocation / driver run / service boot. */
export function newRunId(prefix = 'run'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function logPath(root: string): string {
  return join(root, LOG_DIR, LOG_FILE);
}

/** Append ONE line, rotating FIRST when the line would take the live file past the cap.
 *  Throws on an I/O failure — that is `OpLog.line`'s business to swallow (the fail-open
 *  boundary). The bound is exact: the live file stays ≤ cap (a single line is truncated
 *  far below any sane cap, so a fresh file cannot be over it). */
export function writeLine(root: string, line: OpLogLine, maxBytes = DEFAULT_MAX_BYTES): void {
  const dir = join(root, LOG_DIR);
  ensureScratchDir(dir);
  const file = logPath(root);
  const encoded = JSON.stringify(line) + '\n';
  if (existsSync(file) && statSync(file).size + encoded.length > maxBytes) {
    // ONE rotated generation: the oldest history is dropped, the cap holds.
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  }
  appendFileSync(file, encoded);
}

/** THE SCRATCH GUARD: the log home ignores ITSELF (`logs/.gitignore` = `*`), so no
 *  `git add -A` can sweep runtime noise into a project's record — in this repo
 *  (`.gitignore` carries `logs/`) and in ANY ann project, fresh clone or not. A tracked
 *  operational log would be worse than noise: it would make the tree dirty under the
 *  engine's own clean-tree guards (`capture!`) and grow the repo unboundedly. */
function ensureScratchDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# ann runtime scratch — never the record (leg 12/05)\n*\n');
}

/** Warn-and-continue — the fail-open notice an operator sees when the log cannot be written. */
function warn(message: string): void {
  try {
    process.stderr.write(message + '\n');
  } catch {
    /* stderr gone too — the engine still proceeds (observability is never the failure) */
  }
}

/**
 * THE LOG HANDLE — a correlation context (root · runId · actor) plus the write. A
 * `child` narrows the correlation (a task, the driver's own run) without changing the
 * destination, so every writer in one run appends to the same file with the same runId.
 */
export class OpLog {
  constructor(
    readonly root: string,
    readonly runId: string,
    readonly actor: string,
    private readonly opts: OpLogOptions = {},
    /** The correlation's node — a child narrows it (e.g. the frame's task). */
    readonly taskId?: string,
  ) {}

  /** A narrower context: same destination + secrets, a different correlation. */
  child(extra: { runId?: string; actor?: string; taskId?: string }): OpLog {
    return new OpLog(this.root, extra.runId ?? this.runId, extra.actor ?? this.actor, this.opts, extra.taskId ?? this.taskId);
  }

  private get secrets(): string[] {
    return this.opts.secrets ?? (this.opts.secrets = knownSecrets());
  }

  /**
   * ONE action → ONE line. NEVER THROWS (AC-3): any failure — a bad path, a full disk,
   * an unserializable value — warns and returns, so no observability fault can break or
   * alter the engine's flow.
   */
  line(rec: LogInput): void {
    try {
      const taskId = rec.taskId ?? this.taskId;
      const full: OpLogLine = {
        ts: new Date().toISOString(),
        level: rec.level ?? 'info',
        event: rec.event,
        actor: this.actor,
        runId: this.runId,
        ...(taskId ? { taskId } : {}),
        ...(rec.turn !== undefined ? { turn: rec.turn } : {}),
        ...(rec.command ? { command: rec.command } : {}),
        ...(rec.phase ? { phase: rec.phase } : {}),
        ...(rec.inputs !== undefined ? { inputs: redact(rec.inputs, this.secrets) } : {}),
        outcome: rec.outcome,
        ...(rec.durationMs !== undefined ? { durationMs: rec.durationMs } : {}),
        ...(rec.error ? { error: rec.error } : {}),
      };
      writeLine(this.root, full, this.opts.maxBytes ?? DEFAULT_MAX_BYTES);
    } catch (e) {
      warn(`ann: operational log write failed (${(e as Error).message}) — continuing (observability never breaks the engine)`);
    }
  }
}

/* ── THE DEBUG READ (`ann log` · `GET /api/log`) ───────────────────────────── */

export interface LogFilters {
  task?: string;
  run?: string;
  /** Minimum severity: 'warn' shows warn + error. */
  level?: LogLevel;
  /** An ISO instant, or a relative window (30s · 10m · 2h · 1d). */
  since?: string;
  /** The last N lines AFTER filtering (default 50). */
  tail?: number;
}

export interface LogPage {
  file: string;
  /** Lines read from disk (the rotated generation included, oldest first). */
  total: number;
  /** Lines that survived the filters. */
  filtered: number;
  /** Lines returned (the tail of `filtered`). */
  shown: number;
  /** Unparseable lines — counted, never fatal (a torn write is not a crash). */
  skipped: number;
  filters: LogFilters;
  lines: OpLogLine[];
}

export const DEFAULT_TAIL = 50;
const SINCE_UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since` → an epoch ms floor. An ISO instant (`2026-09-14T10:00:00Z`) or a relative
 *  window (`30m`). `undefined` = unparseable (the caller reports it as a usage error). */
export function parseSince(raw: string | undefined, now = Date.now()): number | undefined {
  if (raw === undefined) return undefined;
  const rel = /^(\d+)([smhd])$/.exec(raw.trim());
  if (rel) return now - Number(rel[1]) * SINCE_UNIT[rel[2]];
  const iso = Date.parse(raw);
  return Number.isNaN(iso) ? undefined : iso;
}

/**
 * The DERIVED read over the log file (AC-4) — tail + filter by task · run · level · time.
 * Read-only, total, and never throws: a missing file is an empty page, a torn line is
 * counted and skipped. The rotated generation is read FIRST so a tail spans a rotation.
 */
export function readOpLog(root: string, filters: LogFilters = {}): LogPage {
  const file = logPath(root);
  const rotated = `${file}.1`;
  const raw: string[] = [];
  let skipped = 0;
  const lines: OpLogLine[] = [];
  for (const p of [rotated, file]) {
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n')) if (l.trim()) raw.push(l);
  }
  const since = parseSince(filters.since);
  for (const l of raw) {
    let rec: OpLogLine;
    try {
      rec = JSON.parse(l) as OpLogLine;
    } catch {
      skipped++;
      continue;
    }
    if (filters.task && rec.taskId !== filters.task) continue;
    if (filters.run && rec.runId !== filters.run) continue;
    if (filters.level && LEVEL_ORDER[rec.level] < LEVEL_ORDER[filters.level]) continue;
    if (since !== undefined && Date.parse(rec.ts) < since) continue;
    lines.push(rec);
  }
  const tail = filters.tail ?? DEFAULT_TAIL;
  const shown = tail > 0 ? lines.slice(-tail) : lines;
  return { file, total: raw.length, filtered: lines.length, shown: shown.length, skipped, filters, lines: shown };
}
