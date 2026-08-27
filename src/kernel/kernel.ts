import { Store } from '../store/store.js';
import { Commands, FrontmostReady, LookBack } from '../commands/index.js';
import { assemblePacket, ContextPacket } from '../engines/context.js';
import { RuleFinding, RuleModule, ValidatorContext } from '../engines/validators/types.js';
import { ProviderAdapter } from '../adapters/provider/index.js';
import { loadProviderRegistry } from '../adapters/provider/registry.js';
import { StepRegistry } from './registry.js';
import { createExecutorSet } from './executor.js';
import { resolveFlow, validateChain, ChainProblem, FlowConfig } from './flow.js';
import { EvidenceRecord, Step, StepContext, StepResult } from './step.js';

/**
 * The planner kernel (S5) — the thin orchestrator (R3-D3): calls ABSTRACT step
 * functions via the step registry; never knows a concrete step's internals.
 *
 * Lifecycle per flow-control-spec v6: spawn → materialize → [GATE①] → validate →
 * activate → execute → verify → [GATE②] → commit → LOOK-BACK → advance.
 * Human gates are the runner's (agent/human) job via the CLI; the kernel provides
 * the deterministic machinery between them. Writes go ONLY through the store's
 * single writer (LB-3): evidence events at the emission points (R3-D2).
 */

// Look-back's shapes live at L1 now (core-design §1: look-back is a derived view).
export type { FrontmostReady, LookBack } from '../commands/index.js';

export interface MaterializeResult {
  packet: ContextPacket;
  /** Resolution ladder (flow-control v6 §4): per missing input, the rung + why.
   *  v1 names the blocker (fail-closed) — derive/probe/infer/ask are exercised by
   *  the runner; nothing is silently resolved here. */
  ladder: Array<{ input: string; rung: 'derive' | 'probe' | 'infer' | 'ask' | 'block'; reason: string }>;
}

export interface ValidateResult {
  ok: boolean;
  findings: RuleFinding[];
}

export interface StepOutcome {
  step: string;
  result: StepResult;
  /** The step's OWN co-located rules run against the result (verify, R3-D5). */
  ruleFindings: RuleFinding[];
}

export interface ExecuteResult {
  flow: FlowConfig;
  chainProblems: ChainProblem[];
  outcomes: StepOutcome[];
  /** The task's first failing step (chain stops there) — fail-closed, never silent. */
  failedAt?: string;
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  findings: string[];
}

export interface CommitInput {
  sha: string;
  note?: string;
  refs?: string[];
}

export interface AdvanceResult {
  leg: string;
  action: 'continue-leg' | 'advance-leg' | 'closure-needed' | 'none';
  detail: string;
}

const REJECT_BOUND = 3; // flow-control v6 §3: 3 rejection cycles per gate, then escalate

export class PlannerKernel {
  private readonly root: string;

  constructor(
    private readonly store: Store,
    private readonly registry: StepRegistry,
    /** The frozen ProviderAdapter — the ONLY way steps reach an LLM (AC-4). Tests substitute a mock. */
    private readonly adapter: ProviderAdapter,
    /** The human channel (S8 seam) — interactive steps (idea validation) fail closed without one. */
    private readonly interactor?: import('./interact.js').Interactor,
  ) {
    this.root = store.root;
  }

  /* ── activate: frontmost-ready selection (AC-2, flow-control v6 §2) ─────────── */

  /** Look-back is an L1 DERIVED VIEW (core-design §1) — this kernel delegates to it
   *  rather than carrying a second copy of the derivation. */
  frontmostReady(): FrontmostReady | undefined {
    return new Commands(this.store).frontmostReady();
  }

  /* ── LOOK-BACK (flow-control v6 §2a — the observer action, derived from events) ── */

  lookBack(): LookBack {
    return new Commands(this.store).lookBack();
  }

  /* ── materialize (flow-control v6 §2/§4 — the context packet + resolution ladder) ── */

  materialize(taskId: string): MaterializeResult {
    const packet = assemblePacket(this.store, taskId);
    const ladder: MaterializeResult['ladder'] = [];
    for (const d of packet.dependencies) {
      if (d.status !== 'missing') continue;
      // The ladder (v6 §4): derive → probe → infer → ask → block. v1 kernel names
      // the missing input and blocks — the RUNNER resolves (derive from ancestors /
      // probe the tree / ask the human); nothing is silently inferred (design §4).
      ladder.push({
        input: d.name,
        rung: 'block',
        reason: `missing requiredInput '${d.name}' — resolve via the ladder (derive → probe → infer → ask) before execution; infer is FORBIDDEN when impact is high and no safe fallback (silent-inference rule)`,
      });
    }
    return { packet, ladder };
  }

  /* ── validate (flow-control v6 §2 — deterministic checks; judgment stays with S6) ── */

  validate(taskId: string): ValidateResult {
    const findings: RuleFinding[] = [];
    // gate gaps (F7: gates enforced from the log)
    for (const p of this.store.gateProblems(taskId)) {
      findings.push({ severity: 'error', code: 'gate-gap', detail: p, nodeId: taskId });
    }
    // contract self-sufficiency (F-AC19: ACs + grounded inputs declared at spawn)
    for (const p of this.store.contractProblems(this.store.contractOf(taskId))) {
      findings.push({ severity: 'error', code: 'contract', detail: p, nodeId: taskId });
    }
    // packet readiness (inputs resolved + no blocking question unanswered)
    const { packet } = this.materialize(taskId);
    for (const b of packet.readiness.blockers) {
      findings.push({ severity: 'error', code: 'readiness', detail: b, nodeId: taskId });
    }
    // artifact gate: children only after the node's artifact exists (v6 §2 commit).
    // Applies to TASK parents (depth ≥ 3) — a leg parent carries no events by
    // design (v8 §13: legs' gates are their tasks'), so a task directly under a
    // leg is not gated on the leg's artifacts.
    const parent = taskId.split('/').slice(0, -1).join('/');
    const parentIsTask = parent.split('/').length >= 2;
    if (parentIsTask && !this.store.parentConcluded(parent)) {
      findings.push({ severity: 'error', code: 'artifact-gate', detail: `artifact gate unmet: parent ${parent} has no artifact yet (children only after the parent's artifact exists)`, nodeId: taskId });
    }
    // ACs declared (a task with no ACs cannot be verified)
    const acs = packet.nodeContract.acceptanceCriteria ?? [];
    if (!acs.length) {
      findings.push({ severity: 'error', code: 'no-acs', detail: 'task contract declares no acceptanceCriteria — a task must be verifiable (F-AC19)', nodeId: taskId });
    }
    return { ok: findings.length === 0, findings };
  }

  /* ── bounded rework (AC-3, flow-control v6 §3): 3 rejections per gate, then escalate ── */

  private rejectionCount(taskId: string, gate: string): number {
    return this.store.events(taskId).filter((e) => e.type === 'rejected' && e.gate === gate).length;
  }

  reworkStatus(taskId: string): { grillRejects: number; confirmRejects: number; escalated: boolean } {
    const grillRejects = this.rejectionCount(taskId, 'grill');
    const confirmRejects = this.rejectionCount(taskId, 'confirm');
    return { grillRejects, confirmRejects, escalated: grillRejects >= REJECT_BOUND || confirmRejects >= REJECT_BOUND };
  }

  /* ── execute (flow-control v6 §2 — run the task's flow chain through the registry) ── */

  async execute(taskId: string): Promise<ExecuteResult> {
    const rw = this.reworkStatus(taskId);
    if (rw.escalated) {
      return {
        flow: { chain: [], source: 'builtin' },
        chainProblems: [{ at: taskId, problem: `bounded rework exhausted (${rw.grillRejects} grill / ${rw.confirmRejects} confirm rejects) — escalate to a human design decision (force-approve / restructure / block), AC-3` }],
        outcomes: [],
        ok: false,
      };
    }
    const packet = assemblePacket(this.store, taskId);
    if (!packet.readiness.ready) {
      return {
        flow: { chain: [], source: 'builtin' },
        chainProblems: packet.readiness.blockers.map((b) => ({ at: taskId, problem: b })),
        outcomes: [],
        ok: false,
      };
    }
    const flow = resolveFlow(this.store, taskId, this.root);
    if (flow.problem) {
      return { flow, chainProblems: [{ at: taskId, problem: flow.problem }], outcomes: [], ok: false };
    }
    const chainProblems = validateChain(this.registry, flow.chain, packet);
    if (chainProblems.length) {
      return { flow, chainProblems, outcomes: [], ok: false };
    }

    // Once per execution — the executor set, model and provider are task-scoped.
    const taskModel = this.taskModel(taskId);
    const providerId = this.providerId();
    const recordEvidence = (ev: EvidenceRecord) => this.recordEvidence(taskId, ev);
    const executors = createExecutorSet({ adapter: this.adapter, taskModel, providerId, interactor: this.interactor, recordEvidence });
    const outcomes: StepOutcome[] = [];
    const results: Record<string, StepResult> = {};
    const stepCtx = (resultsSoFar: Record<string, StepResult>): StepContext => ({
      taskId,
      packet,
      executors,
      store: this.store,
      model: taskModel,
      results: resultsSoFar,
      recordEvidence,
    });

    for (const id of flow.chain) {
      const step = this.registry.get(id);
      const ctx = stepCtx({ ...results });
      let result: StepResult;
      try {
        result = await step.execute(ctx);
      } catch (e) {
        result = { ok: false, blocker: `step '${id}' crashed: ${(e as Error).message} (failure is a value, never an exception-as-flow)` };
      }
      const ruleFindings = this.runStepRules(step, result, taskId);
      outcomes.push({ step: id, result, ruleFindings });
      results[id] = result;
      if (!result.ok) {
        return { flow, chainProblems: [], outcomes, failedAt: id, ok: false };
      }
      if (ruleFindings.some((f) => f.severity === 'error')) {
        return { flow, chainProblems: [], outcomes, failedAt: id, ok: false };
      }
    }
    return { flow, chainProblems: [], outcomes, ok: true };
  }

  /** Run a step's CO-LOCATED rules against its result (R3-D5: one rule class, two scopes). */
  private runStepRules(step: Step, result: StepResult, taskId: string): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const rule of step.rules) {
      if (!rule.enabled) continue;
      const ctx: ValidatorContext = { store: this.store, nodeId: taskId, result };
      try {
        out.push(...rule.run(ctx));
      } catch (e) {
        out.push({ severity: 'error', code: rule.id, detail: `step rule crashed: ${(e as Error).message}` });
      }
    }
    return out;
  }

  /* ── verify (flow-control v6 §2/§6 — ACs met + evidence; judgment stays with S6) ── */

  verify(taskId: string, executeResult?: ExecuteResult): VerifyResult {
    const findings: string[] = [];
    if (executeResult && !executeResult.ok) {
      findings.push(`execution did not complete: ${executeResult.failedAt ?? 'chain rejected'}`);
    }
    // evidence must exist: structured commit evidence OR a locked artifact (v6 §6)
    const evs = this.store.events(taskId);
    const hasEvidence = evs.some((e) => e.type === 'evidence' && Array.isArray(e.commits) && (e.commits as unknown[]).length > 0);
    const hasArtifact = evs.some((e) => e.type === 'artifact-locked');
    if (!hasEvidence && !hasArtifact) {
      findings.push('no evidence recorded — a task concludes with a locked artifact or structured commit evidence (evidence.commits[], flow-control v6 §6)');
    }
    // ACs met is JUDGMENT (S6 runner reviewer) — the kernel verifies the structural
    // side: ACs declared + evidence present + step rules passed (from executeResult).
    const acs = this.store.contract(taskId)?.contract as { acceptanceCriteria?: unknown } | undefined;
    if (!Array.isArray(acs?.acceptanceCriteria) || (acs?.acceptanceCriteria as unknown[]).length === 0) {
      findings.push('no acceptanceCriteria declared — ACs are the verification target (F-AC19)');
    }
    return { ok: findings.length === 0, findings };
  }

  /* ── commit (flow-control v6 §2/§6 — checkpoint + artifact recorded: structured commit evidence) ── */

  /** Record the structured commit evidence (v6 §6 — the implementation artifact:
   *  evidence.commits[] + refs[], machine-readable, never prose-parsed). */
  commit(taskId: string, input: CommitInput): void {
    if (!/^[0-9a-f]{7,40}$/i.test(input.sha)) throw new Error(`commit rejected: '${input.sha}' is not a git sha (fail-closed — machine-truth, never prose)`);
    this.store.appendEvent(taskId, {
      at: new Date().toISOString().slice(0, 10),
      type: 'evidence',
      commits: [{ sha: input.sha, ...(input.note ? { note: input.note } : {}) }],
      ...(input.refs?.length ? { refs: input.refs } : {}),
      note: input.note ?? `committed — structured commit evidence (${input.sha})`,
    });
  }

  /* ── advance (flow-control v6 §2/§5 — leg gate validated from logs, never assumed) ── */

  advance(): AdvanceResult {
    const legs = this.store.ids().filter((i) => !i.includes('/')).sort();
    const hasTasks = (l: string) => this.store.tasksOf(l).length > 0;
    // The leg with unfinished SPAWNED work — its next action is continue or closure.
    const working = legs.find((l) => hasTasks(l) && this.store.status(l) !== 'done');
    if (working) {
      const ready = this.store.tasksOf(working).filter((t) => ['queued', 'active'].includes(this.store.status(t)));
      if (ready.length) {
        return { leg: working, action: 'continue-leg', detail: `next task: ${ready[0]} (${this.store.status(ready[0])})` };
      }
      const done = this.store.tasksOf(working).filter((t) => ['done', 'superseded'].includes(this.store.status(t))).length;
      const blocked = this.store.tasksOf(working).filter((t) => this.store.status(t) === 'blocked').length;
      // closure-by-transfer is a GATED HUMAN decision, never automatic — the kernel
      // only reports the gate state (v6 §5, F-AC16).
      return {
        leg: working,
        action: 'closure-needed',
        detail: `leg gate UNMET: ${done} done, ${blocked} blocked, remaining not done — close via a gated closure task (transfer/defer, F-AC16) or resolve the blocked tasks`,
      };
    }
    // All spawned legs derived done → the frontmost not-done leg (the empty next
    // leg, or the goal) is where the leg gate review points.
    const front = legs.find((l) => this.store.status(l) !== 'done');
    if (!front) return { leg: '', action: 'none', detail: 'every leg derived done — journey goal complete (or needs a closure decision)' };
    const gate = this.store.legGateMet(front);
    if (!gate.met) return { leg: front, action: 'closure-needed', detail: `leg gate UNMET: ${gate.blocker} — close via a gated closure task (transfer/defer, F-AC16)` };
    return { leg: front, action: 'advance-leg', detail: `leg gate MET: all previous-leg tasks done — spawn tasks into ${front} carrying the epic goal` };
  }

  /* ── internals ─────────────────────────────────────────────────────────────── */

  /** Per-task model wiring (G2 seam, R3-D6): contract.model override → registry default. */
  /** Per-task model wiring (G2 seam, R3-D6): contract.model override → registry default. */
  private taskModel(taskId: string): string | undefined {
    const c = this.store.contractOf(taskId);
    return typeof c.model === 'string' ? c.model : undefined;
  }

  private providerId(): string | undefined {
    try {
      return loadProviderRegistry(this.root).defaultProvider;
    } catch {
      return undefined;
    }
  }

  /** The single-writer evidence path (LB-3) — the emission point for task facts. */
  private recordEvidence(taskId: string, ev: EvidenceRecord): void {
    this.store.appendEvent(taskId, {
      at: new Date().toISOString().slice(0, 10),
      type: 'evidence',
      ...(ev.note ? { note: ev.note } : {}),
      ...(ev.refs?.length ? { refs: ev.refs } : {}),
      ...(ev.commits?.length ? { commits: ev.commits } : {}),
    });
  }
}
