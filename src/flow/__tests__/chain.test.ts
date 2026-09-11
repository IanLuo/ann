import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextPacket } from '../materialize.js';
import { Store } from '../../store/store.js';
import { BUILTIN_CONFIG, GeneralConfig } from '../config.js';
import { ChainEntry, executionOrder, loadProjectFlow, resolveChain, validateChain, StepLookup } from '../chain.js';
import { Step, StepOutput } from '../types.js';

/**
 * FLOWS ARE DATA (core-design §6). These tests pin what static validation CAN decide:
 * execution order, bidirectional role binding, gate-source routing, the confirm-bound
 * deadlock, and the two skip-safety rules — and nothing it cannot.
 */

let root: string;

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  roles: [],
  rules: [],
  execute: async (): Promise<StepOutput> => ({ ok: true }),
  ...over,
});

const REGISTRY: Record<string, Step> = {
  'idea-validate': step('idea-validate', { decisions: ['solid', 'revise', 'reject'], produces: ['stage-doc'] }),
  envision: step('envision', { produces: ['stage-doc'] }),
  spec: step('spec', {
    roles: [{ name: 'vision', required: true }, { name: 'notes', required: false }],
    produces: ['stage-doc', 'propose-spawn'],
  }),
  review: step('review'), // declares NO produces[] — "produces NOTHING", fail-closed
  sign: step('sign', { decisions: ['ship'], produces: ['stage-doc'] }),
};

const lookup: StepLookup = {
  has: (id) => id in REGISTRY,
  get: (id) => REGISTRY[id],
};

const packet = (resolved: string[] = []): ContextPacket =>
  ({ dependencies: resolved.map((name) => ({ name, status: 'resolved' })) } as unknown as ContextPacket);

const cfg = (over: Partial<GeneralConfig['flow']> = {}): GeneralConfig => ({
  flow: { ...BUILTIN_CONFIG.flow, ...over },
  preferences: { ...BUILTIN_CONFIG.preferences },
  server: { ...BUILTIN_CONFIG.server },
});

const check = (chain: ChainEntry[], deps: string[] = [], config = cfg()) => validateChain(lookup, chain, packet(deps), config);
const problemsAt = (chain: ChainEntry[], deps: string[] = [], config = cfg()) => check(chain, deps, config).map((p) => `${p.at}: ${p.problem}`).join('\n');

describe('execution order — grill-bound first, then execute in list order, then confirm-bound', () => {
  it('reorders by phase, stable within a phase', () => {
    const chain: ChainEntry[] = [{ id: 'sign', at: 'confirm' }, { id: 'envision' }, { id: 'spec' }, { id: 'idea-validate', at: 'grill' }];
    expect(executionOrder(chain).map((e) => e.id)).toEqual(['idea-validate', 'envision', 'spec', 'sign']);
  });

  it('"earlier" means EXECUTION order, not list order', () => {
    // spec is listed FIRST but runs after the grill-bound step — the binding is legal
    const chain: ChainEntry[] = [{ id: 'spec', inputs: { vision: 'idea-validate' } }, { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' } } }];
    expect(check(chain)).toEqual([]);
  });

  it('a confirm-bound source cannot feed an execute-phase consumer', () => {
    const chain: ChainEntry[] = [{ id: 'sign', at: 'confirm', verdict: { ship: { gate: 'accept' } } }, { id: 'spec', inputs: { vision: 'sign' } }];
    expect(problemsAt(chain)).toContain('does not run before');
  });
});

describe('role binding — checked BOTH directions (core-design §2)', () => {
  it('accepts a bound role fed by an earlier step or a resolved packet dependency', () => {
    expect(check([{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision' } }])).toEqual([]);
    expect(check([{ id: 'spec', inputs: { vision: 'x-spec' } }], ['x-spec'])).toEqual([]);
  });

  it('refuses a role the step never declared', () => {
    expect(problemsAt([{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision', ghost: 'envision' } }])).toContain("declares no role 'ghost'");
  });

  it('refuses an UNBOUND required role, and lets an optional one be absent', () => {
    expect(problemsAt([{ id: 'spec' }])).toContain("required role 'vision' of step 'spec' is not bound");
    expect(check([{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision' } }])).toEqual([]);
  });

  it('refuses a source that is neither a chain step nor a resolved dependency', () => {
    expect(problemsAt([{ id: 'spec', inputs: { vision: 'nowhere' } }])).toContain('neither a step in this chain nor a resolved packet dependency');
  });
});

describe('gate-source routing — the gate SOURCE is data, the set and positions are not', () => {
  it('accepts a grill-bound step whose verdict map covers every decision', () => {
    expect(check([{ id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' } } }])).toEqual([]);
  });

  it('FAILS CLOSED on an unmapped decision — routing is data, and missing means fail closed', () => {
    expect(problemsAt([{ id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' } } }])).toContain("decision 'revise' of step 'idea-validate' is unmapped");
  });

  it('refuses a verdict key the step never declares', () => {
    const p = problemsAt([{ id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' }, maybe: { gate: 'accept' } } }]);
    expect(p).toContain("'maybe' is not a decision of step 'idea-validate'");
  });

  it('refuses a gate-bound step with no verdict map and one with no decisions[]', () => {
    expect(problemsAt([{ id: 'idea-validate', at: 'grill' }])).toContain('carries no verdict map');
    expect(problemsAt([{ id: 'envision', at: 'grill', verdict: {} }])).toContain('declares no decisions[]');
  });

  it('refuses TWO steps on one gate — one human decision per gate', () => {
    const chain: ChainEntry[] = [
      { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' } } },
      { id: 'sign', at: 'grill', verdict: { ship: { gate: 'accept' } } },
    ];
    expect(problemsAt(chain)).toContain('at most one step per gate');
  });

  it("refuses an `at` that is neither a vocab gate nor the 'execute' literal", () => {
    expect(problemsAt([{ id: 'envision', at: 'review' as 'execute' }])).toContain('neither a vocab gate');
  });
});

describe('the confirm-bound deadlock, rejected at VALIDATION (§3 rule 8)', () => {
  it('refuses a chain whose only doc-staging step is confirm-bound', () => {
    expect(problemsAt([{ id: 'sign', at: 'confirm', verdict: { ship: { gate: 'accept' } } }])).toContain('every doc-staging step is confirm-bound — the confirm gate would decide on work that has not run yet (deadlock)');
  });

  it('accepts it when an execute-phase step also produces', () => {
    const chain: ChainEntry[] = [{ id: 'envision' }, { id: 'sign', at: 'confirm', verdict: { ship: { gate: 'accept' } } }];
    expect(check(chain)).toEqual([]);
  });

  it('an ABSENT produces[] means "produces NOTHING" — no deadlock to report', () => {
    expect(check([{ id: 'review' }])).toEqual([]);
  });
});

describe('conditionals — off by default, skip-shaped only', () => {
  const conditional: ChainEntry[] = [{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision' }, when: { hasOutput: 'envision' } }];

  it('FAILS CLOSED when flow.conditionals is false', () => {
    expect(problemsAt(conditional)).toContain('chains are LINEAR by default');
  });

  it('passes when the project enables them', () => {
    expect(check(conditional, [], cfg({ conditionals: true }))).toEqual([]);
  });

  it('SKIP-SAFETY (b): a gate-bound entry may not carry `when` — it would deadlock the gate', () => {
    const chain: ChainEntry[] = [
      { id: 'envision' },
      { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' } }, when: { hasOutput: 'envision' } },
    ];
    expect(problemsAt(chain, [], cfg({ conditionals: true }))).toContain("may not carry 'when'");
  });

  it('SKIP-SAFETY (a): a REQUIRED role may not bind to a conditional step unless the consumer is conditional on it', () => {
    const unsafe: ChainEntry[] = [{ id: 'envision', when: { hasOutput: 'review' } }, { id: 'review' }, { id: 'spec', inputs: { vision: 'envision' } }];
    expect(problemsAt(unsafe, [], cfg({ conditionals: true }))).toContain('skip-safety');
    const safe: ChainEntry[] = [{ id: 'review' }, { id: 'envision', when: { hasOutput: 'review' } }, { id: 'spec', inputs: { vision: 'envision' }, when: { hasOutput: 'envision' } }];
    expect(check(safe, [], cfg({ conditionals: true }))).toEqual([]);
  });

  it('a qualified verdict condition must name an earlier step AND a decision it declares', () => {
    const on = cfg({ conditionals: true });
    const good: ChainEntry[] = [
      { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject' }, reject: { gate: 'reject' } } },
      { id: 'envision', when: { verdict: { step: 'idea-validate', decision: 'solid' } } },
    ];
    expect(check(good, [], on)).toEqual([]);
    const bad = [good[0], { id: 'envision', when: { verdict: { step: 'idea-validate', decision: 'nope' } } }] as ChainEntry[];
    expect(problemsAt(bad, [], on)).toContain("declares no decision 'nope'");
  });

  it('takes exactly one of the TWO fixed predicates — a third is a code change', () => {
    const both: ChainEntry[] = [{ id: 'review' }, { id: 'envision', when: { hasOutput: 'review', verdict: { step: 'review', decision: 'x' } } }];
    expect(problemsAt(both, [], cfg({ conditionals: true }))).toContain('exactly one of hasOutput | verdict');
  });
});

describe('the chain data itself', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ann-chain-'));
    mkdirSync(join(root, '.ann', 'journey', 'legs', '01-leg', '01-a'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const flowFile = (chains: unknown) => {
    mkdirSync(join(root, '.ann', 'rules', 'flow'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'flow', 'default.json'), JSON.stringify({ chains }));
  };
  const task = (contract: unknown) =>
    writeFileSync(join(root, '.ann', 'journey', 'legs', '01-leg', '01-a', 'node.json'), JSON.stringify({ id: '01-leg/01-a', contract, createdAt: '2026-08-27' }));

  it('reads entry objects, and a bare string as the short form of {id}', () => {
    flowFile({ default: ['envision', { id: 'spec', inputs: { vision: 'envision' } }] });
    expect(loadProjectFlow(root)!.chains.default).toEqual([{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision' } }]);
  });

  it('refuses an unknown entry field — a typo is a chain that does not say what it means', () => {
    flowFile({ default: [{ id: 'spec', inupts: {} }] });
    expect(() => loadProjectFlow(root)).toThrow(/unknown field\(s\): inupts/);
  });

  it('the builtin fallback is the EMPTY chain — no hard-wired flow content in code', () => {
    task({ intent: 'x', acceptanceCriteria: ['y'] });
    expect(resolveChain(new Store(root), '01-leg/01-a', root)).toEqual({ chain: [], source: 'builtin' });
  });

  it('an unknown workType is a NAMED problem, and an absent one is just as loud', () => {
    flowFile({ implementation: [] });
    task({ intent: 'x', acceptanceCriteria: ['y'], workType: 'nope' });
    expect(resolveChain(new Store(root), '01-leg/01-a', root).problem).toContain("unknown workType 'nope'");
    task({ intent: 'x', acceptanceCriteria: ['y'] });
    expect(resolveChain(new Store(root), '01-leg/01-a', root).problem).toContain('as loud as an unknown one');
  });

  it('contract.flow overrides everything', () => {
    flowFile({ default: ['envision'] });
    task({ intent: 'x', acceptanceCriteria: ['y'], flow: [{ id: 'spec', inputs: { vision: 'x-spec' } }] });
    const f = resolveChain(new Store(root), '01-leg/01-a', root);
    expect(f.source).toBe('task-override');
    expect(f.chain).toEqual([{ id: 'spec', inputs: { vision: 'x-spec' } }]);
  });
});
