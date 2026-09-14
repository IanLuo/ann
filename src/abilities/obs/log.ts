import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * THE OPERATIONAL LOG (leg 12 task 05; the dimensions the 12/05 grill rejection named:
 * "the log should have tracing id and layer id, belong to to indicate their timeline,
 * location or maybe other dimensions"). Design record:
 * `.agents/plan/self-driving-design.md` §Observability.
 *
 *   provider.jsonl  (abilities/llm/oplog.ts) — every MODEL CALL: provider · model ·
 *                   promptChars · tokens · latency · retries · error + the trace id.
 *   events.jsonl    (per node) — the RECORD: the journey's facts, DATE-only.
 *   operation.jsonl (THIS module) — the OPERATIONAL view: one line per engine ACTION —
 *                   commands · writes · frame phases · driver turns · stops — with a
 *                   WALL-CLOCK timestamp, an ORDER, a CHAIN and a LAYER.
 *
 * THE FOUR QUESTIONS A LINE ANSWERS — of ANY line, without cross-referencing:
 *
 *   WHICH CHAIN?   `traceId` — ONE causal chain (a CLI invocation · an HTTP request · a
 *                  drive · a command and everything it causes). Child spans INHERIT it, so
 *                  `ann log --trace <id>` is the whole chain, in order — the timeline.
 *   WHICH LAYER?   `layer` (L0 store · L1 commands · L2 flow · L3 surface/abilities) +
 *                  `component` (the module: `flow/frame`, `commands`, `store`, …) — WHERE
 *                  in the stack the line happened, never a guess.
 *   WHERE IN TIME? `seq` — 1,2,3… WITHIN the trace, assigned at write time: the order is
 *                  the log's own, never the clock's (two machines, two clocks, one order).
 *   WHERE IN THE STACK? `spanId` / `parentSpanId` — the nesting (a command opens a frame,
 *                  a frame opens phases, a phase's step writes through L1), so the chain
 *                  reads as a tree. Plus the journey location (`taskId` · `phase` · `turn`).
 *
 * SCRATCH, NEVER THE RECORD (AC-3): `<root>/logs/operation.jsonl`, inside the gitignored
 * `logs/` tree, which ignores ITself (`logs/.gitignore`). Never read for state; the
 * journey events stay the record.
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
 *   4. SCRATCH — gitignored, and no engine read path depends on it.
 *
 * ONE LINE (the documented shape; `ann log` renders it, `GET /api/log` serves it):
 *
 *   {ts, seq, traceId, spanId, parentSpanId?, layer, component, event, actor, runId,
 *    taskId?, turn?, command?, phase?, inputs?, outcome, durationMs?, error?}
 *
 *   ts           the WALL-CLOCK ISO instant the action ENDED
 *   seq          the action's PLACE in the chain (1-based, clock-independent): a CONTAINER
 *                (the entry · a drive run · a turn · a frame run) reserves its place when it
 *                opens and carries it on the line it writes when it ends, so the chain reads
 *                cause → effect — `ann log --trace <id>` is a timeline, never an unwind
 *   traceId      the CAUSAL CHAIN id (inherited by every nested span)
 *   spanId       this action's span (s1 = the chain's root span)
 *   parentSpanId the span that caused this one (absent on the root)
 *   layer        L0 store · L1 commands · L2 flow · L3 surface/abilities
 *   component    the module that produced it (`store` · `commands` · `flow/frame` · …)
 *   event        command | write | phase | turn | stop
 *   actor        provenance (RECORDED_BY / 'agent' / 'server') — never a guess
 *   runId        the RUN/ATTEMPT within the trace (a drive run differs from its request)
 *   taskId       the addressed node, when the action addresses one
 *   turn         the driver's turn number, when the action is a loop turn
 *   command      the verb (the CLI command name, `<mutator>!`, `store.appendEvent`, …)
 *   phase        the frame phase (materialize · gate:grill · activate · execute · verify ·
 *                gate:confirm · commit · advance) — `outcome:enter` opens it, the closing
 *                line carries the phase's outcome + durationMs
 *   inputs       the action's inputs, REDACTED
 *   outcome      what happened: ok · refused:<code> · enter · completed · blocked · …
 *   durationMs   the action's wall-clock duration
 *   error        {code, message} when the action failed
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

/** WHICH LAYER of the L0–L3 stack produced the line (architecture v3's layer model). */
export type LayerId = 'L0' | 'L1' | 'L2' | 'L3';
export const LAYERS: readonly LayerId[] = ['L0', 'L1', 'L2', 'L3'];
export const LAYER_NAMES: Record<LayerId, string> = {
  L0: 'store',
  L1: 'commands',
  L2: 'flow',
  L3: 'surface/abilities',
};

export const isLayerId = (v: unknown): v is LayerId => typeof v === 'string' && (LAYERS as readonly string[]).includes(v);

/** ONE line of the operational log — the shape documented in the module head. */
export interface LogRecord {
  ts: string;
  seq: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  layer: LayerId;
  component: string;
  event: string;
  /** The severity: `ann log --level warn` shows warn + error. */
  level: LogLevel;
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

/** What a caller supplies for ONE line — the handle owns the identity + the ordering. */
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

/** The identity a handle carries: the chain, the span, the layer, the provenance. */
export interface LogContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  layer: LayerId;
  component: string;
  runId: string;
  actor: string;
  taskId?: string;
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

/** A fresh id — one per CLI invocation / driver run / service boot / HTTP request. */
export function newRunId(prefix = 'run'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function logPath(root: string): string {
  return join(root, LOG_DIR, LOG_FILE);
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

/** Append ONE line, rotating FIRST when the line would take the live file past the cap.
 *  Throws on an I/O failure — that is `OpLog.line`'s business to swallow (the fail-open
 *  boundary). The bound is exact: the live file stays ≤ cap (a single line is truncated
 *  far below any sane cap, so a fresh file cannot be over it). */
export function writeLine(root: string, line: LogRecord, maxBytes = DEFAULT_MAX_BYTES): void {
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

/** Warn-and-continue — the fail-open notice an operator sees when the log cannot be written. */
function warn(message: string): void {
  try {
    process.stderr.write(message + '\n');
  } catch {
    /* stderr gone too — the engine still proceeds (observability is never the failure) */
  }
}

/** The per-trace counters (shared by every handle of ONE trace, fresh for a new one):
 *  `seq` orders the chain, `span` mints its span ids. */
interface TraceCounters {
  seq: number;
  span: number;
}

/** A ROOT handle's counters start at 1 with the first place RESERVED: the entry line is
 *  written when the invocation ENDS (it carries the outcome + the duration), yet it is the
 *  chain's first action — reserving its `seq` makes the read a cause→effect timeline. */
const rootCounters = (): TraceCounters => ({ seq: 1, span: 1 });

/**
 * THE LOG HANDLE — an identity (trace · span · layer · component · run) plus the write.
 * `span()` narrows it for a nested unit of work (the SAME trace, a new span whose parent is
 * this one); `newTrace()` starts a new chain. Both are cheap and immutable: a handle is
 * passed by construction into the layer that needs it, so no global state is consulted.
 */
export class OpLog {
  /** The place this handle's FIRST line takes — reserved by a root handle (see rootCounters). */
  private reserved?: number;

  constructor(
    readonly root: string,
    readonly ctx: LogContext,
    private readonly opts: OpLogOptions = {},
    private readonly counters: TraceCounters = { seq: 0, span: 1 },
    reserved?: number,
  ) {
    this.reserved = reserved;
  }

  get traceId(): string {
    return this.ctx.traceId;
  }
  get spanId(): string {
    return this.ctx.spanId;
  }
  get parentSpanId(): string | undefined {
    return this.ctx.parentSpanId;
  }
  get layer(): LayerId {
    return this.ctx.layer;
  }
  get component(): string {
    return this.ctx.component;
  }
  get runId(): string {
    return this.ctx.runId;
  }
  get actor(): string {
    return this.ctx.actor;
  }
  get taskId(): string | undefined {
    return this.ctx.taskId;
  }

  /**
   * A NESTED SPAN of the SAME chain (the default), or — when a DIFFERENT `traceId` is
   * given — a new chain (a fresh order counter, no parent). Fields not overridden are
   * inherited, so a frame inside a command keeps the command's trace by construction.
   */
  span(
    extra: {
      component?: string;
      layer?: LayerId;
      runId?: string;
      taskId?: string;
      actor?: string;
      traceId?: string;
      /** RESERVE this span's place NOW for its first (outcome) line: for a CONTAINER that
       *  reports its result when it ends (a drive run · a turn · a frame run · the entry),
       *  so the chain still reads cause → effect (`seq` = where the work STARTED). */
      reserve?: boolean;
    } = {},
  ): OpLog {
    const fresh = extra.traceId !== undefined && extra.traceId !== this.ctx.traceId;
    const counters = fresh ? rootCounters() : this.counters;
    // a NEW chain's handle IS its root span (s1), and it reserves the chain's first place;
    // a nested span takes the next span id (its lines take their place when they happen)
    const spanId = fresh ? `s${counters.span}` : `s${++counters.span}`;
    return new OpLog(
      this.root,
      {
        traceId: extra.traceId ?? this.ctx.traceId,
        spanId,
        ...(fresh ? {} : { parentSpanId: this.ctx.spanId }),
        layer: extra.layer ?? this.ctx.layer,
        component: extra.component ?? this.ctx.component,
        // a NEW chain is a new run unless the caller names one; a nested span keeps it
        runId: extra.runId ?? (fresh ? (extra.traceId as string) : this.ctx.runId),
        actor: extra.actor ?? this.ctx.actor,
        taskId: extra.taskId ?? this.ctx.taskId,
      },
      this.opts,
      counters,
      fresh ? counters.seq : extra.reserve ? ++counters.seq : undefined,
    );
  }

  private get secrets(): string[] {
    return this.opts.secrets ?? (this.opts.secrets = knownSecrets());
  }

  /**
   * ONE action → ONE line. NEVER THROWS (AC-3): any failure — a bad path, a full disk,
   * an unserializable value — warns and returns, so no observability fault can break or
   * alter the engine's flow. The `seq` is taken from the trace's own counter: the order
   * is the log's, never the clock's.
   */
  line(rec: LogInput): void {
    try {
      // the entry's reserved place, or the next place in the chain (the order of actions)
      const seq = this.reserved ?? ++this.counters.seq;
      this.reserved = undefined;
      const taskId = rec.taskId ?? this.ctx.taskId;
      const full: LogRecord = {
        ts: new Date().toISOString(),
        seq,
        traceId: this.ctx.traceId,
        spanId: this.ctx.spanId,
        ...(this.ctx.parentSpanId ? { parentSpanId: this.ctx.parentSpanId } : {}),
        layer: this.ctx.layer,
        component: this.ctx.component,
        event: rec.event,
        level: rec.level ?? 'info',
        actor: this.ctx.actor,
        runId: this.ctx.runId,
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

/**
 * A ROOT handle: the ENTRY of one causal chain (a CLI invocation · an HTTP request · a
 * service boot). Everything the entry causes inherits its `traceId` through `span()`.
 */
export function newTrace(
  root: string,
  entry: { actor: string; layer: LayerId; component: string; runId?: string; traceId?: string; taskId?: string },
  opts: OpLogOptions = {},
): OpLog {
  const traceId = entry.traceId ?? newRunId('trace');
  const counters = rootCounters();
  return new OpLog(
    root,
    {
      traceId,
      spanId: `s${counters.span}`,
      layer: entry.layer,
      component: entry.component,
      runId: entry.runId ?? traceId,
      actor: entry.actor,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
    },
    opts,
    counters,
    counters.seq, // the entry's place in its own chain
  );
}

/* ── THE DEBUG READ (`ann log` · `GET /api/log`) ───────────────────────────── */

export interface LogFilters {
  /** ONE CAUSAL CHAIN — the whole chain, ordered by `seq` (its timeline). */
  trace?: string;
  /** WHICH LAYER produced the lines: L0 store · L1 commands · L2 flow · L3 surface/abilities. */
  layer?: LayerId;
  task?: string;
  run?: string;
  /** Minimum severity: 'warn' shows warn + error. */
  level?: LogLevel;
  /** An ISO instant, or a relative window (30s · 10m · 2h · 1d). */
  since?: string;
  /** The last N lines AFTER filtering (default 50; 0 = all of them). */
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
  /** The chain read as ONE timeline: how many DISTINCT traces the matching lines span. */
  traces: number;
  filters: LogFilters;
  lines: LogRecord[];
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
 * The DERIVED read over the log file (AC-4) — tail + filter by TRACE · LAYER · task · run ·
 * level · time. Read-only, total, and never throws: a missing file is an empty page, a torn
 * line is counted and skipped. The rotated generation is read FIRST so a tail spans a
 * rotation. Filtering BY TRACE orders the result by `seq` (the chain's own timeline —
 * clock-independent), which is also how the file is written.
 */
export function readOpLog(root: string, filters: LogFilters = {}): LogPage {
  const file = logPath(root);
  const rotated = `${file}.1`;
  const raw: string[] = [];
  let skipped = 0;
  const lines: LogRecord[] = [];
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
    let rec: LogRecord;
    try {
      rec = JSON.parse(l) as LogRecord;
    } catch {
      skipped++;
      continue;
    }
    if (filters.trace && rec.traceId !== filters.trace) continue;
    if (filters.layer && rec.layer !== filters.layer) continue;
    if (filters.task && rec.taskId !== filters.task) continue;
    if (filters.run && rec.runId !== filters.run) continue;
    if (filters.level && LEVEL_ORDER[rec.level] < LEVEL_ORDER[filters.level]) continue;
    if (since !== undefined && Date.parse(rec.ts) < since) continue;
    lines.push(rec);
  }
  // A TRACE IS A TIMELINE: read by trace, the order is the chain's own (seq), never the
  // file's and never the clock's (a merged/rotated file keeps the same order anyway).
  if (filters.trace) lines.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const tail = filters.tail ?? DEFAULT_TAIL;
  const shown = tail > 0 ? lines.slice(-tail) : lines;
  return {
    file,
    total: raw.length,
    filtered: lines.length,
    shown: shown.length,
    skipped,
    traces: new Set(lines.map((r) => r.traceId)).size,
    filters,
    lines: shown,
  };
}
