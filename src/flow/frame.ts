import { existsSync, readFileSync } from 'node:fs';
import { Commands, CommandError, LookBack } from '../commands/index.js';
import { assemblePacket, ContextPacket } from '../engines/context.js';
import { RuleFinding } from '../engines/validators/types.js';
import { blobSha, stripMarkers } from '../store/sha.js';
import { JourneyEvent } from '../store/store.js';
import { ChainEntry, executionOrder, phaseOf, resolveChain, StepLookup, validateChain, Phase } from './chain.js';
import { GeneralConfig, resolveConfig, VERIFY_FAIL_CYCLES_CEILING } from './config.js';
import { CommitRecord, IntentTranslator } from './intents.js';
import { Transcript } from './transcript.js';
import { Abilities, ReadView, Step, StepContext, StepOutput, StepVerdict } from './types.js';

/**
 * L2 — THE FRAME (core-design §4). The RESUMABLE COORDINATOR.
 *
 *   materialize → GATE·grill → validate → activate → execute → verify
 *                → GATE·confirm → commit → look-back → advance
 *
 * RESUMABLE, NOT RESTARTABLE. The resume point is DERIVED FROM THE EVENT TAIL, in
 * FOUR states (§1):
 *   1. last-at-gate `confirmed`  → skip the gate WRITE (the step still re-runs from
 *                                  the transcript — a decided gate skips the write,
 *                                  never the step)
 *   2. `submitted` undecided     → block and wait
 *   3. last `rejected`           → the rework rung runs; the gate IS re-obtained
 *   4. `waiting`, no later commit evidence → block and wait (the empty-chain verify-wait)
 *
 * `execute` is NEVER SKIPPED; its replay safety is intent idempotence + the transcript.
 * FRAME-WRITE IDEMPOTENCE: `activated`/`completed`/`failed` already in the tail are not
 * re-written. The frame never writes directly — every write goes through L1.
 */

export type FrameStop =
  | 'not-ready'
  | 'blocked-at-gate'
  | 'blocked-waiting'
  | 'escalated'
  | 'failed'
  | 'completed';

export interface StepOutcome {
  step: string;
  phase: Phase;
  /** false when the step was SKIPPED by its `when` condition (recorded as kind:'skip'). */
  ran: boolean;
  replayed: boolean;
  runId: number;
  result?: StepOutput;
  ruleFindings: RuleFinding[];
}

export interface FrameResult {
  taskId: string;
  stop: FrameStop;
  /** The phase the frame stopped in — never assumed, always named. */
  phase: string;
  problems: string[];
  chain: ChainEntry[];
  outcomes: StepOutcome[];
  verifyCycles: number;
  committed?: CommitRecord;
  lookBack?: LookBack;
  advance?: string;
}

export interface FrameDeps {
  commands: Commands;
  root: string;
  registry: StepLookup;
  abilities: Abilities;
}

/** The last gate write at a gate — the tail state the resume rule reads. */
type GateState = 'confirmed' | 'rejected' | 'submitted' | 'none';

const today = (): string => new Date().toISOString().slice(0, 10);

export class Frame {
  private readonly commands: Commands;
  private readonly root: string;
  private readonly registry: StepLookup;
  private readonly abilities: Abilities;

  constructor(deps: FrameDeps) {
    this.commands = deps.commands;
    this.root = deps.root;
    this.registry = deps.registry;
    this.abilities = deps.abilities;
  }

  /** The read view (§5) — an L1 derived read INJECTED into steps, not an L3 servant. */
  private get read(): ReadView {
    return { resolve: (name: string) => this.commands.read(name) };
  }

  async run(taskId: string): Promise<FrameResult> {
    const base: FrameResult = { taskId, stop: 'not-ready', phase: 'materialize', problems: [], chain: [], outcomes: [], verifyCycles: 0 };

    /* ── config + chain (data; a problem fails closed, never proceeds) ───────── */
    const { config, problems: configProblems } = resolveConfig(this.root);
    if (configProblems.length) return { ...base, phase: 'config', problems: configProblems };

    let flow;
    try {
      flow = resolveChain(this.commands.store, taskId, this.root);
    } catch (e) {
      return { ...base, phase: 'config', problems: [(e as Error).message] };
    }
    if (flow.problem) return { ...base, phase: 'config', problems: [flow.problem], chain: flow.chain };

    /* ── materialize (the packet; the resolution ladder's `block` rung) ──────── */
    const packet = assemblePacket(this.commands.store, taskId);
    if (!packet.readiness.ready) return { ...base, problems: packet.readiness.blockers, chain: flow.chain };

    const chainProblems = validateChain(this.registry, flow.chain, packet, config);
    if (chainProblems.length) {
      return { ...base, phase: 'validate-chain', problems: chainProblems.map((p) => `${p.at}: ${p.problem}`), chain: flow.chain };
    }

    const result: FrameResult = { ...base, chain: flow.chain };
    const transcript = new Transcript(this.commands, taskId);

    /* ── GATE · grill ───────────────────────────────────────────────────────── */
    const grill = await this.gate('grill', taskId, flow.chain, packet, transcript, result, {}, new IntentTranslator(this.commands, taskId));
    if (grill) return grill;

    /* ── validate + activate (the frame's own write, idempotent on replay) ──── */
    result.phase = 'activate';
    if (!this.hasEvent(taskId, 'activated')) {
      const a = this.commands.append(taskId, { at: today(), type: 'activated', note: 'activated by the frame' } as unknown as JourneyEvent);
      if (!a.ok) return this.stopFailed(taskId, result, a.error);
    }

    /* ── execute → verify → GATE·confirm → commit ───────────────────────────── */
    let feedback = this.latestRejection(taskId, 'confirm');
    for (;;) {
      const cycles = this.verifyBudget(flow.chain, config);
      let verifyFindings: string[] = [];

      for (let cycle = 0; cycle < cycles; cycle++) {
        result.phase = 'execute';
        result.outcomes = [];
        const translator = new IntentTranslator(this.commands, taskId);
        const executed = await this.execute(taskId, flow.chain, packet, transcript, translator, result, feedback);
        if (executed) return executed;

        result.phase = 'verify';
        verifyFindings = this.verify(taskId, flow.chain, translator, result);
        if (!verifyFindings.length) {
          const confirmed = await this.confirmAndCommit(taskId, flow.chain, packet, transcript, translator, result);
          return confirmed;
        }

        // EMPTY CHAIN (flow 2): a verify failure is "the runner has not committed yet"
        // — a WAIT condition, not a defect. verifyFailCycles is context-INERT here.
        if (!flow.chain.length) {
          result.phase = 'verify';
          result.problems = verifyFindings;
          // tail state 4, written once: an undischarged `waiting` is already the block
          if (!this.pendingWait(taskId)) {
            const w = this.commands.append(taskId, { at: today(), type: 'waiting', note: verifyFindings.join('; ') } as unknown as JourneyEvent);
            if (!w.ok) return this.stopFailed(taskId, result, w.error);
          }
          return { ...result, stop: 'blocked-waiting' };
        }

        // a cycle ADVANCES the attempt boundary + runId for execute/confirm steps
        const rec = transcript.recordVerifyCycle(cycle + 1);
        if (!rec.ok) return this.stopFailed(taskId, result, rec.error);
        result.verifyCycles = cycle + 1;
        feedback = verifyFindings.join('; ');
      }

      // the ceiling is reached — `failed`, with the finding as the named blocker
      result.problems = verifyFindings;
      return this.stopFailed(taskId, result, {
        code: 'verify-ceiling',
        blocker: `verify failed ${cycles}× (flow.verifyFailCycles, ceiling ${VERIFY_FAIL_CYCLES_CEILING}): ${verifyFindings.join('; ')}`,
      });
    }
  }

  /* ══ the gate phases ═══════════════════════════════════════════════════════ */

  /**
   * Obtain a gate decision. ONE SOURCE: a chain step bound to this gate, or — when the
   * chain binds none — the frame's own present-via-interact. Acquisition is TWO L1
   * writes: `submit!` then `gate! accept|reject`.
   *
   * Returns a FrameResult to stop on, or undefined to continue.
   */
  private async gate(
    gate: 'grill' | 'confirm',
    taskId: string,
    chain: ChainEntry[],
    packet: ContextPacket,
    transcript: Transcript,
    result: FrameResult,
    submitOpts: { confirmedSha?: string } = {},
    translator?: IntentTranslator,
  ): Promise<FrameResult | undefined> {
    result.phase = `gate:${gate}`;
    let current = packet;
    for (;;) {
      const state = this.gateState(taskId, gate);
      if (state === 'confirmed') return undefined; // tail state 1 — skip the WRITE, not the step
      if (state === 'submitted') return { ...result, stop: 'blocked-at-gate' }; // tail state 2

      // tail state 3 (`rejected`) and the first pass both land here: obtain the decision
      const source = chain.find((e) => phaseOf(e) === gate);
      let decision: { decision: 'accept' | 'reject'; feedback?: string };
      if (source && translator) {
        const outcome = await this.runStep(taskId, source, current, transcript, translator, this.latestRejection(taskId, gate));
        result.outcomes.push(outcome);
        if (outcome.result && !outcome.result.ok) return this.stopFailed(taskId, result, outcome.result.error);
        const routed = this.route(source, outcome.result?.ok ? outcome.result.verdict : undefined);
        if ('code' in routed) return this.stopFailed(taskId, result, routed);
        decision = routed;
      } else {
        decision = await this.present(taskId, gate, current);
      }

      const s = this.commands.submit(taskId, gate, submitOpts);
      if (!s.ok && s.error.code !== 'already-submitted') return this.stopFailed(taskId, result, s.error);
      const g = this.commands.gate(taskId, gate, decision.decision, decision.feedback ?? '');
      if (!g.ok) {
        // the reject bound is a CONSTANT owned by gate! — L2 reads only {escalated}
        if (g.error.code === 'reject-bound') return { ...result, stop: 'escalated', problems: [g.error.blocker] };
        return this.stopFailed(taskId, result, g.error);
      }
      if (decision.decision === 'accept') return undefined;
      if (g.value.escalated) return { ...result, stop: 'escalated', problems: [decision.feedback ?? `rejected at ${gate}`] };
      if (gate === 'confirm') return undefined; // the caller re-executes from the feedback
      // a grill rejection RE-MATERIALIZES from the feedback (LOCKED routing) — the
      // rework rung runs and the gate IS re-obtained, bounded by gate!'s constant
      current = assemblePacket(this.commands.store, taskId);
    }
  }

  /** The frame's own gate source — present, then collect a decision (§4). */
  private async present(taskId: string, gate: 'grill' | 'confirm', packet: ContextPacket): Promise<{ decision: 'accept' | 'reject'; feedback?: string }> {
    const contract = this.commands.contractOf(taskId);
    await this.abilities.interact.present(
      `GATE ${gate} — ${taskId}\n  intent: ${String(contract.intent ?? '')}\n  ACs: ${(contract.acceptanceCriteria as string[] | undefined)?.join(' · ') ?? '(none)'}\n  inputs: ${packet.dependencies.map((d) => `${d.name}(${d.status})`).join(', ') || '(none)'}`,
    );
    const answer = await this.abilities.interact.decide(`decide gate '${gate}' for ${taskId}`, ['accept', 'reject']);
    if (answer === 'accept') return { decision: 'accept' };
    const why = await this.abilities.interact.ask(`why is '${gate}' rejected? (the feedback routes the rework)`);
    return { decision: 'reject', feedback: why };
  }

  /** Route a step's verdict through the chain entry's verdict map — fail closed. */
  private route(entry: ChainEntry, verdict: StepVerdict | undefined): { decision: 'accept' | 'reject'; feedback?: string } | CommandError {
    if (!verdict) return { code: 'no-verdict', blocker: `step '${entry.id}' is bound to a gate but returned no verdict — the gate has no source (fail closed)` };
    const route = entry.verdict?.[verdict.decision];
    if (!route) return { code: 'unmapped-verdict', blocker: `step '${entry.id}' returned decision '${verdict.decision}', which the chain's verdict map does not route (fail closed)` };
    return { decision: route.gate, feedback: verdict.feedback ?? route.feedback };
  }

  /* ══ execute ═══════════════════════════════════════════════════════════════ */

  /** Run the chain in EXECUTION ORDER. Grill-bound steps have already run at the gate. */
  private async execute(
    taskId: string,
    chain: ChainEntry[],
    packet: ContextPacket,
    transcript: Transcript,
    translator: IntentTranslator,
    result: FrameResult,
    feedback: string | undefined,
  ): Promise<FrameResult | undefined> {
    const produced = new Map<string, StepOutput>();
    for (const entry of executionOrder(chain)) {
      if (phaseOf(entry) === 'grill') continue; // its run produced the gate decision
      if (phaseOf(entry) === 'confirm') continue; // GATE② is after verify, locked
      const skip = this.skipped(entry, produced);
      if (skip) {
        const rec = transcript.recordSkip(entry.id, skip);
        if (!rec.ok) return this.stopFailed(taskId, result, rec.error);
        result.outcomes.push({ step: entry.id, phase: 'execute', ran: false, replayed: false, runId: transcript.runId('execute'), ruleFindings: [] });
        continue;
      }
      const outcome = await this.runStep(taskId, entry, packet, transcript, translator, feedback, produced);
      result.outcomes.push(outcome);
      if (outcome.result && !outcome.result.ok) return this.stopFailed(taskId, result, outcome.result.error);
      if (outcome.ruleFindings.some((f) => f.severity === 'error')) {
        return this.stopFailed(taskId, result, {
          code: 'step-rules',
          blocker: `step '${entry.id}' failed its co-located rules: ${outcome.ruleFindings.filter((f) => f.severity === 'error').map((f) => f.detail).join('; ')}`,
        });
      }
      if (outcome.result?.ok) produced.set(entry.id, outcome.result);
    }
    return undefined;
  }

  /** One step run: params + prior injected, intents translated, co-located rules run. */
  private async runStep(
    taskId: string,
    entry: ChainEntry,
    packet: ContextPacket,
    transcript: Transcript,
    translator: IntentTranslator,
    feedback: string | undefined,
    produced: Map<string, StepOutput> = new Map(),
  ): Promise<StepOutcome> {
    const phase = phaseOf(entry);
    const step = this.registry.get(entry.id);
    const runId = transcript.runId(phase);
    const replayed = transcript.isReplay(entry.id, phase);
    const outcome: StepOutcome = { step: entry.id, phase, ran: true, replayed, runId, ruleFindings: [] };

    // `prior` — role-bound in-memory artifacts; a cross-task source resolves via `read`
    const prior: Record<string, unknown> = {};
    for (const [role, source] of Object.entries(entry.inputs ?? {})) {
      const fromChain = produced.get(source);
      if (fromChain?.ok) prior[role] = fromChain.artifact;
      else {
        const r = this.commands.read(source);
        if (r.ok) prior[role] = r.value.content;
      }
    }

    const ctx: StepContext = {
      taskId,
      packet,
      ...(entry.params ? { params: entry.params } : {}),
      read: this.read,
      abilities: this.abilities,
      prior,
      ...(feedback ? { feedback: { gate: phase === 'grill' ? 'grill' : 'confirm', text: feedback } } : {}),
    };

    let out: StepOutput;
    try {
      out = await step.execute(ctx);
    } catch (e) {
      out = { ok: false, error: { code: 'step-crashed', blocker: `step '${entry.id}' crashed: ${(e as Error).message} (failure is a value, never an exception-as-flow)` } };
    }
    outcome.result = out;
    if (out.ok) {
      const t = translator.translate(step, out.intents);
      if (!t.ok) outcome.result = { ok: false, error: t.error };
      else outcome.ruleFindings = this.runStepRules(step, taskId, out);
    }
    return outcome;
  }

  /** The step's OWN co-located rules, run against its result (one rule class, two scopes). */
  private runStepRules(step: Step, taskId: string, result: StepOutput): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const rule of step.rules) {
      if (!rule.enabled) continue;
      try {
        out.push(...rule.run({ store: this.commands.store, nodeId: taskId, result } as never));
      } catch (e) {
        out.push({ severity: 'error', code: rule.id, detail: `step rule crashed: ${(e as Error).message}` });
      }
    }
    return out;
  }

  /** A `when` condition that evaluates FALSE — returns its name, or undefined to run. */
  private skipped(entry: ChainEntry, produced: Map<string, StepOutput>): string | undefined {
    if (!entry.when) return undefined;
    if (entry.when.hasOutput) {
      const out = produced.get(entry.when.hasOutput);
      return out?.ok && out.artifact !== undefined ? undefined : `hasOutput:${entry.when.hasOutput}`;
    }
    const q = entry.when.verdict!;
    const out = produced.get(q.step);
    const decision = out?.ok ? out.verdict?.decision : undefined;
    return decision === q.decision ? undefined : `verdict:${q.step}=${q.decision}`;
  }

  /* ══ verify ════════════════════════════════════════════════════════════════ */

  /** verifyFailCycles, with the EMPTY CHAIN forced to 1 (context-inert, not a clamp). */
  private verifyBudget(chain: ChainEntry[], config: GeneralConfig): number {
    return chain.length ? Math.min(config.flow.verifyFailCycles, VERIFY_FAIL_CYCLES_CEILING) : 1;
  }

  /**
   * OUTPUTS PRODUCED + ACs + step rules. Judgment stays with the runner.
   * Events record at COMMIT, so verify checks OUTPUTS — the materialized working files
   * and the observed `evidence.commits[]` — never the acceptance events.
   */
  private verify(taskId: string, chain: ChainEntry[], translator: IntentTranslator, result: FrameResult): string[] {
    const findings: string[] = [];
    const acs = this.commands.contractOf(taskId).acceptanceCriteria;
    if (!Array.isArray(acs) || !acs.length) findings.push('no acceptanceCriteria declared — ACs are the verification target (F-AC19)');

    const locks = translator.deferred.locks;
    for (const l of locks) {
      if (!existsSync(l.workingPath)) findings.push(`declared artifact '${l.name}' has no working file at ${l.workingPath}`);
      else if (!stripMarkers(readFileSync(l.workingPath, 'utf8')).trim()) findings.push(`artifact '${l.name}' is empty`);
    }

    const committed = this.commitEvidence(taskId);
    if (!locks.length && !committed.length) {
      findings.push(
        chain.length
          ? 'the chain produced no artifact and no commit evidence — a task concludes with a locked artifact or evidence.commits[]'
          : 'waiting for the runner: no evidence.commits[] recorded since activation (empty chain — the runner does the work)',
      );
    }
    for (const o of result.outcomes) {
      for (const f of o.ruleFindings) if (f.severity === 'error') findings.push(`${o.step}: ${f.detail}`);
    }
    return findings;
  }

  /* ══ confirm + commit ══════════════════════════════════════════════════════ */

  private async confirmAndCommit(
    taskId: string,
    chain: ChainEntry[],
    packet: ContextPacket,
    transcript: Transcript,
    translator: IntentTranslator,
    result: FrameResult,
  ): Promise<FrameResult> {
    // THE GATE② CONTENT BINDING: submit!(confirm) records the working artifact's sha
    const primary = translator.deferred.locks[0];
    const confirmedSha = primary && existsSync(primary.workingPath) ? blobSha(stripMarkers(readFileSync(primary.workingPath, 'utf8'))).slice(0, 7) : undefined;

    const stop = await this.gate('confirm', taskId, chain, packet, transcript, result, confirmedSha ? { confirmedSha } : {}, translator);
    if (stop) return stop;
    if (this.gateState(taskId, 'confirm') !== 'confirmed') {
      // rejected → RE-EXECUTE from the feedback (LOCKED routing — never supersede)
      return { ...result, stop: 'blocked-at-gate', phase: 'gate:confirm', problems: [this.latestRejection(taskId, 'confirm') ?? 'rejected at confirm'] };
    }

    /* ── commit — the deferred intents RECORD here; every task concludes ─────── */
    result.phase = 'commit';
    const recorded = translator.commit(confirmedSha ? { confirmedSha: this.submittedSha(taskId) ?? confirmedSha } : {});
    if (!recorded.ok) return this.stopFailed(taskId, result, recorded.error);
    result.committed = recorded.value;

    if (!this.hasEvent(taskId, 'completed')) {
      const c = this.commands.append(taskId, { at: today(), type: 'completed', note: 'completed by the frame' } as unknown as JourneyEvent);
      if (!c.ok) return this.stopFailed(taskId, result, c.error);
    }

    /* ── look-back + advance (derived reads — never assumed) ─────────────────── */
    result.phase = 'advance';
    const lookBack = this.commands.lookBack();
    return {
      ...result,
      stop: 'completed',
      lookBack,
      advance: lookBack.frontmostReady
        ? `next: ${lookBack.frontmostReady.task} (${lookBack.frontmostReady.status})`
        : lookBack.legGate.met
          ? 'leg gate MET — spawn the next leg'
          : `leg gate UNMET: ${lookBack.legGate.blocker}`,
    };
  }

  /* ══ tail reads + the failure write ════════════════════════════════════════ */

  private gateState(taskId: string, gate: string): GateState {
    const evs = this.commands.events(taskId).filter((e) => ['submitted', 'confirmed', 'rejected'].includes(e.type) && e.gate === gate);
    const last = evs[evs.length - 1];
    return (last?.type as GateState) ?? 'none';
  }

  /** Tail state 4: a `waiting` record with NO subsequent commit evidence still stands. */
  private pendingWait(taskId: string): boolean {
    const evs = this.commands.events(taskId);
    const last = evs.map((e) => e.type).lastIndexOf('waiting');
    if (last < 0) return false;
    return !evs.slice(last + 1).some((e) => e.type === 'evidence' && Array.isArray(e.commits) && (e.commits as unknown[]).length > 0);
  }

  private hasEvent(taskId: string, type: string): boolean {
    return this.commands.events(taskId).some((e) => e.type === type);
  }

  private latestRejection(taskId: string, gate: string): string | undefined {
    const rejections = this.commands.events(taskId).filter((e) => e.type === 'rejected' && e.gate === gate);
    const last = rejections[rejections.length - 1];
    return last ? (last.feedback as string | undefined) ?? (last.note as string | undefined) : undefined;
  }

  /** The sha the confirm gate actually bound to (the L1 record), if any. */
  private submittedSha(taskId: string): string | undefined {
    const submissions = this.commands.events(taskId).filter((e) => e.type === 'submitted' && e.gate === 'confirm');
    return submissions[submissions.length - 1]?.confirmedSha as string | undefined;
  }

  /** Commit evidence OBSERVED since activation — the empty-chain flow's outcome channel. */
  private commitEvidence(taskId: string): JourneyEvent[] {
    const evs = this.commands.events(taskId);
    const from = evs.map((e) => e.type).lastIndexOf('activated');
    return evs.slice(from + 1).filter((e) => e.type === 'evidence' && Array.isArray(e.commits) && (e.commits as unknown[]).length > 0);
  }

  /** Every task concludes: `failed` is written (idempotently), the blocker named. */
  private stopFailed(taskId: string, result: FrameResult, error: CommandError): FrameResult {
    const problems = [...result.problems, `${error.code}: ${error.blocker}`];
    if (!this.hasEvent(taskId, 'failed')) {
      this.commands.append(taskId, { at: today(), type: 'failed', note: `${error.code}: ${error.blocker}`.slice(0, 500) } as unknown as JourneyEvent);
    }
    return { ...result, stop: 'failed', problems };
  }
}
