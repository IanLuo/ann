import { Step } from './step.js';

/**
 * The step registry (S5 planner kernel — R3-D3): id → implementation. The kernel
 * routes by id and calls the ABSTRACT Step interface — it never knows a concrete
 * step's internals; steps plug in here. Lookup is fail-closed with the id NAMED.
 */
export class StepRegistry {
  private readonly byId = new Map<string, Step>();

  register(step: Step): void {
    if (this.byId.has(step.id)) throw new Error(`step registry: '${step.id}' already registered (one implementation per id)`);
    if (!/^[a-z][a-z0-9-]*$/.test(step.id)) throw new Error(`step registry: '${step.id}' is not a valid step id (lowercase, dashes ok)`);
    this.byId.set(step.id, step);
  }

  get(id: string): Step {
    const step = this.byId.get(id);
    if (!step) throw new Error(`step registry: no step '${id}' (fail-closed: register it or fix the flow chain)`);
    return step;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }
}
