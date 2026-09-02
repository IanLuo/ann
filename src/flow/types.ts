import { ContextPacket } from './materialize.js';
import { RuleModule } from './validators/types.js';
import { CommandError, CommandResult, ResolvedRead } from '../commands/index.js';

/**
 * L2 — THE STEP CONTRACT + THE INTENT VOCABULARY (core-design §2, §3).
 *
 *   step = { id, roles[], produces?[], rules[], decisions?[], paramsSchema?, execute(ctx) }
 *   ctx  = { taskId, packet, params?, read, abilities, prior, feedback? }
 *   out  = { ok, artifact?, verdict?, intents?[] }  |  { ok:false, error:{code, blocker} }
 *
 * A step NEVER touches the store or the CLI: state arrives injected, effects depart
 * DECLARED. Steps have no write hook. Failure is a VALUE in the locked error shape.
 */

/* ---------------- the intents (§3) ---------------- */

/** A task fact — `append!` → `evidence` (deduped per §2). */
export interface EvidenceIntent {
  kind: 'evidence';
  note: string;
  refs?: string[];
  /** The answer-recording primitive (high-impact-defaulted): {id, answer, provenance?}. */
  answers?: Array<{ id: string; answer: string; provenance?: string }>;
}

/** DEFER-RECORD: the working FILE writes immediately; the `artifact-locked` EVENT
 *  records at COMMIT, once the task's gates are accepted (§3, §4). */
export interface LockArtifactIntent {
  kind: 'lock-artifact';
  name: string;
  content?: string;
  path?: string;
  type?: string;
}

/** A leg SIBLING (depth 2 — schedulable by frontmostReady/tasksOf). DEFERS TO COMMIT
 *  alongside `lock-artifact`, so the child's requiredInputs resolve via `current()`. */
export interface ProposeSpawnIntent {
  kind: 'propose-spawn';
  id: string;
  contract: unknown;
}

/** `superseded` on the OLD LOCKER's node — the ONLY cross-task write (AC-7). The
 *  successor is THIS task's own artifact file for `name` (derived by the translator,
 *  never a caller-supplied path) — supersede! resolves it inside this task's node. */
export interface SupersedeIntent {
  kind: 'supersede';
  name: string;
  note?: string;
}

/** F-AC16 closure. */
export interface CloseIntent {
  kind: 'close';
  transferred?: { target: string; scope: string };
  deferred?: { reason: string };
  'gate-revised'?: { old: string; new: string };
}

export type Intent = EvidenceIntent | LockArtifactIntent | ProposeSpawnIntent | SupersedeIntent | CloseIntent;
export type IntentKind = Intent['kind'];

export const INTENT_KINDS: IntentKind[] = ['evidence', 'lock-artifact', 'propose-spawn', 'supersede', 'close'];

/* ---------------- the abilities (L3 implements, L2 defines) ---------------- */

export interface LlmAbility {
  /** One completion. The transcript records (prompt, completion) via the L2 record hook. */
  complete(req: { prompt: string; system?: string; model?: string; maxTokens?: number }): Promise<string>;
}

export interface ResearchFinding {
  topic: string;
  findings: string;
  sources?: string[];
}

/** The human channel — FOUR verbs. `present` is deliberately UNRECORDED (§2). */
export interface InteractAbility {
  present(text: string): Promise<void>;
  ask(question: string): Promise<string>;
  research(topics: string[]): Promise<ResearchFinding[]>;
  decide(question: string, options: string[]): Promise<string>;
}

/** The human WALKED AWAY. The one signal the interact protocol raises rather than
 *  returns: there is no answer to carry, and a blank string would read as one. A step
 *  that catches it must record the departure honestly, never infer the answer. */
export class InteractAbort extends Error {}

/** An OS process — NEVER the L1 surface. Protocol-declared; unbuilt in v1 (§8:295). */
export interface ShellAbility {
  run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** A named external tool. Protocol-declared; unbuilt in v1 (§8:295). */
export interface ToolAbility {
  call(name: string, input: unknown): Promise<unknown>;
}

export interface Abilities {
  llm: LlmAbility;
  interact: InteractAbility;
  shell?: ShellAbility;
  tool?: ToolAbility;
}

/** The L1 content read view, INJECTED (§5) — not an L3 servant. Serves cross-task
 *  committed `requiredInputs` only; same-task chain sources arrive through `prior`. */
export interface ReadView {
  resolve(name: string): CommandResult<ResolvedRead>;
}

/* ---------------- the step contract (§2) ---------------- */

/** A role the step CONSUMES. Chain data binds {role → source}; validateChain checks
 *  BOTH directions (every bound role declared, every REQUIRED role bound). */
export interface StepRole {
  name: string;
  required: boolean;
  description?: string;
}

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
}

export interface StepContext {
  taskId: string;
  packet: ContextPacket;
  /** Validated against the step's paramsSchema BEFORE injection (§1:65). */
  params?: Record<string, unknown>;
  read: ReadView;
  abilities: Abilities;
  /** Role-bound in-memory artifacts from earlier steps: {role → artifact}. */
  prior: Readonly<Record<string, unknown>>;
  /** The rework channel, SCOPED BY GATE. Marks the attempt KIND and carries the
   *  rejection text — it is NEVER the replay/rework discriminator (§2). */
  feedback?: { gate: string; text: string };
}

export interface StepVerdict {
  /** ∈ the step's decisions[]. The chain entry's verdict map routes it to a gate. */
  decision: string;
  feedback?: string;
}

export type StepOutput =
  | { ok: true; artifact?: unknown; verdict?: StepVerdict; intents?: Intent[] }
  | { ok: false; error: CommandError };

export interface Step {
  id: string;
  roles: StepRole[];
  /** The intents it MAY declare. ABSENCE = "produces NOTHING" (fail-closed) — it makes
   *  the confirm-bound deadlock check statically decidable, and the translator REFUSES
   *  an intent the step did not declare, so the declaration cannot drift (§3 rule 8). */
  produces?: IntentKind[];
  /** The step's OWN verify rules, co-located (the S4 lesson). */
  rules: RuleModule[];
  /** The verdicts it may return — the chain's verdict map is checked against this. */
  decisions?: string[];
  paramsSchema?: Record<string, ParamSpec>;
  execute(ctx: StepContext): Promise<StepOutput>;
}

/** The locked failure value, everywhere (§7). */
export const fail = (code: string, blocker: string): { ok: false; error: CommandError } => ({ ok: false, error: { code, blocker } });
