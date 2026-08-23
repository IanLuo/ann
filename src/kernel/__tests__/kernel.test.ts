import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Completion, ProviderAdapter } from '../../adapters/provider/index.js';
import { StepRegistry } from '../registry.js';
import { PlannerKernel } from '../kernel.js';
import { ValidateStep } from '../steps/validate-step.js';
import { EnvisionStep } from '../steps/envision-step.js';
import { SpecStep } from '../steps/spec-step.js';
import { createExecutorSet } from '../executor.js';
import { BUILTIN_CHAIN, loadProjectFlow, resolveFlow, validateChain } from '../flow.js';
import { assemblePacket } from '../../engines/context.js';

let root: string;
function makeStore() {
  root = mkdtempSync(join(tmpdir(), 'ann-kernel-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}
function nodeDir(id: string) { return join(root, '.ann', 'journey', 'legs', id); }
function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>>) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-23' }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-23', type, ...extra });

/** A current artifact 'x-spec' (resolvable requiredInput) with a file on disk. */
function currentSpecArtifact() {
  const id = '00-leg/00-spec-producer';
  mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
  writeFileSync(join(nodeDir(id), 'artifacts', 'x.md'), '# x-spec\n\nThe grounded input content.\n');
  writeNode(id, { intent: 'produce x-spec', acceptanceCriteria: ['AC1'] }, [
    ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/00-leg/00-spec-producer/artifacts/x.md', lockSha: 'aaa111' } }),
  ]);
}

/** Fake adapter — sequential responses; engines/kernel never touch a real provider in tests (AC-4). */
const fakeAdapter = (responses: Completion[]): { adapter: ProviderAdapter; calls: Array<{ prompt: string; opts?: object }> } => {
  const calls: Array<{ prompt: string; opts?: object }> = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    complete: vi.fn(async (prompt: string, opts?: { model?: string; maxTokens?: number }) => {
      calls.push({ prompt, opts });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    }),
  };
  return { adapter, calls };
};
const ok = (text: string): Completion => ({ ok: true, text, usage: { inputTokens: 5, outputTokens: 3 } });
const fail = (blocker: string): Completion => ({ ok: false, error: { code: 'provider-unavailable', blocker } });

const GRILL_JSON = JSON.stringify({
  summary: 'Buildable.',
  validation: [{ verdict: 'ok', claim: 'Fits the goal', basis: [], confidence: 'high' }],
  questions: [],
});
const VISION_JSON = JSON.stringify({
  summary: 'A vision summary.',
  usage: [{ claim: 'The user runs it', kind: 'scenario', basis: [], confidence: 'high' }],
  look: [],
  questions: [],
});

const registry = (): StepRegistry => {
  const r = new StepRegistry();
  r.register(new ValidateStep());
  r.register(new EnvisionStep());
  r.register(new SpecStep());
  return r;
};
const kernel = (store: Store, adapter: ProviderAdapter) => new PlannerKernel(store, registry(), adapter);

/** A well-formed task contract: intent + ACs + a resolvable input. */
const taskContract = (extra: Record<string, unknown> = {}) => ({
  intent: 'Build the thing',
  acceptanceCriteria: ['AC-1'],
  requiredInputs: ['x-spec'],
  ...extra,
});

describe('PlannerKernel (S5) — frontmostReady + lookBack (derived from events, never assumed)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('frontmost-ready: prefix order, queued/active only', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    writeNode('01-leg/02-b', taskContract(), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    expect(k.frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/01-a', status: 'queued' });
  });

  it('frontmost-ready: failed/superseded/blocked siblings skipped', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('failed')]);
    writeNode('01-leg/02-b', taskContract(), [ev('created'), ev('superseded')]);
    writeNode('01-leg/03-c', taskContract(), [ev('created')]);
    writeNode('01-leg/04-d', taskContract(), [ev('created'), ev('submitted', { gate: 'grill' })]); // blocked: pending human gate
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    expect(k.frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/03-c', status: 'queued' });
  });

  it('lookBack: active leg + frontmost-ready + pending human gates', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('activated'), ev('completed')]);
    writeNode('01-leg/02-b', taskContract(), [ev('created')]);
    writeNode('01-leg/03-c', taskContract(), [ev('created'), ev('submitted', { gate: 'grill' })]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const lb = k.lookBack();
    expect(lb.activeLeg).toBe('01-leg');
    expect(lb.frontmostReady).toEqual({ leg: '01-leg', task: '01-leg/02-b', status: 'queued' });
    expect(lb.pendingGates).toEqual([{ task: '01-leg/03-c', gate: 'grill' }]);
  });
});

describe('PlannerKernel — materialize (context packet + resolution ladder)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('missing requiredInput → ladder rung block, named (never silently inferred)', () => {
    writeNode('01-leg/01-a', { intent: 'X', acceptanceCriteria: ['AC1'], requiredInputs: ['missing-spec'] }, [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const m = k.materialize('01-leg/01-a');
    expect(m.packet.readiness.ready).toBe(false);
    expect(m.ladder).toEqual([
      { input: 'missing-spec', rung: 'block', reason: expect.stringContaining('missing-spec') },
    ]);
  });

  it('resolved input → no blockers, ladder empty', () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const m = k.materialize('01-leg/01-a');
    expect(m.packet.readiness.ready).toBe(true);
    expect(m.ladder).toEqual([]);
  });
});

describe('PlannerKernel — validate (deterministic; judgment stays with S6)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a well-formed task validates clean', () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const v = k.validate('01-leg/01-a');
    expect(v.ok).toBe(true);
    expect(v.findings).toEqual([]);
  });

  it('missing ACs + unresolved input → named findings', () => {
    writeNode('01-leg/01-a', { intent: 'X', requiredInputs: ['nope'] }, [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const v = k.validate('01-leg/01-a');
    expect(v.ok).toBe(false);
    const codes = v.findings.map((f) => f.code);
    expect(codes).toContain('no-acs');
    expect(codes).toContain('readiness');
    expect(codes).toContain('contract');
  });
});

describe('PlannerKernel — execute (flow chain through the step registry)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs the default chain validate → envision → spec; spec consumes the vision; evidence emitted at the executor', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('confirmed', { gate: 'grill' })]);
    const { adapter, calls } = fakeAdapter([ok(GRILL_JSON), ok(VISION_JSON), ok('# Detailed spec\n\nAC-1: …')]);
    const k = kernel(new Store(root), adapter);
    const r = await k.execute('01-leg/01-a');

    expect(r.ok).toBe(true);
    expect(r.flow.chain).toEqual(['validate', 'envision', 'spec']);
    expect(r.flow.source).toBe('builtin');
    expect(r.outcomes.map((o) => o.step)).toEqual(['validate', 'envision', 'spec']);
    expect(r.outcomes.every((o) => o.result.ok && o.ruleFindings.length === 0)).toBe(true);
    // chain wiring: the spec step consumed the envision result (its prompt cites the vision summary)
    expect(calls.length).toBe(3);
    expect(calls[2].prompt).toContain('A vision summary.');
    // the two-log trace at the emission point: evidence events recorded during execution
    const evidence = new Store(root).events('01-leg/01-a').filter((e) => e.type === 'evidence');
    expect(evidence.length).toBe(3);
    expect(evidence[0].note).toContain('validate (grilling)');
  });

  it('per-task flow override (contract.flow) is respected and chain-validated', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract({ flow: ['envision'] }), [ev('created')]);
    const { adapter } = fakeAdapter([ok(VISION_JSON)]);
    const k = kernel(new Store(root), adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(true);
    expect(r.flow.chain).toEqual(['envision']);
    expect(r.flow.source).toBe('task-override');
  });

  it('an unknown step in the override → chain rejected, named, never silent', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract({ flow: ['envision', 'teleport'] }), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(false);
    expect(r.chainProblems.some((p) => p.at === 'teleport' && p.problem.includes('not registered'))).toBe(true);
  });

  it('a forward reference (spec before its input envision) → chain rejected', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract({ flow: ['spec'] }), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(false);
    expect(r.chainProblems.some((p) => p.at === 'spec.inputs.envision')).toBe(true);
  });

  it('a step rule failure stops the chain (co-located verify, R3-D5)', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    // an EMPTY grill — the grilling-artifact rule must fail it
    const { adapter } = fakeAdapter([ok(JSON.stringify({ summary: 'empty', validation: [], questions: [] }))]);
    const k = kernel(new Store(root), adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('validate');
    expect(r.outcomes[0].ruleFindings.some((f) => f.code === 'grilling-artifact')).toBe(true);
  });

  it('adapter failure passes through fail-closed (never fabricated)', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([fail('provider down')]).adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('validate');
    expect(r.outcomes[0].result.blocker).toContain('provider down');
  });

  it('bounded rework (AC-3): 3 gate rejects → execute escalates, refuses to run', async () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('rejected', { gate: 'grill', feedback: '1' }),
      ev('submitted', { gate: 'grill' }),
      ev('rejected', { gate: 'grill', feedback: '2' }),
      ev('submitted', { gate: 'grill' }),
      ev('rejected', { gate: 'grill', feedback: '3' }),
    ]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const r = await k.execute('01-leg/01-a');
    expect(r.ok).toBe(false);
    expect(r.chainProblems.some((p) => p.problem.includes('bounded rework'))).toBe(true);
  });
});

describe('PlannerKernel — verify + commit (flow-control v6 §6)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('verify: no evidence → named finding; commit evidence satisfies it', () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('confirmed', { gate: 'grill' })]);
    const store = new Store(root);
    const k = kernel(store, fakeAdapter([]).adapter);
    expect(k.verify('01-leg/01-a').ok).toBe(false);
    k.commit('01-leg/01-a', { sha: 'abc1234', note: 'implemented', refs: ['src/kernel/'] });
    const v = k.verify('01-leg/01-a');
    expect(v.ok).toBe(true);
    const commits = store.events('01-leg/01-a').filter((e) => e.type === 'evidence').at(-1)?.commits;
    expect(commits).toEqual([{ sha: 'abc1234', note: 'implemented' }]);
  });

  it('commit rejects a non-sha fail-closed (machine-truth, never prose)', () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    expect(() => k.commit('01-leg/01-a', { sha: 'not a sha' })).toThrow(/not a git sha/);
  });
});

describe('PlannerKernel — advance (leg gate validated from logs, never assumed)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('tasks remaining → continue-leg with the frontmost', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    writeNode('02-leg', {}, []);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const a = k.advance();
    expect(a.action).toBe('continue-leg');
    expect(a.detail).toContain('01-leg/01-a');
  });

  it('leg gate met (all tasks done) → advance-leg naming the next leg', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('completed')]);
    writeNode('02-leg', {}, []);
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const a = k.advance();
    expect(a.action).toBe('advance-leg');
    expect(a.detail).toContain('02-leg');
  });

  it('gate unmet with remaining work → closure-needed (closure is a GATED human decision)', () => {
    writeNode('01-leg', {}, []);
    writeNode('01-leg/01-a', taskContract(), [ev('created'), ev('completed')]);
    writeNode('01-leg/02-b', taskContract(), [ev('created'), ev('submitted', { gate: 'grill' })]); // blocked on human
    const k = kernel(new Store(root), fakeAdapter([]).adapter);
    const a = k.advance();
    expect(a.action).toBe('closure-needed');
    expect(a.detail).toContain('closure');
  });
});

describe('Flow config — DATA, not code (AC-3/AC-4)', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('builtin default template applies when the project has no flow file', () => {
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    expect(resolveFlow(new Store(root), '01-leg/01-a', root).chain).toEqual(BUILTIN_CHAIN);
    expect(resolveFlow(new Store(root), '01-leg/01-a', root).source).toBe('builtin');
  });

  it('project flow file is read (data), never overridden by code', () => {
    mkdirSync(join(root, '.ann', 'rules', 'flow'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'flow', 'default.json'), JSON.stringify({ chain: ['validate', 'spec'], template: 'idea → validate → spec → continue' }));
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const f = resolveFlow(new Store(root), '01-leg/01-a', root);
    expect(f.chain).toEqual(['validate', 'spec']);
    expect(f.source).toBe('project-config');
    expect(f.template).toContain('idea');
    expect(loadProjectFlow(root)).toEqual({ chain: ['validate', 'spec'], template: 'idea → validate → spec → continue' });
  });

  it('chain validation: every step registered + inputs produced earlier or resolvable', () => {
    currentSpecArtifact();
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const reg = registry();
    const store = new Store(root);
    const packet = assemblePacket(store, '01-leg/01-a');
    // good chain: spec consumes envision (earlier) and packet deps resolve
    expect(validateChain(reg, ['validate', 'envision', 'spec'], packet)).toEqual([]);
    // bad chain: forward reference
    expect(validateChain(reg, ['spec'], packet).some((p) => p.at === 'spec.inputs.envision')).toBe(true);
    // bad chain: unknown step
    expect(validateChain(reg, ['teleport'], packet).some((p) => p.at === 'teleport')).toBe(true);
  });
});

describe('Executor protocols (R3-D2) — llm emits evidence at the emission point; others unbuilt', () => {
  beforeEach(() => makeStore());
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('llm executor emits an evidence event ONLY when the call is a task fact (evidence: true)', async () => {
    writeNode('01-leg/01-a', taskContract(), [ev('created')]);
    const store = new Store(root);
    const { adapter } = fakeAdapter([ok('plain answer'), ok('a task fact')]);
    const emitted: Array<{ note?: string }> = [];
    const set = createExecutorSet({ adapter, recordEvidence: (e) => emitted.push(e), taskModel: 'm-1' });
    await set.llm!.complete('q1'); // not a task fact → no evidence
    await set.llm!.complete('q2', { evidence: true, evidenceNote: 'a binding result' }); // task fact → evidence
    expect(emitted).toEqual([{ note: 'a binding result' }]);
  });

  it('tool/command/request are protocol-declared, UNBUILT, and fail loudly', () => {
    const set = createExecutorSet({ adapter: fakeAdapter([]).adapter, recordEvidence: () => {} });
    expect(set.tool?.unbuilt).toBe(true);
    expect(set.command?.unbuilt).toBe(true);
    expect(set.request?.unbuilt).toBe(true);
    expect(set.tool?.why).toContain('UNBUILT');
  });
});
