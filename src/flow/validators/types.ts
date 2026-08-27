import { Store } from '../../store/store.js';

/** A deterministic validator finding — rule-id'd, severity from the rule, never a judgment call. */
export interface RuleFinding {
  severity: 'error' | 'warning';
  code: string;
  detail: string;
  nodeId?: string;
}

export interface ValidatorContext {
  store: Store;
  /** When set, run the rule against ONE node only; else the whole store. */
  nodeId?: string;
  /** STEP SCOPE (S5 kernel, R3-D5): when set, the rule checks a step's RESULT —
   *  the per-step contract check. The S4 validators stay the whole-store surface;
   *  one rule class, two scopes, both self-contained. */
  result?: unknown;
}

/** A SELF-CONTAINED rule module: the definition + config live WITH the implementation
 *  (no central definition file to maintain — the card-present staleness proved the drift).
 *  The validators DISCOVER the modules; the rules/check/rules.json index is DERIVED. */
export interface RuleModule {
  id: string;
  definition: string;
  severity: 'error' | 'warning';
  enabled: boolean;
  params: Record<string, unknown>;
  run(ctx: ValidatorContext): RuleFinding[];
}
