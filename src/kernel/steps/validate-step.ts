import { Step, StepContext, StepResult } from '../step.js';
import { RuleModule } from '../../engines/validators/types.js';
import { GroundingInput } from '../../engines/shared.js';
import { IdeaValidationSession, IdeaValidationDoc } from './idea-validate/session.js';

/**
 * The 'idea-validate' step — the FLOW-1 IDEA VALIDATOR (finalized 2026-08-23; renamed
 * from 'validate' by the core-design §8 listed migration — it validates the IDEA, and
 * `ann validate` is the unrelated validator-rule command).
 *
 * NOT a context validator (S4: deterministic store checks) and NOT a one-shot
 * grill: this runs the INTERACTIVE idea-validation session — multi-round grilling
 * with the user, research together, bounded rounds, a human verdict, and the
 * idea validation DOC that guides the following work (envision/spec ground on it).
 *
 * The one-shot grilling engine remains the per-round synthesizer (wrapped, no
 * rewrite — its honesty layer applies every round). The human channel is the
 * `interact` executor (S8 seam); without it the step fails closed.
 */

/** The step's co-located verify rule: the session must produce a validation doc
 *  with a verdict + guidance — that doc is what the following work grounds on. */
export const ideaValidationDocRule: RuleModule = {
  id: 'idea-validation-doc',
  definition: 'the validate step must produce the idea validation doc (verdict + guidance for the following work) — an empty session cannot guide anything',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepResult | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'idea-validation-doc', detail: 'validate (idea validation) did not produce a result' }];
    const d = r.artifact as { doc?: IdeaValidationDoc } | undefined;
    if (!d?.doc || !['solid', 'revise', 'reject'].includes(d.doc.verdict) || !d.doc.guidance.length) {
      return [{ severity: 'error', code: 'idea-validation-doc', detail: 'validate (idea validation) returned no verdict or no guidance — nothing to guide the following work' }];
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

export class ValidateStep implements Step {
  readonly id = 'idea-validate';
  /** Consumes the task contract + packet only — no earlier-step dependency. */
  readonly inputs: string[] = [];
  readonly rules: RuleModule[] = [ideaValidationDocRule];

  async execute(ctx: StepContext): Promise<StepResult> {
    const llm = ctx.executors.llm;
    if (!llm) return { ok: false, blocker: 'validate (idea validation): no llm executor injected (the session synthesizes per round through it)' };
    const interact = ctx.executors.interact;
    if (!interact) {
      return { ok: false, blocker: 'validate (idea validation): no interactor injected — the interactive session needs the human channel (S8 seam); wire one or run non-interactively' };
    }
    const session = new IdeaValidationSession(llm, interact, { model: ctx.model });
    const r = await session.run({
      idea: ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId,
      context: groundingFrom(ctx),
      constraints: ctx.packet.nodeContract.acceptanceCriteria,
    });
    if (!r.ok) return { ok: false, blocker: r.error.blocker };
    return { ok: true, artifact: { doc: r.doc, markdown: r.doc.markdown } };
  }
}
