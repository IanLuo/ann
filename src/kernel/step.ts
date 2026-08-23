import { Store } from '../store/store.js';
import { ContextPacket } from '../engines/context.js';
import { RuleModule } from '../engines/validators/types.js';
import { ExecutorSet } from './executor.js';

/**
 * The Step protocol (S5 planner kernel — grill round 3, R3-D1, confirmed 2026-08-23):
 *
 *   interface Step { id · inputs[] · rules[] · execute(ctx) }  — NO kind
 *
 * - `id` distinguishes a step; what the step IS is the content of `execute` (it
 *   encapsulates the capability + the real work). No `kind` field — it was redundant.
 * - `inputs` are the DECLARED input deps — chain validation + the context packet.
 *   Each input must be either a resolved packet dependency (a task requiredInput,
 *   by logical name) or an earlier step's id in the same chain run.
 * - `rules` are the step's OWN verify rules, CO-LOCATED with the step (the S4
 *   lesson: never an external rule.json). The kernel runs them against the step's
 *   result — verify semantics live here (R3-D5). One rule class, two scopes:
 *   the S4 validators stay the whole-store check surface; the step's rules are
 *   the per-step contract check.
 * - `execute(ctx)` receives the injected executor protocols (R3-D2) + the
 *   materialized context packet + earlier steps' results; it does the work and
 *   returns a StepResult. Failure is a VALUE ({ok:false, blocker}), never an
 *   exception-as-flow (architecture rung 4).
 */

/** An evidence record — a task fact (binding result · answer · produced artifact ref). */
export interface EvidenceRecord {
  refs?: string[];
  commits?: Array<{ sha: string; note?: string }>;
  note?: string;
}

/** The context every step executes against (R3-D1/2/3). */
export interface StepContext {
  /** The task this step runs for. */
  taskId: string;
  /** The materialized context packet (context-packet-spec; derived, never saved). */
  packet: ContextPacket;
  /** Injected executor protocols — the ONLY way steps reach capabilities (v1: llm). */
  executors: ExecutorSet;
  /** Derived reads only — writes go through the kernel's recordEvidence (single writer, LB-3). */
  store: Store;
  /** Per-task model wiring (G2 seam, R3-D6) — resolved from the task contract, injected into the llm executor. */
  model?: string;
  /** Earlier steps' results in this chain run — later steps consume them (e.g. spec ← envision). */
  results: Readonly<Record<string, StepResult>>;
  /** Record a task-fact evidence event (two-log trace at the emission point, R3-D2). */
  recordEvidence(ev: EvidenceRecord): void;
}

export interface StepResult {
  ok: boolean;
  /** Structured output artifact (GrillingArtifact, VisionArtifact, spec markdown …). */
  artifact?: unknown;
  /** Fail-closed named blocker (never fabricated, never empty on !ok). */
  blocker?: string;
  /** Evidence the step wants recorded alongside its result (task facts). */
  evidence?: EvidenceRecord;
}

/** A self-contained step — the kernel routes by id and calls the ABSTRACT functions
 *  (R3-D3): it never knows a concrete step's internals; steps plug in via the registry. */
export interface Step {
  id: string;
  /** Declared input deps — each must be a resolved packet dependency (logical name)
   *  or an earlier step's id in the chain run (chain validation, R3-D4). */
  inputs: string[];
  /** The step's OWN verify rules — the kernel runs them against the result (R3-D1/5). */
  rules: RuleModule[];
  execute(ctx: StepContext): Promise<StepResult>;
}
