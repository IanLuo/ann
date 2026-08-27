import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { Transcript, boundGate, countsVerifyCycles, TraceRecord } from '../transcript.js';

/**
 * THE TRANSCRIPT (core-design §2) — replay is discriminated by TRANSCRIPT PRESENCE,
 * never by `ctx.feedback`. These tests pin the attempt boundary, the runId derivation
 * (including the verify-cycle term and the grill-phase exclusion), and the by-identity
 * replay channel with its fall-through-on-miss.
 */

let root: string;
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };
const TASK = '01-leg/01-a';

function setup(): Commands {
  root = mkdtempSync(join(tmpdir(), 'ann-trace-'));
  const dir = join(root, '.ann', 'journey', 'legs');
  mkdirSync(join(dir, '01-leg'), { recursive: true });
  writeFileSync(join(dir, '01-leg', 'node.json'), JSON.stringify({ id: '01-leg', contract: {} }));
  mkdirSync(join(dir, TASK, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, TASK, 'node.json'), JSON.stringify({ id: TASK, contract: CONTRACT, createdAt: '2026-08-27' }));
  writeFileSync(join(dir, TASK, 'events.jsonl'), JSON.stringify({ at: '2026-08-27', type: 'created' }) + '\n');
  return new Commands(new Store(root), 'test');
}

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; blocker: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.blocker}`);
  return r.value;
};

beforeEach(() => setup());
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the bound gate + the verify-cycle term (review-13 B)', () => {
  it("binds execute/confirm steps to 'confirm' and grill-bound steps to 'grill'", () => {
    expect(boundGate('execute')).toBe('confirm');
    expect(boundGate('confirm')).toBe('confirm');
    expect(boundGate('grill')).toBe('grill');
  });

  it('counts verify cycles for execute/confirm ONLY — a cycle must not move the grill boundary', () => {
    expect(countsVerifyCycles('execute')).toBe(true);
    expect(countsVerifyCycles('confirm')).toBe(true);
    expect(countsVerifyCycles('grill')).toBe(false);
  });
});

describe('runId = 1 + rejections at the bound gate + verify cycles since the latest confirm decision', () => {
  it('starts at 1 on a fresh task', () => {
    const t = new Transcript(setup(), TASK);
    expect(t.runId('execute')).toBe(1);
    expect(t.runId('grill')).toBe(1);
  });

  it('advances with each rejection AT THE BOUND GATE, and only that gate', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(c.gate(TASK, 'grill', 'reject', 'no'));
    expect(t.runId('grill')).toBe(2);
    expect(t.runId('execute')).toBe(1); // a grill rejection is not a confirm rejection
    must(c.gate(TASK, 'grill', 'accept'));
    must(c.gate(TASK, 'confirm', 'reject', 'not yet'));
    expect(t.runId('execute')).toBe(2);
    expect(t.runId('grill')).toBe(2);
  });

  it('advances with each VERIFY CYCLE for execute/confirm — and NEVER for grill', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.recordVerifyCycle(1));
    must(t.recordVerifyCycle(2));
    expect(t.runId('execute')).toBe(3);
    expect(t.runId('grill')).toBe(1); // the human at the confirmed grill gate is never re-interviewed
  });

  it('RESETS the verify-cycle term at the latest gate decision at confirm', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.recordVerifyCycle(1));
    expect(t.verifyCycles()).toBe(1);
    must(c.gate(TASK, 'grill', 'accept'));
    must(c.gate(TASK, 'confirm', 'reject', 'rework'));
    expect(t.verifyCycles()).toBe(0); // the anchor moved — cycles reset per rework pass
    expect(t.runId('execute')).toBe(2); // 1 + one confirm rejection + zero cycles
  });
});

describe('the ATTEMPT BOUNDARY = the LATER of (latest rejected at the bound gate, latest verify record)', () => {
  it('is the rejection when no verify cycle follows it', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(c.gate(TASK, 'grill', 'reject', 'no'));
    const rejectedAt = c.events(TASK).findIndex((e) => e.type === 'rejected');
    expect(t.boundary('grill')).toBe(rejectedAt);
  });

  it('moves to the verify record when that is later — for execute, not for grill', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(c.gate(TASK, 'grill', 'reject', 'no'));
    const rejectedAt = c.events(TASK).findIndex((e) => e.type === 'rejected');
    must(t.recordVerifyCycle(1));
    expect(t.boundary('execute')).toBeGreaterThan(rejectedAt);
    expect(t.boundary('grill')).toBe(rejectedAt);
  });
});

describe('TRANSCRIPT PRESENCE is the discriminator', () => {
  it('a step with no record post-dating the boundary is FRESH; with one, it REPLAYS', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    expect(t.isReplay('spec', 'execute')).toBe(false);
    must(t.channel('spec', 'execute').record({ kind: 'llm', prompt: 'p', completion: 'c' }));
    expect(t.isReplay('spec', 'execute')).toBe(true);
  });

  it('a NEW rejection makes it fresh again — the old records are behind the boundary', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.channel('spec', 'execute').record({ kind: 'llm', prompt: 'p', completion: 'c' }));
    must(c.gate(TASK, 'grill', 'accept'));
    must(c.gate(TASK, 'confirm', 'reject', 'rework'));
    expect(t.isReplay('spec', 'execute')).toBe(false);
    expect(t.runId('execute')).toBe(2);
  });

  it('a VERIFY CYCLE makes an execute step fresh — without the term a retry would replay and fail identically', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.channel('spec', 'execute').record({ kind: 'llm', prompt: 'p', completion: 'c' }));
    expect(t.isReplay('spec', 'execute')).toBe(true);
    must(t.recordVerifyCycle(1));
    expect(t.isReplay('spec', 'execute')).toBe(false);
  });
});

describe('the replay channel — served BY IDENTITY, a MISS falls through', () => {
  it('serves the recorded completion and the recorded answers, never re-interviewing', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    const write = t.channel('idea-validate', 'grill');
    must(write.record({ kind: 'llm', prompt: 'grill this', completion: 'the completion' }));
    must(write.record({ kind: 'ask', question: 'ship it?', answer: 'yes' }));
    must(write.record({ kind: 'decide', question: 'which?', answer: 'b', options: ['a', 'b'] }));
    must(write.record({ kind: 'research', question: 'x|y', research: [{ topic: 'x', findings: 'f' }] }));

    const replay = new Transcript(c, TASK).channel('idea-validate', 'grill');
    expect(replay.llm('grill this')).toBe('the completion');
    expect(replay.ask('ship it?')).toBe('yes');
    expect(replay.decide('which?')).toBe('b');
    expect(replay.research('x|y')).toEqual([{ topic: 'x', findings: 'f' }]);
  });

  it('a DIFFERENT question is a MISS — undefined, so the caller goes live (questions never drift silently)', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.channel('spec', 'execute').record({ kind: 'ask', question: 'old question', answer: 'a' }));
    const replay = new Transcript(c, TASK).channel('spec', 'execute');
    expect(replay.ask('a new question')).toBeUndefined();
  });

  it('consumes in order — the same question twice is served its two answers in turn', () => {
    const c = setup();
    const w = new Transcript(c, TASK).channel('spec', 'execute');
    must(w.record({ kind: 'ask', question: 'q', answer: 'first' }));
    must(w.record({ kind: 'ask', question: 'q', answer: 'second' }));
    const replay = new Transcript(c, TASK).channel('spec', 'execute');
    expect(replay.ask('q')).toBe('first');
    expect(replay.ask('q')).toBe('second');
    expect(replay.ask('q')).toBeUndefined();
  });

  it('a miss appends at the NEXT seq under the SAME runId — fresh records never collide', () => {
    const c = setup();
    const w = new Transcript(c, TASK).channel('spec', 'execute');
    must(w.record({ kind: 'llm', prompt: 'a', completion: '1' }));
    const resumed = new Transcript(c, TASK).channel('spec', 'execute');
    expect(resumed.llm('a')).toBe('1'); // the stranded record is served
    must(resumed.record({ kind: 'llm', prompt: 'b', completion: '2' })); // the miss goes live
    const traces = c.events(TASK).map((e) => e.trace as TraceRecord).filter(Boolean);
    expect(traces.map((t) => [t.runId, t.seq])).toEqual([[1, 0], [1, 1]]);
  });

  it('the frame-phase kinds carry NO step key: verify {cycle}, skip {stepId, condition, evaluated:false}', () => {
    const c = setup();
    const t = new Transcript(c, TASK);
    must(t.recordVerifyCycle(2));
    must(t.recordSkip('envision', 'hasOutput:review'));
    const traces = c.events(TASK).map((e) => e.trace as TraceRecord).filter(Boolean);
    expect(traces[0]).toEqual({ kind: 'verify', cycle: 2 });
    expect(traces[1]).toEqual({ kind: 'skip', stepId: 'envision', condition: 'hasOutput:review', evaluated: false });
  });
});
