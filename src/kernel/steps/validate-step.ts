import { Step, StepContext, StepResult } from '../step.js';
import { RuleModule } from '../../engines/validators/types.js';
import { ProviderAdapter, Completion } from '../../adapters/provider/index.js';
import { DefaultGrillingEngine, GrillingArtifact } from '../../engines/grilling.js';
import { GroundingInput } from '../../engines/shared.js';

/**
 * The 'validate' step (grilling wrapper — R3-D6: grilling becomes a step by WRAPPING,
 * no rewrite). Runs the F4 validate/grilling engine (idea exit gate) through the
 * injected llm executor — the step passes its OWN verify rules to the kernel (R3-D1).
 */

/** The step's co-located verify rule: an empty grill (no validation, no questions)
 *  cannot inform a gate — fail (flow-control v6 §7: artifact = validation + questions). */
export const grillingArtifactRule: RuleModule = {
  id: 'grilling-artifact',
  definition: 'the validate step result must carry validation[] or questions[] (an empty grill cannot inform a gate)',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepResult | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'grilling-artifact', detail: 'validate step did not produce a result' }];
    const a = r.artifact as GrillingArtifact | undefined;
    if (!a || (Array.isArray(a.validation) && a.validation.length === 0 && Array.isArray(a.questions) && a.questions.length === 0)) {
      return [{ severity: 'error', code: 'grilling-artifact', detail: 'validate step returned an empty grill (no validation, no questions) — nothing to gate on' }];
    }
    return [];
  },
};

/** Map the packet's resolved dependencies to grounding inputs (provenance preserved).
 *  Packet provenance ('derived-from') maps to the taxonomy's 'prior plan' — the
 *  closest SourceType for artifact-derived grounding (design §6 taxonomy). */
const groundingFrom = (ctx: StepContext): GroundingInput[] =>
  ctx.packet.dependencies
    .filter((d) => d.status === 'resolved' && d.excerpt)
    .map((d) => ({ label: d.name, text: d.excerpt ?? '', sourceType: 'prior plan' as const }));

/** Shim: the frozen ProviderAdapter interface backed by the injected llm executor —
 *  keeps the engines' honesty layer intact with NO engine rewrite (R3-D6). */
export const adapterFromExecutor = (executors: StepContext['executors']): ProviderAdapter => ({
  async complete(prompt: string, opts?: { model?: string; maxTokens?: number }): Promise<Completion> {
    const llm = executors.llm;
    if (!llm) {
      return { ok: false, error: { code: 'provider-unavailable', blocker: 'no llm executor injected (v1: every flow needs the llm executor)' } };
    }
    const r = await llm.complete(prompt, {
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      evidence: true,
      evidenceNote: 'validate (grilling) — task fact: validation + questions (emitted at the executor, R3-D2)',
    });
    return r.ok ? { ok: true, text: r.result, usage: r.usage } : { ok: false as const, error: { code: r.error.code as 'provider-unavailable' | 'bad-response' | 'invalid-config', blocker: r.error.blocker } };
  },
});

export class ValidateStep implements Step {
  readonly id = 'validate';
  /** Consumes the task contract + packet only — no earlier-step dependency. */
  readonly inputs: string[] = [];
  readonly rules: RuleModule[] = [grillingArtifactRule];

  async execute(ctx: StepContext): Promise<StepResult> {
    const engine = new DefaultGrillingEngine(adapterFromExecutor(ctx.executors), { model: ctx.model });
    const r = await engine.grill({
      idea: ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId,
      context: groundingFrom(ctx),
      constraints: ctx.packet.nodeContract.acceptanceCriteria,
    });
    if (!r.ok) return { ok: false, blocker: r.error.blocker };
    return { ok: true, artifact: r.artifact };
  }
}
