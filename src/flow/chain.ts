import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ContextPacket } from './materialize.js';
import { Store } from '../store/store.js';
import { getVOCAB } from '../store/vocab.js';
import { GeneralConfig } from './config.js';
import { ParamSpec, Step } from './types.js';

/**
 * L2 — FLOWS ARE DATA (core-design §6).
 *
 *   chain entry = { id, inputs?: {role → source}, params?,
 *                   at?: 'grill' | 'confirm' | 'execute' (default execute),
 *                   verdict?: {decision → {gate:'accept'|'reject', feedback?}},
 *                   when?: {hasOutput} | {verdict:{step, decision}} }
 *
 * The GATE-SOURCE DATA IS THE CHAIN: at most one step per gate; the verdict map routes
 * `out.verdict.decision` to a gate decision; missing/unmapped → FAIL CLOSED. The gate
 * SET and POSITIONS are protected — only the SOURCE is data.
 *
 * EXECUTION ORDER: grill-bound first, then `at:'execute'` in list order, then
 * confirm-bound (GATE② is after verify, locked). "Earlier" always means EXECUTION
 * order, never list order.
 *
 * THE BUILTIN FALLBACK IS THE EMPTY CHAIN (§7: no hard-wired flow content in code).
 */

export type Phase = 'grill' | 'execute' | 'confirm';

export interface WhenCondition {
  /** The named step produced an artifact. */
  hasOutput?: string;
  /** QUALIFIED: the step precedes this entry in EXECUTION order and declares `decision`. */
  verdict?: { step: string; decision: string };
}

export interface ChainEntry {
  id: string;
  /** role → source (an earlier step's id, or a resolved packet dependency name). */
  inputs?: Record<string, string>;
  params?: Record<string, unknown>;
  at?: Phase;
  verdict?: Record<string, { gate: 'accept' | 'reject'; feedback?: string }>;
  /** CONDITIONAL EXECUTION — requires `flow.conditionals: true`; a false condition
   *  SKIPS the step, recorded as a frame-phase trace record kind:'skip'. */
  when?: WhenCondition;
}

export interface ChainProblem {
  /** The offending step id / input name — never anonymous. */
  at: string;
  problem: string;
}

export interface FlowConfig {
  chain: ChainEntry[];
  source: 'project-config' | 'work-type' | 'task-override' | 'builtin';
  workType?: string;
  template?: string;
  /** Fail-closed note — the frame refuses to execute on a problem, never proceeds. */
  problem?: string;
}

/** What chain validation needs of a step registry — nothing more. */
export interface StepLookup {
  has(id: string): boolean;
  get(id: string): Step;
}

interface ProjectFlow {
  chains: Record<string, ChainEntry[]>;
  template?: string;
}

export const phaseOf = (e: ChainEntry): Phase => e.at ?? 'execute';

const PHASE_RANK: Record<Phase, number> = { grill: 0, execute: 1, confirm: 2 };

/** The chain in EXECUTION order: grill-bound, then execute in list order, then confirm-bound. */
export function executionOrder(chain: ChainEntry[]): ChainEntry[] {
  return chain.map((e, i) => ({ e, i })).sort((a, b) => PHASE_RANK[phaseOf(a.e)] - PHASE_RANK[phaseOf(b.e)] || a.i - b.i).map((x) => x.e);
}

/** A bare string is the SHORT FORM of `{id}` — an entry with no options. Anything else
 *  that is not an object with a string `id` is a NAMED problem, never coerced. */
function normalizeEntry(raw: unknown, where: string): ChainEntry {
  if (typeof raw === 'string') return { id: raw };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where} must be a step id or a chain entry object`);
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) throw new Error(`${where} is missing its step id`);
  const known = ['id', 'inputs', 'params', 'at', 'verdict', 'when'];
  const unknown = Object.keys(e).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`${where} carries unknown field(s): ${unknown.join(', ')}`);
  return e as unknown as ChainEntry;
}

/** Load the PROJECT's flow config (data, not code). v3: `chains` maps a work type to
 *  an ENTRY array (the v2 string-array short form still reads). */
export function loadProjectFlow(root: string): ProjectFlow | undefined {
  const rel = join(root, '.ann', 'rules', 'flow', 'default.json');
  const legacy = join(root, 'rules', 'flow', 'default.json');
  const file = existsSync(rel) ? rel : legacy; // v12: .ann/rules (legacy rules/ accepted)
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { chains?: unknown; template?: unknown };
    if (typeof raw.chains !== 'object' || raw.chains === null || Array.isArray(raw.chains)) {
      throw new Error('chains must be an object of workType → chain entries');
    }
    const chains: Record<string, ChainEntry[]> = {};
    for (const [workType, seq] of Object.entries(raw.chains as Record<string, unknown>)) {
      if (!Array.isArray(seq)) throw new Error(`chains.${workType} must be an array (empty = lifecycle only)`);
      chains[workType] = seq.map((s, i) => normalizeEntry(s, `chains.${workType}[${i}]`));
    }
    return { chains, ...(typeof raw.template === 'string' ? { template: raw.template } : {}) };
  } catch (e) {
    throw new Error(`flow config: rules/flow/default.json is invalid — ${(e as Error).message} (fail-closed: never silently fall back)`);
  }
}

/** Resolve the chain for a task: contract.flow override → workType chain → project
 *  default → the EMPTY builtin. An unknown workType is a NAMED problem; an ABSENT one
 *  is just as loud when no `default` chain exists (§6). */
export function resolveChain(store: Store, taskId: string, root: string): FlowConfig {
  const c = store.contractOf(taskId);

  // 1 — per-task override (data, highest)
  if (Array.isArray(c.flow)) {
    try {
      return { chain: (c.flow as unknown[]).map((s, i) => normalizeEntry(s, `contract.flow[${i}]`)), source: 'task-override' };
    } catch (e) {
      return { chain: [], source: 'task-override', problem: (e as Error).message };
    }
  }

  // 2 — project config (data, never overridden by code)
  const project = loadProjectFlow(root);
  if (project) {
    const workType = typeof c.workType === 'string' ? c.workType : undefined;
    if (workType) {
      const chain = project.chains[workType];
      if (chain) return { chain, source: 'work-type', workType };
      return {
        chain: project.chains.default ?? [],
        source: 'work-type',
        workType,
        problem: `unknown workType '${workType}' (project chains: ${Object.keys(project.chains).join(', ') || 'none'}) — add it to rules/flow/default.json`,
      };
    }
    if (project.chains.default) return { chain: project.chains.default, source: 'project-config', template: project.template };
    return {
      chain: [],
      source: 'project-config',
      template: project.template,
      problem: `no contract.workType and no 'default' chain in rules/flow/default.json — an absent workType is as loud as an unknown one (§6)`,
    };
  }

  // 3 — the builtin fallback is the EMPTY CHAIN (§7 — no hard-wired flow content in code)
  return { chain: [], source: 'builtin' };
}

/** Validate `params` against the step's paramsSchema (§1:65) — fail closed, named. */
export function paramProblems(stepId: string, schema: Record<string, ParamSpec> | undefined, params: Record<string, unknown> | undefined): ChainProblem[] {
  const out: ChainProblem[] = [];
  const given = params ?? {};
  if (!schema) {
    for (const k of Object.keys(given)) out.push({ at: `${stepId}.params.${k}`, problem: `step '${stepId}' declares no paramsSchema — it cannot consume params` });
    return out;
  }
  for (const [k, spec] of Object.entries(schema)) {
    if (given[k] === undefined) {
      if (spec.required) out.push({ at: `${stepId}.params.${k}`, problem: `required param '${k}' (${spec.type}) is not bound` });
      continue;
    }
    const v = given[k];
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== spec.type) out.push({ at: `${stepId}.params.${k}`, problem: `param '${k}' expects ${spec.type}, got ${actual}` });
  }
  for (const k of Object.keys(given)) {
    if (!(k in schema)) out.push({ at: `${stepId}.params.${k}`, problem: `param '${k}' is not in step '${stepId}'s paramsSchema` });
  }
  return out;
}

/**
 * Chain validation — the MEANING of a chain (L1 `spawn!` owns the contract SHAPE).
 * Returns problems (empty = valid); never throws.
 */
export function validateChain(lookup: StepLookup, chain: ChainEntry[], packet: ContextPacket, config: GeneralConfig): ChainProblem[] {
  const problems: ChainProblem[] = [];
  const gates = getVOCAB().gates; // 'grill' | 'confirm' — the SET is protected
  const resolvable = new Set(packet.dependencies.filter((d) => d.status === 'resolved').map((d) => d.name));

  // duplicates — a step runs once per task flow
  const seen = new Set<string>();
  for (const e of chain) {
    if (seen.has(e.id)) problems.push({ at: e.id, problem: `duplicate step '${e.id}' in the chain (a step runs once per task flow)` });
    seen.add(e.id);
  }

  // `at` values — a MIXED NAMESPACE, checked against both sources (§1:66)
  for (const e of chain) {
    if (e.at !== undefined && e.at !== 'execute' && !gates.includes(e.at)) {
      problems.push({ at: e.id, problem: `at:'${e.at}' is neither a vocab gate (${gates.join(', ')}) nor the 'execute' phase literal` });
    }
  }

  // one step per gate — the frame never double-presents (§3 rule 6)
  for (const gate of gates) {
    const bound = chain.filter((e) => phaseOf(e) === gate);
    if (bound.length > 1) {
      problems.push({ at: bound.map((e) => e.id).join(', '), problem: `${bound.length} steps bound to gate '${gate}' — at most one step per gate (one human decision per gate)` });
    }
  }

  const order = executionOrder(chain);
  const positionOf = new Map(order.map((e, i) => [e.id, i]));
  const entryOf = new Map(chain.map((e) => [e.id, e]));

  for (let i = 0; i < order.length; i++) {
    const entry = order[i];
    const id = entry.id;
    if (!lookup.has(id)) {
      problems.push({ at: id, problem: `step '${id}' is not registered (fail-closed: register it or fix the chain)` });
      continue;
    }
    const step = lookup.get(id);
    const phase = phaseOf(entry);

    // params vs paramsSchema
    problems.push(...paramProblems(id, step.paramsSchema, entry.params));

    // ROLE BINDING, BOTH DIRECTIONS (§2): every bound role declared, every REQUIRED role bound
    const declared = new Map(step.roles.map((r) => [r.name, r]));
    const bindings = entry.inputs ?? {};
    for (const [role, source] of Object.entries(bindings)) {
      if (!declared.has(role)) {
        problems.push({ at: `${id}.inputs.${role}`, problem: `step '${id}' declares no role '${role}' (declared: ${[...declared.keys()].join(', ') || '(none)'})` });
        continue;
      }
      const srcPos = positionOf.get(source);
      if (srcPos === undefined) {
        if (!resolvable.has(source)) {
          problems.push({
            at: `${id}.inputs.${role}`,
            problem: `source '${source}' is neither a step in this chain nor a resolved packet dependency (names: ${[...resolvable].join(', ') || '(none)'})`,
          });
        }
        continue;
      }
      if (srcPos >= i) {
        problems.push({ at: `${id}.inputs.${role}`, problem: `source '${source}' does not run before '${id}' in EXECUTION order (grill-bound → execute → confirm-bound)` });
        continue;
      }
      // SKIP-SAFETY (a): a REQUIRED role may not bind to a conditional step unless the
      // consuming entry is itself conditional on hasOutput of that step (§6, review-12 §II.2a)
      const srcEntry = entryOf.get(source);
      if (declared.get(role)!.required && srcEntry?.when && entry.when?.hasOutput !== source) {
        problems.push({
          at: `${id}.inputs.${role}`,
          problem: `required role '${role}' binds to conditional step '${source}' — the consuming entry must itself carry when.hasOutput:'${source}' (skip-safety)`,
        });
      }
    }
    for (const r of step.roles) {
      if (r.required && bindings[r.name] === undefined) {
        problems.push({ at: `${id}.inputs.${r.name}`, problem: `required role '${r.name}' of step '${id}' is not bound` });
      }
    }

    // VERDICT MAPS — the gate-source routing (§6)
    const decisions = step.decisions ?? [];
    for (const key of Object.keys(entry.verdict ?? {})) {
      if (!decisions.includes(key)) {
        problems.push({ at: `${id}.verdict.${key}`, problem: `'${key}' is not a decision of step '${id}' (declared: ${decisions.join(', ') || '(none)'})` });
      }
    }
    for (const [key, route] of Object.entries(entry.verdict ?? {})) {
      if (route?.gate !== 'accept' && route?.gate !== 'reject') {
        problems.push({ at: `${id}.verdict.${key}`, problem: `verdict route must be {gate:'accept'|'reject', feedback?}, got ${JSON.stringify(route)}` });
      }
    }
    if (phase !== 'execute') {
      if (!decisions.length) {
        problems.push({ at: id, problem: `step '${id}' is bound to gate '${phase}' but declares no decisions[] — it cannot produce a gate decision` });
      }
      if (!entry.verdict) {
        problems.push({ at: id, problem: `gate-bound step '${id}' carries no verdict map — the routing to accept|reject is data, and missing means fail closed` });
      } else {
        for (const d of decisions) {
          if (!(d in entry.verdict)) problems.push({ at: `${id}.verdict.${d}`, problem: `decision '${d}' of step '${id}' is unmapped — every decision must route to a gate decision (fail closed)` });
        }
      }
    }

    // CONDITIONAL EXECUTION (§6)
    if (entry.when) {
      if (!config.flow.conditionals) {
        problems.push({ at: id, problem: `entry '${id}' carries 'when' but flow.conditionals is false — chains are LINEAR by default (fail closed; set it in rules/config/default.json)` });
      }
      // SKIP-SAFETY (b): a gate-bound entry may NOT carry `when` — a skipped gate source
      // would deadlock the gate silently (review-12 §II.2b)
      if (phase !== 'execute') {
        problems.push({ at: id, problem: `gate-bound step '${id}' may not carry 'when' — a skipped gate source would deadlock gate '${phase}' silently` });
      }
      const kinds = (['hasOutput', 'verdict'] as const).filter((k) => entry.when![k] !== undefined);
      if (kinds.length !== 1) {
        problems.push({ at: `${id}.when`, problem: `'when' takes exactly one of hasOutput | verdict, got ${kinds.join(', ') || '(none)'} — there are TWO fixed predicates; a third is a code change` });
      }
      const ref = entry.when.hasOutput ?? entry.when.verdict?.step;
      if (ref !== undefined) {
        const pos = positionOf.get(ref);
        if (pos === undefined) problems.push({ at: `${id}.when`, problem: `condition references '${ref}', which is not a step in this chain` });
        else if (pos >= i) problems.push({ at: `${id}.when`, problem: `condition references '${ref}', which does not run before '${id}' in EXECUTION order` });
        else if (entry.when.verdict) {
          const refStep = lookup.has(ref) ? lookup.get(ref) : undefined;
          const refDecisions = refStep?.decisions ?? [];
          if (!refDecisions.includes(entry.when.verdict.decision)) {
            problems.push({ at: `${id}.when`, problem: `step '${ref}' declares no decision '${entry.when.verdict.decision}' (declared: ${refDecisions.join(', ') || '(none)'})` });
          }
        }
      }
    }
  }

  // THE CONFIRM-BOUND DEADLOCK, rejected at VALIDATION (§3 rule 8) — via the step's
  // declared produces?[] (absence = "produces NOTHING", fail-closed).
  const producers = chain.filter((e) => lookup.has(e.id) && (lookup.get(e.id).produces ?? []).includes('stage-doc'));
  if (producers.length && producers.every((e) => phaseOf(e) === 'confirm')) {
    problems.push({
      at: producers.map((e) => e.id).join(', '),
      problem: `every doc-staging step is confirm-bound — the confirm gate would decide on work that has not run yet (deadlock)`,
    });
  }

  return problems;
}
