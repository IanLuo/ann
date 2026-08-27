import { Commands, CommandResult } from '../commands/index.js';
import { JourneyEvent } from '../store/store.js';
import { Phase } from './chain.js';
import { ResearchFinding } from './types.js';

/**
 * THE TRANSCRIPT (core-design §2) — the replay channel + the attempt discriminator.
 *
 * THE REPLAY/REWORK DISCRIMINATOR IS **TRANSCRIPT PRESENCE**, never `ctx.feedback`
 * (measured broken in review-8). An attempt is NEW when no `trace` record post-dates
 * the ATTEMPT BOUNDARY; otherwise it REPLAYS — served the recorded completions and the
 * recorded answers BY IDENTITY, so the human is never re-interviewed and the questions
 * never drift. A MISS falls through to a live call and appends at the next `seq` under
 * the SAME runId (stranded partial records are served, fresh records never collide).
 *
 *   ATTEMPT BOUNDARY = the LATER of (the latest `rejected` at the step's BOUND GATE,
 *                                    the latest verify-cycle record)
 *   runId            = 1 + (rejections at the bound gate)
 *                        + (verify cycles since the latest gate decision at `confirm`)
 *
 * THE BOUND GATE: `confirm` for `at:'execute'` steps, `grill` for grill-bound steps.
 * THE VERIFY-CYCLE TERM APPLIES TO `at:'execute'`/`at:'confirm'` STEPS ONLY — a verify
 * cycle re-enters at execute and must not move the grill phase's boundary, else the
 * discriminator re-interviews a human at a confirmed gate (review-13 B).
 */

export type TraceKind = 'llm' | 'ask' | 'research' | 'decide' | 'verify' | 'skip';

export interface TraceRecord {
  kind: TraceKind;
  /** The four step-level kinds + `skip`. Absent on `verify` (a frame-phase record). */
  stepId?: string;
  /** The replay key, with stepId + seq — step-level kinds only. */
  runId?: number;
  seq?: number;
  /** `verify` only. */
  cycle?: number;
  /** `skip` only. */
  condition?: string;
  evaluated?: false;
  prompt?: string;
  completion?: string;
  question?: string;
  answer?: string;
  research?: ResearchFinding[];
  options?: string[];
}

/** The bound gate of a step, by its chain phase (§2). */
export const boundGate = (phase: Phase): 'grill' | 'confirm' => (phase === 'grill' ? 'grill' : 'confirm');

/** Does the verify-cycle term apply to this phase? execute/confirm ONLY (review-13 B). */
export const countsVerifyCycles = (phase: Phase): boolean => phase !== 'grill';

const today = (): string => new Date().toISOString().slice(0, 10);

const traceOf = (e: JourneyEvent): TraceRecord | undefined =>
  e.type === 'evidence' && e.trace && typeof e.trace === 'object' ? (e.trace as TraceRecord) : undefined;

export class Transcript {
  constructor(
    private readonly commands: Commands,
    private readonly taskId: string,
  ) {}

  private get events(): JourneyEvent[] {
    return this.commands.events(this.taskId);
  }

  /** Every trace record in tail order, with the event index it sits at. */
  records(): Array<{ index: number; trace: TraceRecord }> {
    const out: Array<{ index: number; trace: TraceRecord }> = [];
    this.events.forEach((e, index) => {
      const trace = traceOf(e);
      if (trace) out.push({ index, trace });
    });
    return out;
  }

  /** The ATTEMPT BOUNDARY as an event index; -1 when the attempt has no boundary yet. */
  boundary(phase: Phase): number {
    const evs = this.events;
    const gate = boundGate(phase);
    let latest = -1;
    evs.forEach((e, i) => {
      if (e.type === 'rejected' && e.gate === gate) latest = i;
    });
    if (countsVerifyCycles(phase)) {
      for (const { index, trace } of this.records()) {
        if (trace.kind === 'verify' && index > latest) latest = index;
      }
    }
    return latest;
  }

  /** The number of verify cycles since the latest gate decision at `confirm`. */
  verifyCycles(): number {
    const evs = this.events;
    let anchor = -1;
    evs.forEach((e, i) => {
      if ((e.type === 'confirmed' || e.type === 'rejected') && e.gate === 'confirm') anchor = i;
    });
    return this.records().filter((r) => r.trace.kind === 'verify' && r.index > anchor).length;
  }

  /** runId = 1 + rejections at the bound gate + verify cycles (execute/confirm only). */
  runId(phase: Phase): number {
    const rejections = this.commands.rejections(this.taskId, boundGate(phase));
    return 1 + rejections + (countsVerifyCycles(phase) ? this.verifyCycles() : 0);
  }

  /** TRANSCRIPT PRESENCE: a step REPLAYS when it has a record post-dating the boundary. */
  isReplay(stepId: string, phase: Phase): boolean {
    const after = this.boundary(phase);
    return this.records().some((r) => r.index > after && r.trace.stepId === stepId && r.trace.runId === this.runId(phase));
  }

  /** The replay channel for one step run — serves by identity, records misses. */
  channel(stepId: string, phase: Phase): TranscriptChannel {
    return new TranscriptChannel(this.commands, this.taskId, stepId, this.runId(phase), this.records());
  }

  /** A frame-phase VERIFY cycle record — no stepId; it belongs to the verify phase. */
  recordVerifyCycle(cycle: number): CommandResult {
    return this.append({ kind: 'verify', cycle }, `verify cycle ${cycle}`);
  }

  /** A frame-phase SKIP record — a branch decision must be derivable from the tail. */
  recordSkip(stepId: string, condition: string): CommandResult {
    return this.append({ kind: 'skip', stepId, condition, evaluated: false }, `skipped '${stepId}': ${condition}`);
  }

  private append(trace: TraceRecord, note: string): CommandResult {
    return this.commands.append(this.taskId, { at: today(), type: 'evidence', note, trace } as unknown as JourneyEvent);
  }
}

/**
 * One step run's channel into the transcript. Lookups are BY IDENTITY (the prompt, the
 * question) and CONSUMED in order, so a step that asks the same thing twice in one run
 * is served its two recorded answers in turn.
 */
export class TranscriptChannel {
  private readonly mine: TraceRecord[];
  private readonly consumed = new Set<number>();
  private nextSeq: number;

  constructor(
    private readonly commands: Commands,
    private readonly taskId: string,
    private readonly stepId: string,
    readonly runId: number,
    all: Array<{ index: number; trace: TraceRecord }>,
  ) {
    this.mine = all.filter((r) => r.trace.stepId === stepId && r.trace.runId === runId).map((r) => r.trace);
    this.nextSeq = this.mine.reduce((max, t) => Math.max(max, (t.seq ?? 0) + 1), 0);
  }

  private take(kind: TraceKind, identity: string): TraceRecord | undefined {
    for (let i = 0; i < this.mine.length; i++) {
      if (this.consumed.has(i)) continue;
      const t = this.mine[i];
      if (t.kind !== kind) continue;
      const id = kind === 'llm' ? t.prompt : t.question;
      if (id !== identity) continue;
      this.consumed.add(i);
      return t;
    }
    return undefined;
  }

  /** A recorded completion for this prompt, or undefined — a MISS falls through live. */
  llm(prompt: string): string | undefined {
    return this.take('llm', prompt)?.completion;
  }

  ask(question: string): string | undefined {
    return this.take('ask', question)?.answer;
  }

  research(question: string): ResearchFinding[] | undefined {
    return this.take('research', question)?.research;
  }

  decide(question: string): string | undefined {
    return this.take('decide', question)?.answer;
  }

  /** THE RECORD HOOK — a fresh record at the next seq under this runId, via `append!`. */
  record(rec: Omit<TraceRecord, 'stepId' | 'runId' | 'seq' | 'cycle' | 'condition' | 'evaluated'>): CommandResult {
    const seq = this.nextSeq++;
    const trace: TraceRecord = { ...rec, stepId: this.stepId, runId: this.runId, seq };
    this.mine.push(trace);
    this.consumed.add(this.mine.length - 1); // just-recorded: never re-served in this run
    return this.commands.append(this.taskId, {
      at: today(),
      type: 'evidence',
      note: `${rec.kind} operation — task fact (${this.stepId} run ${this.runId} seq ${seq})`,
      trace,
    } as unknown as JourneyEvent);
  }
}
