import { ProviderAdapter, Completion, CompletionOptions } from '../adapters/provider/index.js';
import { EvidenceRecord } from './step.js';
import { Interactor } from './interact.js';

/**
 * The executor protocols (S5 planner kernel — grill round 3, R3-D2, confirmed):
 *
 *   llm · tool · command · request  — protocols injected into the step's ctx.
 *
 * Each operation returns a structured result {ok, result, provenance} and EMITS:
 *   - the op-log ALWAYS (runtime: what was called, timing, retries) — the
 *     provider adapter already writes this per call (design §4 two-log trace,
 *     src/adapters/provider/oplog.ts); the executor completes the pair by
 *     emitting EVIDENCE when the outcome is a task fact;
 *   - EVIDENCE when the outcome is a task fact (a binding result, an answer, a
 *     produced artifact ref) — via the kernel's recordEvidence hook (single
 *     writer, LB-3). Executors are the emission points (R3-D2).
 *
 * v1 implements ONLY `llm` (wraps the frozen ProviderAdapter interface — task
 * AC-4/AC-5). tool/command/request stay protocol-declared, UNBUILT (no consumers
 * in v1 — R3-D6). Per-task model wiring (G2 seam) lands in the llm executor
 * injection: the kernel resolves the task's model and passes it through.
 */

/** A structured executor operation result — success or fail-closed named error. */
export type ExecutorResult<T = string> =
  | { ok: true; result: T; usage: { inputTokens: number; outputTokens: number }; provenance: { provider: string; model: string } }
  | { ok: false; error: { code: string; blocker: string } };

export interface LlmCallOptions extends CompletionOptions {
  /** When true and the call SUCCEEDS, the outcome is a task fact — the executor
   *  emits an evidence event (two-log trace at the emission point, R3-D2). */
  evidence?: boolean;
  evidenceNote?: string;
  evidenceRefs?: string[];
}

/** The llm executor — the v1 way to reach an LLM: wraps the ProviderAdapter, emits evidence. */
export interface LlmExecutor {
  complete(prompt: string, opts?: LlmCallOptions): Promise<ExecutorResult<string>>;
}

/** Protocol-declared, UNBUILT (no consumers in v1 — R3-D6). The `unbuilt` guard
 *  makes an accidental use fail loudly instead of silently doing nothing. */
export interface UnbuiltExecutor {
  unbuilt: true;
  why: string;
}

export interface ExecutorSet {
  /** The implemented executor — wraps the frozen ProviderAdapter (F17). */
  llm?: LlmExecutor;
  /** The HUMAN channel (flow-finalization 2026-08-23: the interactive idea-validation
   *  step talks to the user through this; S8 wires the real talk/UI adapter). */
  interact?: Interactor;
  tool?: UnbuiltExecutor;
  command?: UnbuiltExecutor;
  request?: UnbuiltExecutor;
}

/** Shim: the frozen ProviderAdapter interface backed by an injected llm executor —
 *  lets the S2 engines' honesty layer run unchanged behind the executor protocol
 *  (wrap engines, never rewrite — R3-D6). The llm executor's evidence emission
 *  fires when the call is a task fact (the engine output IS one). */
export const adapterFromExecutor = (llm: LlmExecutor | undefined): ProviderAdapter => ({
  async complete(prompt: string, opts?: { model?: string; maxTokens?: number }): Promise<Completion> {
    if (!llm) {
      return { ok: false, error: { code: 'provider-unavailable', blocker: 'no llm executor injected (v1: every flow needs the llm executor)' } };
    }
    const r = await llm.complete(prompt, {
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      evidence: true,
      evidenceNote: 'llm operation — task fact (emitted at the executor, R3-D2)',
    });
    return r.ok ? { ok: true, text: r.result, usage: r.usage } : { ok: false as const, error: { code: r.error.code as 'provider-unavailable' | 'bad-response' | 'invalid-config', blocker: r.error.blocker } };
  },
});

/** Build the v1 executor set: llm wired to the provider adapter + the kernel's
 *  evidence hook; interact when a human channel is provided; tool/command/request
 *  present as explicit unbuilt guards. */
export function createExecutorSet(opts: {
  adapter: ProviderAdapter;
  /** Evidence emission hook — wired by the kernel to the store's single writer. */
  recordEvidence: (ev: EvidenceRecord) => void;
  /** Per-task model wiring (G2 seam) — default when the call doesn't override. */
  taskModel?: string;
  /** Provider id from the adapter registry (for provenance; default = registry default). */
  providerId?: string;
  /** The human channel (S8 seam) — interactive steps fail closed without one. */
  interactor?: Interactor;
}): ExecutorSet {
  const { adapter, recordEvidence, taskModel, providerId, interactor } = opts;
  const llm: LlmExecutor = {
    async complete(prompt: string, callOpts?: LlmCallOptions): Promise<ExecutorResult<string>> {
      const completion = await adapter.complete(prompt, {
        ...(callOpts?.provider ? { provider: callOpts.provider } : {}),
        model: callOpts?.model ?? taskModel,
        ...(callOpts?.maxTokens !== undefined ? { maxTokens: callOpts.maxTokens } : {}),
      });
      if (!completion.ok) return completion; // fail-closed passes through — never fabricated
      if (callOpts?.evidence) {
        // The outcome is a task fact — emit the evidence event (emission point).
        recordEvidence({
          note: callOpts.evidenceNote,
          ...(callOpts.evidenceRefs?.length ? { refs: callOpts.evidenceRefs } : {}),
        });
      }
      return { ok: true, result: completion.text, usage: completion.usage, provenance: { provider: providerId ?? 'registry-default', model: callOpts?.model ?? taskModel ?? 'registry-default' } };
    },
  };
  const unbuilt = (name: string): UnbuiltExecutor => ({
    unbuilt: true,
    why: `executor '${name}' is protocol-declared but UNBUILT in v1 (R3-D6) — no consumers; build it when a step needs it`,
  });
  return { llm, ...(interactor ? { interact: interactor } : {}), tool: unbuilt('tool'), command: unbuilt('command'), request: unbuilt('request') };
}
