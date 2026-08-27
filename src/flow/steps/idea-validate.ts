import { RuleModule } from '../validators/types.js';
import { GroundingInput } from './shared.js';
import { Intent, Step, StepContext, StepOutput, fail } from '../types.js';
import { IdeaValidationDoc, IdeaValidationSession } from './idea-validate/session.js';

/**
 * `idea-validate` — the FLOW-1 IDEA VALIDATOR, rebuilt on the §2 step contract.
 *
 * It validates the IDEA: a multi-round interactive session with the human — grill the
 * current understanding, batch-ask the open questions, research the high-impact
 * unknowns together, bounded rounds, a human verdict, and the validation DOC the
 * following work grounds on. Not a context validator (that is S4's deterministic store
 * check) and not a one-shot grill.
 *
 * It is the chain's GRILL-BOUND step: its `decisions` are the gate's source, and the
 * chain entry's verdict map routes them (solid→accept, revise/reject→reject). The step
 * itself neither knows nor decides that routing — it returns a verdict and nothing else.
 */

/** Co-located verify rule: the session must produce a doc with a verdict + guidance —
 *  an empty session cannot guide anything that follows it. */
export const ideaValidationDocRule: RuleModule = {
  id: 'idea-validation-doc',
  definition: 'the idea-validate step must produce the validation doc (verdict + guidance for the following work) — an empty session cannot guide anything',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepOutput | undefined;
    if (!r || !r.ok) return [{ severity: 'error', code: 'idea-validation-doc', detail: 'idea-validate did not produce a result' }];
    const d = r.artifact as { doc?: IdeaValidationDoc } | undefined;
    if (!d?.doc || !['solid', 'revise', 'reject'].includes(d.doc.verdict) || !d.doc.guidance.length) {
      return [{ severity: 'error', code: 'idea-validation-doc', detail: 'idea-validate returned no verdict or no guidance — nothing to guide the following work' }];
    }
    return [];
  },
};

/** The packet's RESOLVED dependencies as grounding. Packet provenance ('derived-from')
 *  maps to the taxonomy's 'prior plan' — the closest SourceType for artifact grounding. */
export const groundingFrom = (ctx: StepContext): GroundingInput[] =>
  ctx.packet.dependencies
    .filter((d) => d.status === 'resolved' && d.excerpt)
    .map((d) => ({ label: d.name, text: d.excerpt ?? '', sourceType: 'prior plan' as const }));

export class IdeaValidateStep implements Step {
  readonly id = 'idea-validate';
  /** Consumes the task contract + packet only — no earlier-step binding. */
  readonly roles = [];
  readonly produces = ['lock-artifact' as const];
  readonly decisions = ['solid', 'revise', 'reject'];
  readonly rules: RuleModule[] = [ideaValidationDocRule];

  async execute(ctx: StepContext): Promise<StepOutput> {
    // a REWORK re-runs the session with the rejection carried as a constraint — the
    // feedback marks the attempt KIND; it is never the replay discriminator (§2)
    const constraints = [
      ...(ctx.packet.nodeContract.acceptanceCriteria ?? []),
      ...(ctx.feedback ? [`REWORK — the ${ctx.feedback.gate} gate rejected the last attempt: ${ctx.feedback.text}`] : []),
    ];
    const r = await new IdeaValidationSession(ctx.abilities).run({
      idea: ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId,
      context: groundingFrom(ctx),
      ...(constraints.length ? { constraints } : {}),
    });
    if (!r.ok) return fail(r.error.code, r.error.blocker);

    const intents: Intent[] = [{ kind: 'lock-artifact', name: 'idea-validation', content: r.doc.markdown, type: 'validation' }];
    return {
      ok: true,
      artifact: { doc: r.doc, markdown: r.doc.markdown },
      verdict: { decision: r.doc.verdict, ...(r.doc.guidance.length ? { feedback: r.doc.guidance.join(' · ') } : {}) },
      intents,
    };
  }
}
