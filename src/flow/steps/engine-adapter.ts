import { ProviderAdapter } from '../../abilities/llm/index.js';
import { LlmAbility } from '../types.js';

/**
 * The shim that lets the S2 engines (grilling, envision) run UNCHANGED behind the
 * ability protocol — wrap engines, never rewrite them. Their honesty layer is the
 * thing worth keeping; only the way they reach a model changed.
 *
 * The ability protocol carries the COMPLETION and nothing else: token counts live in
 * the op-log the provider adapter already writes per call. The zeros below are that
 * absence, not a measurement — anything that reports usage must read the op-log.
 */
export const adapterFromAbility = (llm: LlmAbility, taskModel?: string): ProviderAdapter => ({
  async complete(prompt: string, opts?: { model?: string; maxTokens?: number }) {
    try {
      const text = await llm.complete({
        prompt,
        ...(opts?.model ?? taskModel ? { model: opts?.model ?? taskModel } : {}),
        ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
      return { ok: true as const, text, usage: { inputTokens: 0, outputTokens: 0 } };
    } catch (e) {
      // a failure is a VALUE at every seam — never a fabricated completion
      return { ok: false as const, error: { code: 'provider-unavailable' as const, blocker: `llm ability failed — ${(e as Error).message}` } };
    }
  },
});
