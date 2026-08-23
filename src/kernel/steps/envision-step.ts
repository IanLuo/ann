import { Step, StepContext, StepResult } from '../step.js';
import { RuleModule } from '../../engines/validators/types.js';
import { DefaultEnvisionEngine, VisionArtifact } from '../../engines/envision.js';
import { adapterFromExecutor } from './validate-step.js';

/**
 * The 'envision' step (envision wrapper — R3-D6: no rewrite). Runs the F8 envision
 * engine (usage + look product vision) through the injected llm executor. The spec
 * step (F9) consumes its result via the chain (inputs: ['envision']).
 */

/** The step's co-located verify rule: an empty vision cannot build from — fail. */
export const envisionArtifactRule: RuleModule = {
  id: 'envision-artifact',
  definition: 'the envision step result must carry usage[], look[] or questions[] (an empty vision cannot build from)',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepResult | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'envision-artifact', detail: 'envision step did not produce a result' }];
    const a = r.artifact as VisionArtifact | undefined;
    if (
      !a ||
      (Array.isArray(a.usage) && a.usage.length === 0 && Array.isArray(a.look) && a.look.length === 0 && Array.isArray(a.questions) && a.questions.length === 0)
    ) {
      return [{ severity: 'error', code: 'envision-artifact', detail: 'envision step returned an empty vision (no usage, no look, no questions)' }];
    }
    return [];
  },
};

export class EnvisionStep implements Step {
  readonly id = 'envision';
  readonly inputs: string[] = [];
  readonly rules: RuleModule[] = [envisionArtifactRule];

  async execute(ctx: StepContext): Promise<StepResult> {
    const engine = new DefaultEnvisionEngine(adapterFromExecutor(ctx.executors), { model: ctx.model });
    const r = await engine.envision({
      idea: ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId,
      context: ctx.packet.dependencies
        .filter((d) => d.status === 'resolved' && d.excerpt)
        .map((d) => ({ label: d.name, text: d.excerpt ?? '', sourceType: 'prior plan' as const })),
      constraints: ctx.packet.nodeContract.acceptanceCriteria,
    });
    if (!r.ok) return { ok: false, blocker: r.error.blocker };
    return { ok: true, artifact: r.artifact };
  }
}
