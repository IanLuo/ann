import { RuleModule } from '../validators/types.js';
import { GroundingInput } from './shared.js';
import { Step, StepContext, StepOutput, fail } from '../types.js';
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
 * chain entry's verdict map routes them. DEPTH RIDES THE DECISION (shaping): the chain
 * must branch on whether a solid idea still needs a vision, so the step's decision
 * VOCABULARY folds the doc's two axes (verdict · needsVision) into four gate-meaningful
 * values — `clear` (solid, no vision → straight to a light spec) and `ambiguous`
 * (solid, a vision runs first) both route ACCEPT; `revise`/`reject` route REJECT. The
 * step itself neither knows nor decides that routing — it returns a decision and
 * nothing else; only the DOC carries the human-shaped verdict + depth.
 */

/** Co-located verify rule: the session must produce a doc with a verdict + guidance —
 *  an empty session cannot guide anything that follows it. A SOLID verdict must also
 *  carry the depth signal (needsVision), because the chain's verdict map routes on it. */
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
    if (d.doc.verdict === 'solid' && typeof d.doc.needsVision !== 'boolean') {
      return [{ severity: 'error', code: 'idea-validation-doc', detail: 'idea-validate returned a SOLID verdict without the depth signal (needsVision) — the chain cannot route the depth (fail closed)' }];
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

/** Fold the doc's two axes (verdict · depth) into the chain-data DECISION vocabulary.
 *  A solid idea is `clear` (no vision) or `ambiguous` (a vision runs first); a doc that
 *  is not solid keeps its own verdict value. A solid doc without needsVision is a shape
 *  problem caught by the doc rule — the fold never fabricates a route. */
const foldDepth = (doc: IdeaValidationDoc): string =>
  doc.verdict === 'solid' ? (doc.needsVision ? 'ambiguous' : 'clear') : doc.verdict;

export class IdeaValidateStep implements Step {
  readonly id = 'idea-validate';
  /** Consumes the task contract + packet only — no earlier-step binding. */
  readonly roles = [];
  // no `produces` — the validation is a verdict + in-memory doc (spec stages the doc)
  /** DEPTH IS THE DECISION (shaping): clear/ambiguous both accept at the grill gate but
   *  route different depths downstream; revise/reject reject. */
  readonly decisions = ['clear', 'ambiguous', 'revise', 'reject'];
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

    const decision = foldDepth(r.doc);
    return {
      ok: true,
      artifact: { doc: r.doc, markdown: r.doc.markdown },
      verdict: { decision, ...(r.doc.guidance.length ? { feedback: r.doc.guidance.join(' · ') } : {}) },
    };
  }
}
