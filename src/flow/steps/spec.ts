import { RuleModule } from '../../engines/validators/types.js';
import { VisionArtifact } from '../../engines/envision.js';
import { renderContext } from '../../engines/shared.js';
import { Intent, Step, StepContext, StepOutput, StepRole } from '../types.js';

/**
 * `spec` — F9 spec expansion, rebuilt on the §2 step contract: the detailed spec, from
 * the vision, grounded in the packet.
 *
 * It declares the role it CONSUMES (`vision`, required) rather than naming a step. The
 * chain binds {role → source} and validateChain checks both directions, so the step
 * never knows which step fed it — swap `envision` for another producer and the step is
 * unchanged. What arrives through `prior` is the earlier step's in-memory artifact;
 * a cross-task committed input would arrive through `read` instead.
 */

/** Co-located verify rule: an empty spec is not an artifact — fail. */
export const specArtifactRule: RuleModule = {
  id: 'spec-artifact',
  definition: 'the spec step result must be a non-empty markdown document (F9: detailed specs from the vision)',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepOutput | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'spec-artifact', detail: 'spec step did not produce a result' }];
    const spec = r.artifact as string | undefined;
    if (typeof spec !== 'string' || !spec.trim()) {
      return [{ severity: 'error', code: 'spec-artifact', detail: 'spec step returned an empty spec — nothing to lock as an artifact (F9)' }];
    }
    return [];
  },
};

const SPEC_PROMPT = `You are the spec-expansion step of a journey system (F9 — the beginning build step: detailed specs from the vision).
Write the DETAILED SPEC for the confirmed idea. Ground EVERYTHING in the vision + the grounded context — never invent scope, numbers, or requirements not present there.

## The confirmed idea
{idea}

## The product vision (from the vision role)
{vision}

## Grounded context (packet dependencies — cite only what is here)
{context}

## Contract acceptance criteria (the task's ACs — each must be addressed)
{acs}

## Output — a markdown detailed spec with sections:
## Summary · ## Scope (in/out) · ## Requirements (each requirement cites its ground: "[vision]" or "[context: label]") · ## Acceptance criteria (per section, numbered AC-1…) · ## Open questions
Rules (hard): every requirement must cite its ground. Anything not grounded goes to Open questions, never into Requirements. Do not fabricate users, counts, prices, or integrations.`;

/** Render the bound vision for the prompt — the claims keep their provenance. */
const renderVision = (v: VisionArtifact | undefined): string => {
  if (!v) return '(no vision bound — the role resolved to nothing)';
  return [`Summary: ${v.summary}`, ...[...v.usage, ...v.look].map((c) => `- [${c.kind}] ${c.claim} (ground: ${c.basis.join(', ') || 'inference'}, ${c.confidence})`)].join('\n');
};

export class SpecStep implements Step {
  readonly id = 'spec';
  /** The chain binds this role to a source; validateChain fails closed if it does not. */
  readonly roles: StepRole[] = [{ name: 'vision', required: true, description: 'the product vision the spec expands (F8 → F9)' }];
  readonly produces = ['lock-artifact' as const];
  readonly rules: RuleModule[] = [specArtifactRule];

  async execute(ctx: StepContext): Promise<StepOutput> {
    const acs = ctx.packet.nodeContract.acceptanceCriteria ?? [];
    const prompt = SPEC_PROMPT.replace('{idea}', ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId)
      .replace('{vision}', renderVision(ctx.prior.vision as VisionArtifact | undefined))
      .replace(
        '{context}',
        renderContext(
          ctx.packet.dependencies
            .filter((d) => d.status === 'resolved' && d.excerpt)
            .map((d) => ({ label: d.name, text: d.excerpt ?? '', sourceType: d.sourceType === 'observation' ? ('observation' as const) : ('prior plan' as const) })),
        ),
      )
      .replace('{acs}', acs.map((a, i) => `${i + 1}. ${a}`).join('\n') || '(none declared)');

    const spec = await ctx.abilities.llm.complete({ prompt });
    const intents: Intent[] = [{ kind: 'lock-artifact', name: 'spec', content: spec, type: 'spec' }];
    return { ok: true, artifact: spec, intents };
  }
}
