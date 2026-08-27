import { RuleModule } from '../../engines/validators/types.js';
import { DefaultEnvisionEngine, VisionArtifact } from '../../engines/envision.js';
import { Intent, Step, StepContext, StepOutput, fail } from '../types.js';
import { adapterFromAbility } from './engine-adapter.js';
import { groundingFrom } from './idea-validate.js';

/**
 * `envision` — the F8 product vision (usage + look), rebuilt on the §2 step contract.
 * The engine is WRAPPED, not rewritten: its honesty layer (every claim carries its
 * basis and confidence) is the reason the step exists at all.
 *
 * The vision leaves twice, deliberately: as the in-memory ARTIFACT the chain binds to
 * a later step's role (`spec` consumes it as `vision`), and as a locked markdown
 * DOCUMENT a human can read. The first is how the chain flows; the second is what the
 * journey keeps.
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

/** The readable vision — each claim keeps the basis and confidence it was made with. */
export const renderVision = (idea: string, v: VisionArtifact): string => {
  const claims = (label: string, list: VisionArtifact['usage']) =>
    list.length ? [`\n## ${label}`, ...list.map((c) => `- ${c.claim} (ground: ${c.basis.join(', ') || 'inference'}, ${c.confidence})`)] : [];
  return [
    '# Product Vision',
    `\n**Idea:** ${idea}`,
    `\n${v.summary}`,
    ...claims('Usage', v.usage),
    ...claims('Look', v.look),
    ...(v.questions.length ? ['\n## Open questions', ...v.questions.map((q) => `- [${q.impact}] ${q.question} — ${q.reason}`)] : []),
  ].join('\n');
};

export class EnvisionStep implements Step {
  readonly id = 'envision';
  readonly roles = [];
  readonly produces = ['lock-artifact' as const];
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

    const intents: Intent[] = [{ kind: 'lock-artifact', name: 'vision', content: renderVision(idea, r.artifact), type: 'vision' }];
    return { ok: true, artifact: r.artifact, intents };
  }
}
