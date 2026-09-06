import { RuleModule } from '../validators/types.js';
import { DefaultEnvisionEngine, VisionArtifact } from './envision-engine.js';
import { Step, StepContext, StepOutput, fail } from '../types.js';
import { adapterFromAbility } from './engine-adapter.js';
import { groundingFrom } from './idea-validate.js';

/**
 * `envision` — the F8 product vision (usage + look), rebuilt on the §2 step contract.
 * The engine is WRAPPED, not rewritten: its honesty layer (every claim carries its
 * basis and confidence) is the reason the step exists at all.
 *
 * The vision is INTERMEDIATE: it leaves as the in-memory ARTIFACT the chain binds to a
 * later step's role (`spec` consumes it as `vision`) — the spec is the doc the journey
 * keeps. Envision stages no doc of its own (its claims live on inside the spec).
 */

/** Co-located verify rule: an empty vision cannot be built from — fail. */
export const envisionArtifactRule: RuleModule = {
  id: 'envision-artifact',
  definition: 'the envision step result must carry usage[], look[] or questions[] (an empty vision cannot build from)',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepOutput | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'envision-artifact', detail: 'envision step did not produce a result' }];
    const a = r.artifact as VisionArtifact | undefined;
    if (!a || (a.usage?.length ?? 0) + (a.look?.length ?? 0) + (a.questions?.length ?? 0) === 0) {
      return [{ severity: 'error', code: 'envision-artifact', detail: 'envision step returned an empty vision (no usage, no look, no questions)' }];
    }
    return [];
  },
};

export class EnvisionStep implements Step {
  readonly id = 'envision';
  readonly roles = [];
  // no `produces` — the vision is an in-memory role artifact only (spec stages the doc)
  readonly rules: RuleModule[] = [envisionArtifactRule];

  async execute(ctx: StepContext): Promise<StepOutput> {
    const idea = ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId;
    const engine = new DefaultEnvisionEngine(adapterFromAbility(ctx.abilities.llm));
    const r = await engine.envision({
      idea,
      context: groundingFrom(ctx),
      ...(ctx.packet.nodeContract.acceptanceCriteria ? { constraints: ctx.packet.nodeContract.acceptanceCriteria } : {}),
    });
    if (!r.ok) return fail(r.error.code, r.error.blocker);

    return { ok: true, artifact: r.artifact };
  }
}
