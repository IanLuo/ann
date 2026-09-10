import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { Frame, FrameResult } from '../frame.js';
import { ChainEntry, StepLookup } from '../chain.js';
import { Abilities, Intent, ResearchFinding, Step, StepContext, StepOutput } from '../types.js';

/**
 * THE FRAME (core-design §4) — the RESUMABLE COORDINATOR. These tests pin the four
 * resume tail states, frame-write idempotence, the verify-fail cycle (with its empty-
 * chain inertness), and the TWO-PHASE conclusion (F-AC18): a chain that STAGES A DOC
 * ends run 1 in `blocked-waiting` once its confirm gate is decided — `completed` is the
 * RE-RUN that follows the operator's `evidence.commits[]` (commit is where deferred
 * propose-spawn children record). An empty chain concludes on its own run as before.
 */

let root: string;
const TASK = '01-leg/01-a';
const CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };

const node = (id: string, contract: unknown, events: Array<Record<string, unknown>> = []) => {
  const dir = join(root, '.ann', 'journey', 'legs', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
};
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

function setup(events = [ev('created')], contract: unknown = CONTRACT): Commands {
  root = mkdtempSync(join(tmpdir(), 'ann-frame-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  node('01-leg', {});
  node(TASK, contract, events);
  return new Commands(new Store(root), 'test');
}
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A scripted human — every verb answers from a queue; `asked` records the questions. */
class ScriptedInteract {
  readonly asked: string[] = [];
  readonly presented: string[] = [];
  constructor(private readonly answers: string[] = []) {}
  async present(text: string) { this.presented.push(text); }
  async ask(q: string) { this.asked.push(q); return this.answers.shift() ?? ''; }
  async research(topics: string[]): Promise<ResearchFinding[]> { return topics.map((t) => ({ topic: t, findings: 'x' })); }
  async decide(q: string, options: string[]) { this.asked.push(q); return this.answers.shift() ?? options[0]; }
}

const abilities = (interact: ScriptedInteract, completions: string[] = []): Abilities => ({
  llm: { complete: async () => completions.shift() ?? 'a completion' },
  interact,
});

/** A step that returns whatever the script says, and declares the intents it uses.
 *  The DEFAULT stages a doc named after the step — docs are git content, written NOW. */
const mkStep = (id: string, over: Partial<Step> & { out?: (ctx: StepContext) => StepOutput } = {}): Step => ({
  id,
  roles: [],
  rules: [],
  produces: ['stage-doc'],
  execute: async (ctx) => over.out?.(ctx) ?? { ok: true, artifact: `${id} artifact`, intents: [{ kind: 'stage-doc', name: id, content: `# ${id}\n` } as Intent] },
  ...(over.decisions ? { decisions: over.decisions } : {}),
  ...(over.produces ? { produces: over.produces } : {}),
  ...(over.roles ? { roles: over.roles } : {}),
});

const registryOf = (steps: Step[]): StepLookup => ({
  has: (id) => steps.some((s) => s.id === id),
  get: (id) => steps.find((s) => s.id === id)!,
});

function chainFile(chain: ChainEntry[] | string[]) {
  mkdirSync(join(root, '.ann', 'rules', 'flow'), { recursive: true });
  writeFileSync(join(root, '.ann', 'rules', 'flow', 'default.json'), JSON.stringify({ chains: { default: chain } }));
}

const frame = (c: Commands, steps: Step[], interact: ScriptedInteract) =>
  new Frame({ commands: c, root, registry: registryOf(steps), abilities: abilities(interact) });

const run = (c: Commands, steps: Step[], interact = new ScriptedInteract()): Promise<FrameResult> => frame(c, steps, interact).run(TASK);

/** The git-home file a staged doc lives at — <store root>/docs/<name>.md. */
const docFile = (name: string) => join(root, 'docs', `${name}.md`);

/** The TWO-PHASE release (F-AC18): append the operator's commit evidence, then re-run.
 *  Both gates were decided on run 1, so the re-run asks the human nothing (the
 *  decided-gate path) and concludes: commit runs → `completed` is appended. */
async function conclude(c: Commands, steps: Step[], sha = 'abc1234'): Promise<FrameResult> {
  const a = c.evidence(TASK, [{ sha }], { note: 'committed the staged doc (test)' });
  if (!a.ok) throw new Error(`evidence! refused: ${a.error.code}: ${a.error.blocker}`);
  return run(c, steps);
}

describe('the frame runs the fixed frame end to end', () => {
  it('grill → activate → execute → verify → confirm (staged) → WAIT → commit on evidence, recording the deferred spawn ONLY at commit', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    // the step stages its doc AND defers a leg-sibling spawn to the commit boundary
    const envision = mkStep('envision', {
      produces: ['stage-doc', 'propose-spawn'],
      out: () => ({
        ok: true,
        artifact: 'envisioned',
        intents: [
          { kind: 'stage-doc', name: 'envision', content: '# envision\n' },
          { kind: 'propose-spawn', id: '01-leg/02-a', contract: CONTRACT },
        ] as Intent[],
      }),
    });
    const human = new ScriptedInteract(['accept', 'accept']);
    const r1 = await run(c, [envision], human);

    // RUN 1: the doc is STAGED (git content on disk) and both gates are DECIDED, but with
    // no commit evidence the frame WAITS — concluding is the operator's `git commit`.
    expect(r1.stop).toBe('blocked-waiting');
    expect(c.status(TASK)).toBe('blocked');
    expect(readFileSync(docFile('envision'), 'utf8')).toContain('# envision'); // the working file existed BEFORE the event
    expect(c.ids()).not.toContain('01-leg/02-a'); // the spawn is DEFERRED — nothing records before commit

    // the operator commits the docs/ change and records structured evidence — the release.
    // (store.spawn writes node.json into an EXISTING node folder — the caller pre-creates
    // the child's folder; it is not a node until node.json lands — same idiom as intents.test.)
    mkdirSync(join(root, '.ann', 'journey', 'legs', '01-leg', '02-a'), { recursive: true });
    const r2 = await conclude(c, [envision]);
    expect(r2.stop).toBe('completed');
    expect(c.status(TASK)).toBe('done');
    const types = c.events(TASK).map((e) => e.type);
    expect(types).toEqual(['created', 'submitted', 'confirmed', 'activated', 'submitted', 'confirmed', 'waiting', 'evidence', 'completed']);
    expect(r2.committed?.spawned).toEqual(['01-leg/02-a']); // the deferred spawn recorded HERE, at commit
    expect(c.ids()).toContain('01-leg/02-a');
    // look-back is a DERIVED READ at L1 (§1) — the frame reads it, never assumes it
    expect(r2.lookBack?.pendingGates).toEqual([]);
    expect(r2.advance).toBeTruthy();
  });

  it('activate/completed are idempotent — a re-run adds no duplicate lifecycle events', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    // run 1 stages + decides both gates → the two-phase WAIT (no conclusion yet)
    await run(c, [mkStep('envision')], new ScriptedInteract(['accept', 'accept']));
    // the operator's evidence discharges the wait — run 2 concludes
    const r2 = await conclude(c, [mkStep('envision')]);
    expect(r2.stop).toBe('completed');
    const before = c.events(TASK).length;
    const r3 = await run(c, [mkStep('envision')]);
    expect(r3.stop).toBe('completed');
    const types = c.events(TASK).map((e) => e.type);
    expect(types.filter((t) => t === 'activated')).toHaveLength(1);
    expect(types.filter((t) => t === 'completed')).toHaveLength(1);
    expect(c.events(TASK).length).toBe(before); // both gates were decided: the WRITES are skipped
  });
});

describe('the four resume tail states (core-design §1)', () => {
  it('1 — a decided gate skips the gate WRITE, never the step', async () => {
    const c = setup([ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    chainFile([{ id: 'envision' }]);
    let ran = 0;
    const step = mkStep('envision', { out: () => { ran++; return { ok: true, artifact: 'a', intents: [{ kind: 'stage-doc', name: 'envision', content: '# e\n' }] }; } });
    const human = new ScriptedInteract(['accept']); // the CONFIRM gate only — grill is already decided
    const r1 = await run(c, [step], human);
    expect(r1.stop).toBe('blocked-waiting'); // staged + confirm decided → the two-phase wait
    expect(ran).toBe(1); // the step still ran
    expect(c.events(TASK).filter((e) => e.type === 'confirmed' && e.gate === 'grill')).toHaveLength(1);
    expect(human.presented.some((p) => p.startsWith('GATE grill'))).toBe(false); // no re-presentation
    const r2 = await conclude(c, [step]);
    expect(r2.stop).toBe('completed');
    expect(ran).toBe(2); // the decided gate never skips the step on the concluding run either
  });

  it('2 — an undecided `submitted` BLOCKS: an interrupted gate is resumable, not un-started', async () => {
    const c = setup([ev('created'), ev('submitted', { gate: 'grill' })]);
    chainFile([{ id: 'envision' }]);
    const r = await run(c, [mkStep('envision')]);
    expect(r.stop).toBe('blocked-at-gate');
    expect(c.status(TASK)).toBe('blocked');
  });

  it('3 — a `rejected` tail re-obtains the gate: the rework rung runs', async () => {
    const c = setup([ev('created'), ev('submitted', { gate: 'grill' }), ev('rejected', { gate: 'grill', feedback: 'not yet' })]);
    chainFile([{ id: 'envision' }]);
    const r1 = await run(c, [mkStep('envision')], new ScriptedInteract(['accept', 'accept']));
    expect(r1.stop).toBe('blocked-waiting'); // grill re-obtained, staged, confirm decided → the wait
    expect(c.events(TASK).filter((e) => e.type === 'submitted' && e.gate === 'grill')).toHaveLength(2);
    const r2 = await conclude(c, [mkStep('envision')]);
    expect(r2.stop).toBe('completed');
  });

  it('4 — a `waiting` with no later commit evidence blocks, and is written ONCE', async () => {
    const c = setup();
    chainFile([]); // the EMPTY chain — the runner does the work
    const r = await run(c, [], new ScriptedInteract(['accept']));
    expect(r.stop).toBe('blocked-waiting');
    expect(c.status(TASK)).toBe('blocked');
    await run(c, [], new ScriptedInteract(['accept']));
    expect(c.events(TASK).filter((e) => e.type === 'waiting')).toHaveLength(1);
  });

  it('4b — commit evidence DISCHARGES the wait: the same frame then concludes', async () => {
    const c = setup();
    chainFile([]);
    expect((await run(c, [], new ScriptedInteract(['accept']))).stop).toBe('blocked-waiting');
    c.evidence(TASK, [{ sha: 'abc1234' }], { note: 'the runner committed' });
    const r = await run(c, [], new ScriptedInteract(['accept']));
    expect(r.stop).toBe('completed');
    expect(c.status(TASK)).toBe('done');
  });
});

describe('the gate source is the CHAIN (core-design §6)', () => {
  const grillStep = (decision: string) =>
    mkStep('idea-validate', {
      decisions: ['solid', 'revise'],
      produces: ['stage-doc'],
      out: () => ({ ok: true, artifact: 'grilled', verdict: { decision }, intents: [{ kind: 'stage-doc', name: 'validation', content: '# v\n' }] }),
    });
  const CHAIN: ChainEntry[] = [
    { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject', feedback: 'sharpen it' } } },
    { id: 'envision' },
  ];

  it("routes the step's verdict to the gate decision — the human is never asked", async () => {
    const c = setup();
    chainFile(CHAIN);
    const human = new ScriptedInteract(['accept']); // the CONFIRM gate only — grill is decided by the verdict
    const r1 = await run(c, [grillStep('solid'), mkStep('envision')], human);
    expect(r1.stop).toBe('blocked-waiting');
    expect(human.asked.some((q) => q.includes("gate 'grill'"))).toBe(false);
    expect(c.events(TASK).some((e) => e.type === 'confirmed' && e.gate === 'grill')).toBe(true);
    const r2 = await conclude(c, [grillStep('solid'), mkStep('envision')]);
    expect(r2.stop).toBe('completed');
  });

  it('a verdict the map does not route FAILS CLOSED', async () => {
    const c = setup();
    chainFile(CHAIN);
    const r = await run(c, [grillStep('nonsense'), mkStep('envision')]);
    expect(r.stop).toBe('failed');
    expect(r.problems.join('\n')).toContain('unmapped-verdict');
  });

  it('a DECIDED gate still RUNS its bound step — the write is skipped, the step is not', async () => {
    const c = setup([ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    chainFile(CHAIN);
    let ran = 0;
    const grill = mkStep('idea-validate', {
      decisions: ['solid', 'revise'],
      out: () => {
        ran++;
        return { ok: true, artifact: 'grilled', verdict: { decision: 'solid' }, intents: [{ kind: 'stage-doc', name: 'validation', content: '# v\n' }] };
      },
    });
    const r1 = await run(c, [grill, mkStep('envision')], new ScriptedInteract(['accept']));
    expect(r1.stop).toBe('blocked-waiting');
    expect(ran).toBe(1);
    // the decided gate's staged doc reaches the SAME run's docs/ as the execute step's
    expect(readFileSync(docFile('validation'), 'utf8')).toContain('# v');
    expect(readFileSync(docFile('envision'), 'utf8')).toContain('# envision');
    expect(c.events(TASK).filter((e) => e.type === 'confirmed' && e.gate === 'grill')).toHaveLength(1);
    const r2 = await conclude(c, [grill, mkStep('envision')]);
    expect(r2.stop).toBe('completed');
    expect(ran).toBe(2);
  });

  it('a rejecting verdict re-obtains the gate, and the 3-reject bound ESCALATES', async () => {
    const c = setup();
    chainFile(CHAIN);
    const r = await run(c, [grillStep('revise'), mkStep('envision')]);
    expect(r.stop).toBe('escalated');
    expect(c.events(TASK).filter((e) => e.type === 'rejected')).toHaveLength(3); // the bound is a CONSTANT
  });
});

describe('verify — outputs, not acceptance events', () => {
  const barren = mkStep('envision', { produces: [], out: () => ({ ok: true, artifact: 'nothing staged' }) });

  it('a chain that produces no staged doc and no commit evidence fails verify, and cycles then fails', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    const r = await run(c, [barren], new ScriptedInteract(['accept']));
    expect(r.stop).toBe('failed');
    expect(r.problems.join('\n')).toContain('verify-ceiling');
    expect(c.status(TASK)).toBe('failed');
    // one cycle by default (flow.verifyFailCycles: 1), recorded as a frame-phase record
    expect(c.events(TASK).filter((e) => (e.trace as { kind?: string } | undefined)?.kind === 'verify')).toHaveLength(1);
  });

  it('honours flow.verifyFailCycles from the project registry, up to the ceiling', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ flow: { verifyFailCycles: 3 } }));
    const r = await run(c, [barren], new ScriptedInteract(['accept']));
    expect(r.stop).toBe('failed');
    expect(c.events(TASK).filter((e) => (e.trace as { kind?: string } | undefined)?.kind === 'verify')).toHaveLength(3);
  });

  it('a missing acceptanceCriteria is a verify finding (F-AC19: ACs are the target)', async () => {
    const c = setup([ev('created')], { intent: 'x' });
    chainFile([{ id: 'envision' }]);
    const r = await run(c, [mkStep('envision')], new ScriptedInteract(['accept']));
    expect(r.problems.join('\n')).toContain('no acceptanceCriteria declared');
  });
});

describe('fail-closed before any write', () => {
  it('refuses to run on a config problem', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ flow: { verifyFailCycles: 9 } }));
    const r = await run(c, [mkStep('envision')]);
    expect(r.stop).toBe('not-ready');
    expect(r.phase).toBe('config');
    expect(c.events(TASK).map((e) => e.type)).toEqual(['created']); // nothing written
  });

  it('refuses to run on a chain problem, naming it', async () => {
    const c = setup();
    chainFile([{ id: 'teleport' }]);
    const r = await run(c, [mkStep('envision')]);
    expect(r.stop).toBe('not-ready');
    expect(r.problems.join('\n')).toContain('not registered');
    expect(c.events(TASK).map((e) => e.type)).toEqual(['created']);
  });

  it('refuses an unresolvable requiredInput — the ladder blocks, nothing is inferred', async () => {
    const c = setup([ev('created')], { ...CONTRACT, requiredInputs: ['nothing-locks-this'] });
    chainFile([{ id: 'envision' }]);
    const r = await run(c, [mkStep('envision')]);
    expect(r.stop).toBe('not-ready');
    expect(r.phase).toBe('materialize');
  });
});

describe('conditional execution (flow.conditionals)', () => {
  it('SKIPS a step whose condition is false and records it as kind:skip', async () => {
    const c = setup();
    mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ flow: { conditionals: true } }));
    chainFile([{ id: 'envision' }, { id: 'spec', when: { verdict: { step: 'envision', decision: 'go' } } }]);
    // envision decides 'stop', so spec's condition is FALSE and spec never runs
    const envision = mkStep('envision', {
      decisions: ['go', 'stop'],
      out: () => ({ ok: true, artifact: 'a', verdict: { decision: 'stop' }, intents: [{ kind: 'stage-doc', name: 'envision', content: '# e\n' }] }),
    });
    const spec = mkStep('spec', { out: () => ({ ok: true, artifact: 'never' }) });
    const r1 = await run(c, [envision, spec], new ScriptedInteract(['accept', 'accept']));
    expect(r1.stop).toBe('blocked-waiting');
    expect(r1.outcomes.find((o) => o.step === 'spec')?.ran).toBe(false);
    const skips = c.events(TASK).map((e) => e.trace as { kind?: string; stepId?: string } | undefined).filter((t) => t?.kind === 'skip');
    expect(skips).toEqual([{ kind: 'skip', stepId: 'spec', condition: 'verdict:envision=go', evaluated: false }]);
    const r2 = await conclude(c, [envision, spec]);
    expect(r2.stop).toBe('completed');
  });

  it('a `when` may reference the GRILL step that DECIDED the gate — its verdict reaches execute (depth routing)', async () => {
    // idea-validate is grill-bound; an execute step is conditional on its depth verdict.
    // The gate phase seeds the produced map with the deciding step's outcome, so the
    // conditional reads the depth the GRILL decided — never a silent always-skip.
    const config = () => {
      const c = setup();
      mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
      writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ flow: { conditionals: true } }));
      return c;
    };
    const grill = (decision: string) =>
      mkStep('idea-validate', {
        decisions: ['clear', 'ambiguous'],
        out: () => ({ ok: true, artifact: 'grilled', verdict: { decision }, intents: [{ kind: 'stage-doc', name: 'validation', content: '# v\n' }] }),
      });

    // CLEAR verdict → the conditional step does NOT run
    const c1 = config();
    chainFile([
      { id: 'idea-validate', at: 'grill', verdict: { clear: { gate: 'accept' }, ambiguous: { gate: 'accept' } } },
      { id: 'envision', when: { verdict: { step: 'idea-validate', decision: 'ambiguous' } } },
    ]);
    let ran1 = 0;
    const env1 = mkStep('envision', { out: () => { ran1++; return { ok: true, artifact: 'a' }; } });
    const r1 = await run(c1, [grill('clear'), env1], new ScriptedInteract(['accept']));
    expect(r1.stop).toBe('blocked-waiting');
    expect(ran1).toBe(0); // skipped
    expect(r1.outcomes.find((o) => o.step === 'envision')?.ran).toBe(false);
    const d1 = await conclude(c1, [grill('clear'), env1]);
    expect(d1.stop).toBe('completed');
    expect(ran1).toBe(0); // still skipped on the concluding run

    // AMBIGUOUS verdict → the same conditional step DOES run
    const c2 = config();
    chainFile([
      { id: 'idea-validate', at: 'grill', verdict: { clear: { gate: 'accept' }, ambiguous: { gate: 'accept' } } },
      { id: 'envision', when: { verdict: { step: 'idea-validate', decision: 'ambiguous' } } },
    ]);
    let ran2 = 0;
    const env2 = mkStep('envision', { out: () => { ran2++; return { ok: true, artifact: 'a' }; } });
    const r2 = await run(c2, [grill('ambiguous'), env2], new ScriptedInteract(['accept']));
    expect(r2.stop).toBe('blocked-waiting');
    expect(ran2).toBe(1); // ran
    expect(r2.outcomes.find((o) => o.step === 'envision')?.ran).toBe(true);
    const d2 = await conclude(c2, [grill('ambiguous'), env2]);
    expect(d2.stop).toBe('completed');
    expect(ran2).toBe(2); // ran on the concluding run too
  });
});

describe('the runner reviewer (S6) IS the verify phase (architecture-v3 §76)', () => {
  it('a task the runner can execute without guessing passes the review — no extra findings', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }]);
    const r1 = await run(c, [mkStep('envision')], new ScriptedInteract(['accept', 'accept']));
    expect(r1.stop).toBe('blocked-waiting'); // staged + confirm decided → the two-phase wait
    expect(r1.runnerReview?.verdict).toBe('pass');
    expect(r1.runnerReview?.blockers).toEqual([]);
    expect(r1.problems.join('\n')).not.toContain('runner-review:');
    const r2 = await conclude(c, [mkStep('envision')]);
    expect(r2.stop).toBe('completed');
    expect(r2.runnerReview?.verdict).toBe('pass');
  });

  it('blocking confusion is a NAMED verify finding, never a silent pass', async () => {
    const c = setup([ev('created')], { intent: 'x' }); // no ACs — the runner would guess what 'done' means
    chainFile([{ id: 'envision' }]);
    const r = await run(c, [mkStep('envision')], new ScriptedInteract(['accept']));
    expect(r.runnerReview?.verdict).toBe('reject');
    expect(r.problems.join('\n')).toContain('runner-review:');
    expect(r.problems.join('\n')).toContain('no acceptanceCriteria');
    expect(r.stop).toBe('failed'); // rejection → the bounded verify loop → failed, never passed
  });

  it('the empty-chain flow is the runner’s own work channel — the review is skipped (a verify-fail there is a WAIT)', async () => {
    const c = setup();
    chainFile([]);
    const r = await run(c, [], new ScriptedInteract(['accept']));
    expect(r.runnerReview).toBeUndefined();
    expect(r.stop).toBe('blocked-waiting');
    expect(c.status(TASK)).toBe('blocked');
  });
});

describe('the read view + prior are the two input channels (§5)', () => {
  it('binds a chain role from an earlier step through `prior`, and a packet dep through `read`', async () => {
    const c = setup();
    chainFile([{ id: 'envision' }, { id: 'spec', inputs: { vision: 'envision' } }]);
    let seen: unknown;
    const spec = mkStep('spec', { roles: [{ name: 'vision', required: true }], out: (ctx) => { seen = ctx.prior.vision; return { ok: true, artifact: 's', intents: [{ kind: 'stage-doc', name: 'spec', content: '# s\n' }] }; } });
    const r1 = await run(c, [mkStep('envision'), spec], new ScriptedInteract(['accept', 'accept']));
    expect(r1.stop).toBe('blocked-waiting');
    expect(seen).toBe('envision artifact');
    // the staged docs live in the repo's git docs/ home — never a task artifacts/ file
    expect(existsSync(docFile('spec'))).toBe(true);
    expect(readFileSync(docFile('envision'), 'utf8')).toContain('# envision');
    const r2 = await conclude(c, [mkStep('envision'), spec]);
    expect(r2.stop).toBe('completed');
    expect(seen).toBe('envision artifact');
  });
});
