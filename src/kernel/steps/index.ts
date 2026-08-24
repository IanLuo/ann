import { Step } from '../step.js';
import { StepRegistry } from '../registry.js';
import { ValidateStep } from './validate-step.js';
import { EnvisionStep } from './envision-step.js';
import { SpecStep } from './spec-step.js';

/**
 * The step inventory — the pluggable surface. Adding a future step:
 *   1. implement `Step` (id · inputs[] · rules[] · execute(ctx)) in this dir,
 *   2. add it to `defaultSteps()`,
 *   3. reference its id in the project's chain data (rules/flow/default.json).
 * No other wiring — the kernel routes by id; chain validation fails closed on
 * anything unregistered. Every step follows the SAME working interface.
 */
export function defaultSteps(): Step[] {
  return [new ValidateStep(), new EnvisionStep(), new SpecStep()];
}

export function buildDefaultRegistry(): StepRegistry {
  const r = new StepRegistry();
  for (const s of defaultSteps()) r.register(s);
  return r;
}
