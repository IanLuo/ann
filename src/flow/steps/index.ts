import { StepLookup } from '../chain.js';
import { Step } from '../types.js';
import { IdeaValidateStep } from './idea-validate.js';
import { EnvisionStep } from './envision.js';
import { SpecStep } from './spec.js';

/**
 * THE STEP REGISTRY — the pluggable surface. Adding a step:
 *   1. implement `Step` (§2: id · roles[] · produces?[] · rules[] · decisions?[] ·
 *      paramsSchema? · execute(ctx)) in this directory,
 *   2. add it to `defaultSteps()`,
 *   3. reference its id in the project's chain data (.ann/rules/flow/default.json).
 *
 * No other wiring: the frame routes by id, and chain validation FAILS CLOSED on an
 * unregistered id, an unbound required role, a param that misses the schema, and a
 * verdict map that names a decision the step does not declare. There is no fourth
 * place to remember.
 */
export function defaultSteps(): Step[] {
  return [new IdeaValidateStep(), new EnvisionStep(), new SpecStep()];
}

export class StepRegistry implements StepLookup {
  private readonly byId = new Map<string, Step>();
  constructor(steps: Step[] = []) {
    for (const s of steps) this.byId.set(s.id, s);
  }
  register(step: Step): void {
    this.byId.set(step.id, step);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  get(id: string): Step {
    const s = this.byId.get(id);
    if (!s) throw new Error(`step '${id}' is not registered — chain validation should have refused this before the frame ran`);
    return s;
  }
  ids(): string[] {
    return [...this.byId.keys()];
  }
  all(): Step[] {
    return [...this.byId.values()];
  }
}

export const buildStepRegistry = (): StepRegistry => new StepRegistry(defaultSteps());
