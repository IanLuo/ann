import { Step, StepContext, StepResult } from '../step.js';
import { RuleModule } from '../../engines/validators/types.js';
import { VisionArtifact } from '../../engines/envision.js';
import { renderContext } from '../../engines/shared.js';

/**
 * The 'spec' step — F9 spec expansion (owned by the planner kernel, design v3 S5):
 * detailed specs from the vision artifact. Consumes the 'envision' step's result
 * via the chain (inputs: ['envision']) + the resolved packet dependencies; produces
 * a detailed spec (markdown) with acceptance criteria per section.
 *
 * BUILT + fake-adapter TESTED; the live run is DEFERRED (no provider configured in
 * this repo — the flow fails closed by design; wire a provider to run it live).
 */

/** The step's co-located verify rule: an empty spec cannot be an artifact — fail. */
export const specArtifactRule: RuleModule = {
  id: 'spec-artifact',
  definition: 'the spec step result must be a non-empty markdown document (F9: detailed specs from the vision)',
  severity: 'error',
  enabled: true,
  params: {},
  run(ctx) {
    const r = ctx.result as StepResult | undefined;
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

## The product vision (from the envision step)
{vision}

## Grounded context (packet dependencies — cite only what is here)
{context}

## Contract acceptance criteria (the task's ACs — each must be addressed)
{acs}

## Output — a markdown detailed spec with sections:
## Summary · ## Scope (in/out) · ## Requirements (each requirement cites its ground: "[vision]" or "[context: label]") · ## Acceptance criteria (per section, numbered AC-1…) · ## Open questions
Rules (hard): every requirement must cite its ground. Anything not grounded goes to Open questions, never into Requirements. Do not fabricate users, counts, prices, or integrations.`;

interface SpecInput {
  idea: string;
  vision?: VisionArtifact;
  context: Array<{ label: string; text: string; sourceType: 'prior plan' | 'observation' }>;
  acs: string[];
}

/** Render the vision artifact for the prompt (usage + look claims with provenance). */
const renderVision = (v: VisionArtifact | undefined): string => {
  if (!v) return '(no vision yet — the envision step did not run or produced nothing)';
  const lines: string[] = [`Summary: ${v.summary}`];
  for (const c of [...v.usage, ...v.look]) {
    lines.push(`- [${c.kind}] ${c.claim} (ground: ${c.basis.join(', ') || 'inference'}, ${c.confidence})`);
  }
  return lines.join('\n');
};

export class SpecStep implements Step {
  readonly id = 'spec';
  /** Consumes the envision step's result (the vision artifact) — chain-validated (R3-D4). */
  readonly inputs = ['envision'];
  readonly rules: RuleModule[] = [specArtifactRule];

  async execute(ctx: StepContext): Promise<StepResult> {
    const vision = ctx.results['envision']?.artifact as VisionArtifact | undefined;
    const inputs: SpecInput = {
      idea: ctx.packet.nodeContract.intent ?? ctx.packet.pathDecisions.nodeId,
      vision,
      context: ctx.packet.dependencies
        .filter((d) => d.status === 'resolved' && d.excerpt)
        .map((d) => ({ label: d.name, text: d.excerpt ?? '', sourceType: d.sourceType === 'observation' ? ('observation' as const) : ('prior plan' as const) })),
      acs: ctx.packet.nodeContract.acceptanceCriteria ?? [],
    };
    const prompt = SPEC_PROMPT
      .replace('{idea}', inputs.idea)
      .replace('{vision}', renderVision(inputs.vision))
      .replace('{context}', renderContext(inputs.context))
      .replace('{acs}', inputs.acs.map((a, i) => `${i + 1}. ${a}`).join('\n') || '(none declared)');

    const llm = ctx.executors.llm;
    if (!llm) return { ok: false, blocker: 'spec: no llm executor injected (F9 needs the llm executor)' };
    const r = await llm.complete(prompt, { evidence: true, evidenceNote: 'spec expansion (F9) — task fact: detailed spec from the vision' });
    if (!r.ok) return r;
    return { ok: true, artifact: r.result };
  }
}
