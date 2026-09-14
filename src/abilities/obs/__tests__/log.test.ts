import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  OpLog,
  knownSecrets,
  logPath,
  newRunId,
  parseSince,
  readOpLog,
  redact,
} from '../log.js';

/**
 * THE OPERATIONAL LOG (leg 12 task 05) — the third view of the trace: commands · writes ·
 * frame phases · driver turns · stops, with WALL-CLOCK time and a correlation id.
 *
 * Pinned here — the four invariants the design record fixes, each with its own test:
 *   · the LINE SHAPE (ts · level · event · actor · runId · taskId/turn · command/phase ·
 *     redacted inputs · outcome · durationMs · error?) and the correlation a `child`
 *     narrows;
 *   · REDACTION (NFR-SEC-1): a secret under a secret-looking key, a secret that matches
 *     a known value (env-derived), and a PROMPT (chars+sha, never verbatim);
 *   · FAIL-OPEN: an unwritable log WARNS and does not throw into the caller;
 *   · BOUNDED: the rotation keeps the live file under the cap with ONE rotated
 *     generation — never unbounded growth;
 * plus the DEBUG READ's filters (task · run · level · since · tail) over the file.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-obslog-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const linesOf = (dir = root): Array<Record<string, unknown>> =>
  readFileSync(logPath(dir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/* ── AC-1 · the line shape + the correlation id ───────────────────────────── */

describe('the line — one action, one JSONL record', () => {
  it('carries the documented shape, with a wall-clock ISO ts (the journey events are date-only)', () => {
    const log = new OpLog(root, 'cmd-test-1', 'tester');
    log.line({
      event: 'command',
      command: 'status',
      outcome: 'ok',
      durationMs: 7,
      inputs: { argv: ['status'], json: false },
      taskId: '12-operate-loop/05-implementation-observability-log',
      turn: 3,
      phase: 'execute',
    });
    const [l] = linesOf();
    expect(l).toMatchObject({
      level: 'info',
      event: 'command',
      actor: 'tester',
      runId: 'cmd-test-1',
      taskId: '12-operate-loop/05-implementation-observability-log',
      turn: 3,
      command: 'status',
      phase: 'execute',
      inputs: { argv: ['status'], json: false },
      outcome: 'ok',
      durationMs: 7,
    });
    // a WALL-CLOCK instant (with millis) — not the events' date-only `at`
    expect(String(l.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(String(l.ts)))).toBe(false);
  });

  it('records the refusal + the error, and the level the read filters on', () => {
    const log = new OpLog(root, 'r2', 'tester');
    log.line({ event: 'write', command: 'gate!', outcome: 'refused:reject-bound', level: 'warn', error: { code: 'reject-bound', message: '3 rejections' } });
    const [l] = linesOf();
    expect(l.level).toBe('warn');
    expect(l.outcome).toBe('refused:reject-bound');
    expect(l.error).toEqual({ code: 'reject-bound', message: '3 rejections' });
    expect(l.durationMs).toBeUndefined();
  });

  it('a child narrows the correlation (task / the driver\'s own run) without touching the parent', () => {
    const parent = new OpLog(root, 'cmd-parent', 'tester');
    const frame = parent.child({ taskId: '01-leg/01-a' });
    const drive = frame.child({ runId: 'drive-abc' });
    parent.line({ event: 'command', command: 'run!', outcome: 'ok' });
    frame.line({ event: 'phase', phase: 'execute', outcome: 'enter' });
    drive.line({ event: 'turn', turn: 1, outcome: 'executed' });
    const [a, b, c] = linesOf();
    expect([a.runId, a.taskId]).toEqual(['cmd-parent', undefined]);
    expect([b.runId, b.taskId]).toEqual(['cmd-parent', '01-leg/01-a']);
    expect([c.runId, c.taskId]).toEqual(['drive-abc', '01-leg/01-a']);
    expect(parent.runId).toBe('cmd-parent');
  });

  it('newRunId mints distinct ids per run', () => {
    expect(newRunId('cmd')).toMatch(/^cmd-[0-9a-z]+-[0-9a-z]+$/);
    expect(newRunId()).not.toBe(newRunId());
  });
});

/* ── AC-3 · REDACTION (NFR-SEC-1) ─────────────────────────────────────────── */

describe('redaction — no secret, and no verbatim prompt, ever reaches the file', () => {
  const SECRET = 'sk-planted-secret-0123456789abcdef';

  it('drops a value under a secret-looking KEY (apiKey · token · authorization · headers)', () => {
    const r = redact({ apiKey: SECRET, token: 'x', authorization: `Bearer ${SECRET}`, headers: { authorization: SECRET } }) as Record<string, unknown>;
    expect(r).toEqual({ apiKey: '[redacted]', token: '[redacted]', authorization: '[redacted]', headers: '[redacted]' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('drops any string CONTAINING a known secret (the env-derived registry)', () => {
    const secrets = knownSecrets({ ANTHROPIC_API_KEY: SECRET, HOME: '/Users/nobody' });
    expect(secrets).toContain(SECRET);
    expect(redact(`curl -H 'x-api-key: ${SECRET}'`, secrets)).toBe('[redacted]');
    expect(redact(['--task', SECRET, 'ok'], secrets)).toEqual(['--task', '[redacted]', 'ok']);
    // a short value is never treated as a secret (a word match is not worth the noise)
    expect(knownSecrets({ API_KEY: 'short' })).not.toContain('short');
  });

  it('stores a prompt/completion as {chars, sha} — NEVER verbatim (the op-log\'s own rule)', () => {
    const prompt = 'You are the SEMANTIC DRIVER of a journey-of-legs engine…';
    const r = redact({ prompt, completion: 'ok' }) as { prompt: { chars: number; sha: string }; completion: { chars: number; sha: string } };
    expect(r.prompt.chars).toBe(prompt.length);
    expect(r.prompt.sha).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(r)).not.toContain('SEMANTIC DRIVER');
    expect(r.completion).toEqual({ chars: 2, sha: expect.any(String) });
  });

  it('bounds a long string and a deep structure (a body is never dumped)', () => {
    const long = redact('x'.repeat(5000)) as string;
    expect(long.length).toBeLessThan(600);
    expect(long).toContain('[truncated 5000 chars]');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('[deep]');
  });

  it('a written line carries the REDACTED inputs — the planted secret is absent from the file', () => {
    const log = new OpLog(root, 'r3', 'tester', { secrets: [SECRET] });
    log.line({
      event: 'write',
      command: 'append!',
      outcome: 'ok',
      inputs: { args: ['12-operate-loop/05-x', { type: 'evidence', note: `key ${SECRET}`, headers: { authorization: `Bearer ${SECRET}` } }] },
    });
    const raw = readFileSync(logPath(root), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('[redacted]');
  });
});

/* ── AC-3 · NEVER THROWS (fail-open) ──────────────────────────────────────── */

describe('fail-open — observability never breaks the engine', () => {
  it('warns and returns when the log cannot be written (logs/ is a FILE, not a dir)', () => {
    writeFileSync(join(root, 'logs'), 'not a directory');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const log = new OpLog(root, 'r4', 'tester');
      expect(() => log.line({ event: 'command', command: 'status', outcome: 'ok' })).not.toThrow();
      expect(() => log.line({ event: 'write', command: 'append!', outcome: 'ok', inputs: { args: [1] } })).not.toThrow();
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('operational log write failed');
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('continuing');
    } finally {
      stderr.mockRestore();
    }
  });

  it('never throws on an unserializable input (a cycle / a bigint / a function)', () => {
    const log = new OpLog(root, 'r5', 'tester');
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => log.line({ event: 'command', command: 'status', outcome: 'ok', inputs: { cyclic, fn: () => 1, big: 1n } })).not.toThrow();
    const [l] = linesOf();
    expect(l.inputs).toMatchObject({ big: '1' });
  });
});

/* ── AC-3 · BOUNDED (rotation) ────────────────────────────────────────────── */

describe('bounded — the log rotates at the cap, keeping ONE generation', () => {
  it('the live file is held under the cap and the previous generation survives the rotation', () => {
    const maxBytes = 1000;
    const log = new OpLog(root, 'r6', 'tester', { maxBytes });
    const pad = 'x'.repeat(120);
    for (let i = 0; i < 40; i++) log.line({ event: 'command', command: `cmd-${i}`, outcome: 'ok', inputs: { pad } });
    const file = logPath(root);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(maxBytes);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(maxBytes);
    // the newest line is in the live file, the oldest survived for a while in .1, and the
    // generation count is FIXED (a third file would mean unbounded growth)
    expect(readFileSync(file, 'utf8')).toContain('cmd-39');
    expect(existsSync(`${file}.2`)).toBe(false);
    // the read spans the rotation (oldest first), and the whole history is bounded
    const page = readOpLog(root, { tail: 1_000_000 });
    expect(page.total).toBeGreaterThan(0);
    expect(page.total).toBeLessThan(80);
    expect(page.lines[page.lines.length - 1].command).toBe('cmd-39');
  });

  it('the default cap is a constant, documented and never zero (a cap of 0 would rotate every line)', () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});

/* ── AC-4 · THE DEBUG READ ───────────────────────────────────────────────── */

describe('the read — tail + filter by task · run · level · time', () => {
  const seed = (): OpLog => {
    const log = new OpLog(root, 'run-a', 'tester', { secrets: [] });
    log.line({ event: 'command', command: 'journey', outcome: 'ok', taskId: '01-leg/01-a' });
    log.line({ event: 'write', command: 'spawn!', outcome: 'refused:exists', level: 'warn', taskId: '01-leg/01-a' });
    log.line({ event: 'phase', command: 'run!', phase: 'execute', outcome: 'enter', taskId: '01-leg/02-b' });
    new OpLog(root, 'run-b', 'tester', { secrets: [] }).line({ event: 'command', command: 'check', outcome: 'exit-1', level: 'warn' });
    return log;
  };

  it('returns the whole log as an ordered, filtered tail', () => {
    seed();
    const all = readOpLog(root, {});
    expect(all.total).toBe(4);
    expect(all.filtered).toBe(4);
    expect(all.shown).toBe(4);
    expect(all.lines.map((l) => l.outcome)).toEqual(['ok', 'refused:exists', 'enter', 'exit-1']); // file order
    expect(all.skipped).toBe(0);
    expect(all.file).toBe(logPath(root));
  });

  it('filters by task, by run and by the level FLOOR (warn shows warn + error)', () => {
    seed();
    expect(readOpLog(root, { task: '01-leg/01-a' }).lines).toHaveLength(2);
    expect(readOpLog(root, { run: 'run-b' }).lines).toHaveLength(1);
    expect(readOpLog(root, { level: 'warn' }).lines.map((l) => l.outcome)).toEqual(['refused:exists', 'exit-1']);
    expect(readOpLog(root, { level: 'info' }).lines).toHaveLength(4);
    expect(readOpLog(root, { task: '01-leg/02-b', level: 'warn' }).lines).toHaveLength(0);
  });

  it('tails by count (the default is a tail, never the whole file) and filters by time', () => {
    seed();
    expect(readOpLog(root, { tail: 2 }).lines.map((l) => l.outcome)).toEqual(['enter', 'exit-1']);
    expect(readOpLog(root, {}).shown).toBeLessThanOrEqual(50); // DEFAULT_TAIL
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(readOpLog(root, { since: future }).lines).toHaveLength(0);
    expect(readOpLog(root, { since: '1h' }).lines).toHaveLength(4); // a relative window
  });

  it('a missing file is an EMPTY page, a torn line is counted — the read never throws', () => {
    const empty = readOpLog(join(root, 'nowhere'), {});
    expect(empty).toMatchObject({ total: 0, filtered: 0, shown: 0, skipped: 0, lines: [] });
    seed();
    writeFileSync(logPath(root), readFileSync(logPath(root), 'utf8') + '{torn\n');
    const page = readOpLog(root, {});
    expect(page.skipped).toBe(1);
    expect(page.lines).toHaveLength(4);
  });

  it('parseSince reads an ISO instant and a relative window, and refuses nonsense', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    expect(parseSince('2026-09-14T11:00:00.000Z', now)).toBe(now - 3_600_000);
    expect(parseSince('30m', now)).toBe(now - 1_800_000);
    expect(parseSince('2h', now)).toBe(now - 7_200_000);
    expect(parseSince('1d', now)).toBe(now - 86_400_000);
    expect(parseSince('yesterday', now)).toBeUndefined();
    expect(parseSince(undefined, now)).toBeUndefined();
  });
});
