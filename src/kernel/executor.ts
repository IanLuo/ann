import { ProviderAdapter, CompletionOptions } from '../adapters/provider/index.js';
import { EvidenceRecord } from './step.js';

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
  tool?: UnbuiltExecutor;
  command?: UnbuiltExecutor;
  request?: UnbuiltExecutor;
}

/** Build the v1 executor set: llm wired to the provider adapter + the kernel's
 *  evidence hook; tool/command/request present as explicit unbuilt guards. */
export function createExecutorSet(opts: {
  adapter: ProviderAdapter;
  /** Evidence emission hook — wired by the kernel to the store's single writer. */
  recordEvidence: (ev: EvidenceRecord) => void;
  /** Per-task model wiring (G2 seam) — default when the call doesn't override. */
  taskModel?: string;
  /** Provider id from the adapter registry (for provenance; default = registry default). */
  providerId?: string;
}): ExecutorSet {
  const { adapter, recordEvidence, taskModel, providerId } = opts;
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
  return { llm, tool: unbuilt('tool'), command: unbuilt('command'), request: unbuilt('request') };
}
