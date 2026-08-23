import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StepRegistry } from './registry.js';
import { ContextPacket } from '../engines/context.js';
import { Store } from '../store/store.js';

/**
 * Flow config (S5 planner kernel — R3-D4, requirements-spec AC-3, flow-control v6 §7):
 *
 *   project default chain (DATA, not code) + PER-TASK override (contract.flow).
 *
 * - `rules/flow/default.json` holds the project's step chain (a registry file,
 *   resource-registry spec). The engine READS it and code NEVER overrides project
 *   config (AC-4). No project file → the built-in default product template applies
 *   (idea → validate → envision → detailed specs → continue — functional-spec F3).
 * - A task's contract may declare its own flow (`contract.flow: ["validate", "spec"]`)
 *   — an override, still chain-validated: every step id must exist in the registry
 *   and each step's declared inputs must be produced earlier (a resolved packet
 *   dependency by logical name, or an earlier step's id in the chain) or resolvable.
 */

/** The built-in default product template (functional-spec §2: idea → validate →
 *  envision → spec → continue; idea = the task contract, continue = the kernel advance). */
export const BUILTIN_CHAIN: string[] = ['validate', 'envision', 'spec'];

export interface FlowConfig {
  /** The resolved chain of step ids (project default or per-task override). */
  chain: string[];
  /** Where the chain came from — 'project-config' | 'task-override' | 'builtin'. */
  source: 'project-config' | 'task-override' | 'builtin';
  /** The template description (from the project file, when present). */
  template?: string;
}

export interface ChainProblem {
  /** The offending step id / input name (never anonymous). */
  at: string;
  problem: string;
}

/** Load the PROJECT's flow config (data, not code). Returns undefined when the
 *  project has no rules/flow/default.json — the caller falls back to the builtin. */
export function loadProjectFlow(root: string): { chain: string[]; template?: string } | undefined {
  const rel = join(root, '.ann', 'rules', 'flow', 'default.json');
  const legacy = join(root, 'rules', 'flow', 'default.json');
  const file = existsSync(rel) ? rel : legacy; // v12: .ann/rules (legacy rules/ accepted)
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { chain?: unknown; template?: unknown };
    if (!Array.isArray(raw.chain) || !raw.chain.every((c) => typeof c === 'string' && c.length)) {
      throw new Error('flow config: chain must be a non-empty array of step ids');
    }
    return { chain: raw.chain as string[], ...(typeof raw.template === 'string' ? { template: raw.template } : {}) };
  } catch (e) {
    throw new Error(`flow config: rules/flow/default.json is invalid — ${(e as Error).message} (fail-closed: never silently fall back)`);
  }
}

/** Resolve the chain for a task: contract.flow override → project config → builtin.
 *  The override lives on the task's contract (node.json — derived read via the store);
 *  the context-packet schema is locked and does NOT carry flow, so the kernel reads
 *  the contract directly (never writes). */
export function resolveFlow(store: Store, taskId: string, root: string): FlowConfig {
  const contract = store.contract(taskId) as { contract?: Record<string, unknown> } | undefined;
  const raw = (contract?.contract ?? {}) as Record<string, unknown>;
  const c = ((raw as { contract?: Record<string, unknown> }).contract ?? raw) as Record<string, unknown>; // normalize wrapped {contract:{…}}
  const declared = c.flow as unknown;
  const taskChain = Array.isArray(declared) && declared.every((s) => typeof s === 'string') ? (declared as string[]) : undefined;
  if (taskChain && taskChain.length) return { chain: taskChain, source: 'task-override' };
  const project = loadProjectFlow(root);
  if (project) return { chain: project.chain, source: 'project-config', template: project.template };
  return { chain: [...BUILTIN_CHAIN], source: 'builtin' };
}

/** Chain validation (R3-D4): every step exists in the registry; each step's declared
 *  inputs are produced earlier — a resolved packet dependency (logical name) or an
 *  earlier step's id. Returns problems (empty = valid); never throws. */
export function validateChain(registry: StepRegistry, chain: string[], packet: ContextPacket): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const produced = new Set<string>(chain); // step ids are produced (their results)
  const resolvable = new Set<string>(packet.dependencies.filter((d) => d.status === 'resolved').map((d) => d.name));
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    if (!registry.has(id)) {
      problems.push({ at: id, problem: `step '${id}' is not registered (fail-closed: register it or fix the chain)` });
      continue;
    }
    const step = registry.get(id);
    const earlier = new Set(chain.slice(0, i));
    for (const input of step.inputs) {
      // an earlier step's id → produced; a resolved packet dependency → resolvable
      if (earlier.has(input) || resolvable.has(input)) continue;
      // a step id that appears LATER is a forward reference → invalid (chain is sequential)
      if (produced.has(input) || input === id) {
        problems.push({ at: `${id}.inputs.${input}`, problem: `input '${input}' is not produced before step '${id}' (forward reference — steps run sequentially)` });
        continue;
      }
      problems.push({
        at: `${id}.inputs.${input}`,
        problem: `input '${input}' is neither an earlier step's id nor a resolved packet dependency (names: ${[...resolvable].join(', ') || '(none)'})`,
      });
    }
  }
  // duplicates
  const seen = new Set<string>();
  for (const id of chain) {
    if (seen.has(id)) problems.push({ at: id, problem: `duplicate step '${id}' in the chain (a step runs once per task flow)` });
    seen.add(id);
  }
  return problems;
}
