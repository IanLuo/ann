import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StepRegistry } from './registry.js';
import { ContextPacket } from '../engines/context.js';
import { Store } from '../store/store.js';

/**
 * Flow config (S5 planner kernel — R3-D4, requirements-spec AC-3, flow-control v6 §7):
 *
 *   project chains (DATA, not code) keyed by WORK TYPE + per-task override.
 *
 * - `rules/flow/default.json` holds the project's chains (a registry file,
 *   resource-registry spec): `chains` maps a work type to its step sequence.
 *   A task's `contract.workType` selects its chain; `default` applies otherwise.
 *   An EMPTY chain = the task runs the LIFECYCLE ONLY (execution tasks — the
 *   runner does the work; no content steps), per flow-control v6 §7.
 * - A task's `contract.flow` overrides everything (still chain-validated).
 * - The engine READS project data; code never overrides it (AC-4). No project
 *   file → the built-in default product template applies (functional-spec F3).
 */

/**
 * LEGACY LOADER — the accreted path. The design target is `src/flow/chain.ts`
 * (core-design §6: chain ENTRIES, execution order, gate-source routing). This module
 * reads the SAME migrated v3 data, flattened to bare step ids, so the old kernel keeps
 * running while the frame is built. It dies with `src/kernel/` when the frame lands.
 */

/** The builtin fallback is the EMPTY CHAIN (core-design §7: no hard-wired flow content
 *  in code). It was ['validate','envision','spec'] — that content is DATA now. */
export const BUILTIN_CHAIN: string[] = [];

export interface FlowConfig {
  /** The resolved chain of step ids for this task. Empty = lifecycle only. */
  chain: string[];
  /** Where the chain came from. */
  source: 'project-config' | 'work-type' | 'task-override' | 'builtin';
  /** The selecting work type (source 'work-type'). */
  workType?: string;
  /** The template description (from the project file, when present). */
  template?: string;
  /** Fail-closed note (e.g. unknown workType fell back to default) — the kernel
   *  refuses to execute on a problem, never silently proceeds. */
  problem?: string;
}

export interface ChainProblem {
  /** The offending step id / input name (never anonymous). */
  at: string;
  problem: string;
}

interface ProjectFlow {
  chains: Record<string, string[]>;
  template?: string;
}

/** Load the PROJECT's flow config (data, not code). v2: `chains` keyed by work
 *  type; legacy `chain` (single) accepted as the `default` chain. */
export function loadProjectFlow(root: string): ProjectFlow | undefined {
  const rel = join(root, '.ann', 'rules', 'flow', 'default.json');
  const legacy = join(root, 'rules', 'flow', 'default.json');
  const file = existsSync(rel) ? rel : legacy; // v12: .ann/rules (legacy rules/ accepted)
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { chains?: unknown; chain?: unknown; template?: unknown };
    if (raw.chains !== undefined) {
      if (typeof raw.chains !== 'object' || raw.chains === null || Array.isArray(raw.chains)) throw new Error('chains must be an object of workType → step-id array');
      const chains: Record<string, string[]> = {};
      for (const [workType, seq] of Object.entries(raw.chains as Record<string, unknown>)) {
        if (!Array.isArray(seq)) throw new Error(`chains.${workType} must be an array (empty = lifecycle only)`);
        // v3 (core-design §6): an entry is an OBJECT; a bare string is its short form.
        // This legacy path consumes ids only — the entry's options belong to the frame.
        chains[workType] = seq.map((s, i) => {
          if (typeof s === 'string') return s;
          const id = (s as { id?: unknown })?.id;
          if (typeof id !== 'string' || !id) throw new Error(`chains.${workType}[${i}] is missing its step id`);
          return id;
        });
      }
      return { chains, ...(typeof raw.template === 'string' ? { template: raw.template } : {}) };
    }
    if (Array.isArray(raw.chain) && raw.chain.every((c) => typeof c === 'string')) {
      return { chains: { default: raw.chain as string[] }, ...(typeof raw.template === 'string' ? { template: raw.template } : {}) };
    }
    throw new Error('flow config must define chains (workType → step ids) or a legacy chain array');
  } catch (e) {
    throw new Error(`flow config: rules/flow/default.json is invalid — ${(e as Error).message} (fail-closed: never silently fall back)`);
  }
}

/** Resolve the chain for a task: contract.flow override → workType chain →
 *  project default → builtin. An unknown workType is a NAMED problem, never a
 *  silent fallback. */
export function resolveFlow(store: Store, taskId: string, root: string): FlowConfig {
  const c = store.contractOf(taskId);
  // 1 — per-task override (data, highest)
  const declared = c.flow as unknown;
  if (Array.isArray(declared) && declared.every((s) => typeof s === 'string')) {
    return { chain: declared as string[], source: 'task-override' };
  }
  // 2 — project config (data, never overridden by code)
  const project = loadProjectFlow(root);
  if (project) {
    const workType = typeof c.workType === 'string' ? c.workType : undefined;
    if (workType) {
      const chain = project.chains[workType];
      if (chain) return { chain, source: 'work-type', workType };
      return {
        chain: project.chains.default ?? [...BUILTIN_CHAIN],
        source: 'work-type',
        workType,
        problem: `unknown workType '${workType}' (project chains: ${Object.keys(project.chains).join(', ') || 'none'}) — fell back to default; add it to rules/flow/default.json`,
      };
    }
    return { chain: project.chains.default ?? [...BUILTIN_CHAIN], source: 'project-config', template: project.template };
  }
  // 3 — builtin product template
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
