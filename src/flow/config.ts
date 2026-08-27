import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../abilities/llm/config.js';

/**
 * THE GENERAL CONFIG (core-design §6; owner decision 2026-08-26) — the end-user knobs.
 *
 * ONE CONFIG CLASS, TWO INSTANCES (resource-registry v3):
 *   - the PROJECT file `.ann/rules/config/default.json` holds `flow.*` + `preferences.*`
 *   - the USER overlay `~/.ann/config.json` overrides `preferences.*` and
 *     `flow.verifyFailCycles` (a cost knob) — and NOTHING else.
 *
 * PRECEDENCE PER LEAF KEY: env > user > project > builtin.
 *
 * `flow.conditionals` is PROJECT SEMANTICS and is NOT user-overridable — two people
 * must not run the same journey as different chains (the product IS the journey).
 * READING TAKEN, STATED: the design names the USER layer as the one excluded for this
 * key; env is a per-invocation, per-machine channel — i.e. exactly the "two people"
 * hole the exclusion exists to close — so this loader excludes env for that leaf too,
 * and says so LOUDLY: setting ANN_FLOW_CONDITIONALS is a NAMED problem, never a silent
 * ignore (core-design §7 "no silent inference").
 *
 * VALIDATION: an ill-typed or out-of-range value is a NAMED problem, never a silent
 * clamp (flow.ts:76's standard). The offending leaf falls back to the next layer that
 * resolved; the frame fails closed on any problem.
 *
 * The builtin defaults below are a CODE LITERAL — a KNOWING DUPLICATE of the registry
 * file, recorded as a reconciliation in the resource-registry v3 amendment (the :54
 * precedent; core-design §6 VALIDATION).
 */

export interface FlowKnobs {
  /** Enables `when?` on chain entries (lifts the linear limit). Project semantics. */
  conditionals: boolean;
  /** Verify retries before `failed`. Default 1; CEILING 3 (a constant, not a key). */
  verifyFailCycles: number;
}

export interface Preferences {
  askVsAssume: string;
  defaults: Record<string, unknown>;
}

export interface GeneralConfig {
  flow: FlowKnobs;
  preferences: Preferences;
}

/** Which layer a leaf key resolved from — derived, never stored. */
export type ConfigLayer = 'env' | 'user' | 'project' | 'builtin';

export interface ConfigResolution {
  config: GeneralConfig;
  /** Named problems (ill-typed, out-of-range, refused layer). Empty = clean. */
  problems: string[];
  /** Per LEAF key, the layer it came from. */
  provenance: Record<string, ConfigLayer>;
}

/** The verify-fail ceiling — a CONSTANT (NFR-CST-1: bounded, never open). Not a key. */
export const VERIFY_FAIL_CYCLES_CEILING = 3;

/** The builtin defaults — a knowing duplicate of `rules/config/default.json`. */
export const BUILTIN_CONFIG: GeneralConfig = {
  flow: { conditionals: false, verifyFailCycles: 1 },
  preferences: { askVsAssume: 'ask', defaults: {} },
};

/** The leaf keys this config class owns. */
const LEAVES = ['flow.conditionals', 'flow.verifyFailCycles', 'preferences.askVsAssume', 'preferences.defaults'] as const;

/** The leaf keys the USER overlay may override — everything else is project semantics. */
const USER_OVERRIDABLE = new Set<string>(['flow.verifyFailCycles', 'preferences.askVsAssume', 'preferences.defaults']);

const ENV_KEYS: Record<string, string> = {
  'flow.conditionals': 'ANN_FLOW_CONDITIONALS',
  'flow.verifyFailCycles': 'ANN_FLOW_VERIFY_FAIL_CYCLES',
  'preferences.askVsAssume': 'ANN_PREF_ASK_VS_ASSUME',
};

interface ProjectConfigFile {
  flow?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
}

/** Load the PROJECT config registry. Absent → undefined (builtin applies); present but
 *  unparseable → thrown, fail-closed (never a silent fall-back to defaults). */
export function loadProjectConfig(root: string): ProjectConfigFile | undefined {
  const file = join(root, '.ann', 'rules', 'config', 'default.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProjectConfigFile;
  } catch (e) {
    throw new Error(`config registry: rules/config/default.json is invalid — ${(e as Error).message} (fail-closed: never silently fall back)`);
  }
}

const leafOf = (src: Record<string, unknown> | undefined, key: string): unknown => {
  if (!src) return undefined;
  const [group, leaf] = key.split('.');
  const g = src[group];
  if (typeof g !== 'object' || g === null) return undefined;
  return (g as Record<string, unknown>)[leaf];
};

/** Coerce + range-check one leaf. Returns the value, or a NAMED problem. */
function checkLeaf(key: string, raw: unknown, layer: ConfigLayer): { value?: unknown; problem?: string } {
  const named = (why: string) => ({ problem: `config ${key} (${layer}): ${why}` });
  switch (key) {
    case 'flow.conditionals':
      if (typeof raw === 'boolean') return { value: raw };
      if (layer === 'env') {
        // env carries strings — accept the two literals, name anything else
        if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
      }
      return named(`expected a boolean, got ${JSON.stringify(raw)}`);
    case 'flow.verifyFailCycles': {
      const n = layer === 'env' && typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n)) return named(`expected an integer, got ${JSON.stringify(raw)}`);
      if (n < 1 || n > VERIFY_FAIL_CYCLES_CEILING) {
        return named(`${n} is out of range 1..${VERIFY_FAIL_CYCLES_CEILING} (the ceiling is a constant, not a key) — refused, never silently clamped`);
      }
      return { value: n };
    }
    case 'preferences.askVsAssume':
      if (raw === 'ask' || raw === 'assume') return { value: raw };
      return named(`expected 'ask' | 'assume', got ${JSON.stringify(raw)}`);
    case 'preferences.defaults':
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return { value: raw };
      return named(`expected an object, got ${JSON.stringify(raw)}`);
    default:
      return named('unknown leaf key');
  }
}

/** Resolve the general config: env > user > project > builtin, PER LEAF KEY. */
export function resolveConfig(root: string): ConfigResolution {
  const problems: string[] = [];
  const provenance: Record<string, ConfigLayer> = {};

  let project: ProjectConfigFile | undefined;
  try {
    project = loadProjectConfig(root);
  } catch (e) {
    problems.push((e as Error).message);
  }
  const user = loadConfig() as unknown as ProjectConfigFile;

  const config: GeneralConfig = {
    flow: { ...BUILTIN_CONFIG.flow },
    preferences: { ...BUILTIN_CONFIG.preferences, defaults: { ...BUILTIN_CONFIG.preferences.defaults } },
  };

  const set = (key: string, value: unknown, layer: ConfigLayer): void => {
    const [group, leaf] = key.split('.');
    (config[group as 'flow' | 'preferences'] as unknown as Record<string, unknown>)[leaf] = value;
    provenance[key] = layer;
  };

  for (const key of LEAVES) {
    provenance[key] = 'builtin';

    // project — the registry file
    const fromProject = leafOf(project as Record<string, unknown> | undefined, key);
    if (fromProject !== undefined) {
      const r = checkLeaf(key, fromProject, 'project');
      if (r.problem) problems.push(r.problem);
      else set(key, r.value, 'project');
    }

    // user — the personal overlay, admitted for the overridable leaves only
    const fromUser = leafOf(user as Record<string, unknown> | undefined, key);
    if (fromUser !== undefined) {
      if (!USER_OVERRIDABLE.has(key)) {
        problems.push(`config ${key} (user): not user-overridable — it is PROJECT SEMANTICS (two people must not run the same journey as different chains); set it in rules/config/default.json`);
      } else {
        const r = checkLeaf(key, fromUser, 'user');
        if (r.problem) problems.push(r.problem);
        else set(key, r.value, 'user');
      }
    }

    // env — the deployment override, same exclusion (an env var IS the "two people" channel)
    const envName = ENV_KEYS[key];
    const fromEnv = envName ? process.env[envName] : undefined;
    if (fromEnv !== undefined && fromEnv !== '') {
      if (!USER_OVERRIDABLE.has(key)) {
        problems.push(`config ${key} (env ${envName}): not overridable outside the project registry — it is PROJECT SEMANTICS; set it in rules/config/default.json`);
      } else {
        const r = checkLeaf(key, fromEnv, 'env');
        if (r.problem) problems.push(r.problem);
        else set(key, r.value, 'env');
      }
    }
  }

  return { config, problems, provenance };
}
