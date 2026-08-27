import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../../adapters/provider/config.js';
import { resolveConfig, BUILTIN_CONFIG, VERIFY_FAIL_CYCLES_CEILING } from '../config.js';

/**
 * THE GENERAL CONFIG (core-design §6) — ONE CONFIG CLASS, TWO INSTANCES.
 * These tests pin the PRECEDENCE (per leaf key), the two exclusions, and the
 * fail-closed validation (a named problem, never a silent clamp).
 */

let root: string;
const ENV_KEYS = ['ANN_FLOW_CONDITIONALS', 'ANN_FLOW_VERIFY_FAIL_CYCLES', 'ANN_PREF_ASK_VS_ASSUME'];

const project = (cfg: unknown) => {
  mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
  writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify(cfg));
};
const user = (cfg: unknown) => {
  writeFileSync(join(root, 'user-config.json'), JSON.stringify(cfg));
  process.env.ANN_CONFIG = join(root, 'user-config.json');
  resetConfigCache();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-cfg-'));
  process.env.ANN_CONFIG = join(root, 'absent.json');
  for (const k of ENV_KEYS) delete process.env[k];
  resetConfigCache();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ANN_CONFIG;
  for (const k of ENV_KEYS) delete process.env[k];
  resetConfigCache();
});

describe('resolveConfig — precedence env > user > project > builtin, PER LEAF KEY', () => {
  it('no project file, no overlay → the builtin literal, every leaf provenanced', () => {
    const r = resolveConfig(root);
    expect(r.config).toEqual(BUILTIN_CONFIG);
    expect(r.problems).toEqual([]);
    expect(new Set(Object.values(r.provenance))).toEqual(new Set(['builtin']));
  });

  it('the project registry beats the builtin', () => {
    project({ flow: { conditionals: true, verifyFailCycles: 2 } });
    const r = resolveConfig(root);
    expect(r.config.flow).toEqual({ conditionals: true, verifyFailCycles: 2 });
    expect(r.provenance['flow.conditionals']).toBe('project');
    // an unset leaf stays builtin — precedence is PER LEAF, not per file
    expect(r.provenance['preferences.askVsAssume']).toBe('builtin');
  });

  it('the user overlay beats the project for the leaves it may override', () => {
    project({ flow: { verifyFailCycles: 2 }, preferences: { askVsAssume: 'ask' } });
    user({ flow: { verifyFailCycles: 3 }, preferences: { askVsAssume: 'assume' } });
    const r = resolveConfig(root);
    expect(r.config.flow.verifyFailCycles).toBe(3);
    expect(r.config.preferences.askVsAssume).toBe('assume');
    expect(r.provenance['flow.verifyFailCycles']).toBe('user');
    expect(r.problems).toEqual([]);
  });

  it('env beats the user overlay', () => {
    user({ flow: { verifyFailCycles: 2 } });
    process.env.ANN_FLOW_VERIFY_FAIL_CYCLES = '3';
    const r = resolveConfig(root);
    expect(r.config.flow.verifyFailCycles).toBe(3);
    expect(r.provenance['flow.verifyFailCycles']).toBe('env');
  });
});

describe('flow.conditionals is PROJECT SEMANTICS — not user-overridable', () => {
  it('REFUSES the user overlay, named — the project value stands', () => {
    project({ flow: { conditionals: true } });
    user({ flow: { conditionals: false } });
    const r = resolveConfig(root);
    expect(r.config.flow.conditionals).toBe(true);
    expect(r.problems.join('\n')).toContain('not user-overridable');
  });

  it('REFUSES env too — an env var IS the "two people, two chains" channel', () => {
    process.env.ANN_FLOW_CONDITIONALS = 'true';
    const r = resolveConfig(root);
    expect(r.config.flow.conditionals).toBe(false);
    expect(r.problems.join('\n')).toContain('PROJECT SEMANTICS');
  });
});

describe('validation — a NAMED problem, never a silent clamp', () => {
  it('refuses verifyFailCycles outside 1..CEILING and keeps the lower layer', () => {
    project({ flow: { verifyFailCycles: VERIFY_FAIL_CYCLES_CEILING + 1 } });
    const r = resolveConfig(root);
    expect(r.config.flow.verifyFailCycles).toBe(1); // builtin — NOT clamped to the ceiling
    expect(r.provenance['flow.verifyFailCycles']).toBe('builtin');
    expect(r.problems.join('\n')).toContain('out of range 1..3');
    expect(r.problems.join('\n')).toContain('never silently clamped');
  });

  it('refuses an ill-typed leaf and names it', () => {
    project({ flow: { conditionals: 'yes' }, preferences: { askVsAssume: 'maybe' } });
    const r = resolveConfig(root);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join('\n')).toContain('expected a boolean');
    expect(r.problems.join('\n')).toContain("expected 'ask' | 'assume'");
    expect(r.config.flow.conditionals).toBe(false);
  });

  it('an unparseable project registry is a problem, never a silent fall-back', () => {
    mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), '{not json');
    const r = resolveConfig(root);
    expect(r.problems.join('\n')).toContain('fail-closed');
    expect(r.config).toEqual(BUILTIN_CONFIG);
  });
});
