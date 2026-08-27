import { RuleFinding, RuleModule, ValidatorContext } from './types.js';
import {
  gate1,
  gate2,
  closureIntegrity,
  oneCurrent,
  resolutionFiles,
  eventSchema,
  roundGate,
  depthBudget,
  nameDiscipline,
  vocabIntegrity,
  registryIntegrity,
  distanceToGoal,
  redaction,
  artifactHash,
  highImpactDefaulted,
} from './rules.js';

/**
 * The validators (S4) — deterministic checks served in F7 (gates) + F16 (check).
 * Rules are SELF-CONTAINED modules (definition + config co-located with the
 * implementation — never a hand-maintained central definition file). The validators
 * DISCOVER the modules; `rules/check/rules.json` is a DERIVED index of this list.
 * Refuses judgment calls (that is the runner reviewer, S6) and scalar progress.
 */

/** Discovery — the explicit rule-module list (the source of truth; registry is derived). */
export const RULES: RuleModule[] = [
  gate1,
  gate2,
  closureIntegrity,
  oneCurrent,
  resolutionFiles,
  eventSchema,
  roundGate,
  depthBudget,
  nameDiscipline,
  vocabIntegrity,
  registryIntegrity,
  distanceToGoal,
  redaction,
  artifactHash,
  highImpactDefaulted,
];

/** Run every enabled rule (optionally against ONE node) — findings are rule-id'd, deterministic. */
export function runValidators(store: import('../../store/store.js').Store, nodeId?: string): RuleFinding[] {
  const ctx: ValidatorContext = { store, nodeId, RULES } as unknown as ValidatorContext;
  const out: RuleFinding[] = [];
  for (const rule of RULES) {
    if (!rule.enabled) continue;
    try {
      out.push(...rule.run(ctx));
    } catch (e) {
      out.push({ severity: 'error', code: rule.id, detail: `rule crashed: ${(e as Error).message}` });
    }
  }
  return out;
}

/** The DERIVED registry — the rules/check/rules.json content, generated from the modules
 *  (never hand-maintained: definitions live in the modules, this is their index). */
export function derivedRegistry(): { rules: Array<{ id: string; category: string; kind: string; enabled: boolean; severity: string; params: Record<string, unknown>; definition: string }> } {
  return {
    rules: RULES.map((r) => ({
      id: r.id,
      category: 'check',
      kind: 'rule',
      enabled: r.enabled,
      severity: r.severity,
      params: r.params,
      definition: r.definition,
    })),
  };
}
