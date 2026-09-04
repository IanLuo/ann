import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../store/store.js';
import { Commands } from '../../../commands/index.js';
import { Frame } from '../../frame.js';
import { Abilities, InteractAbility, ResearchFinding } from '../../types.js';
import { buildStepRegistry } from '../index.js';

/**
 * THE REAL STEPS, THROUGH THE REAL FRAME, ON THE PROJECT'S REAL CHAIN DATA — only the
 * abilities are fakes. This is where the pieces meet: the grill gate takes its decision
 * from `idea-validate`'s verdict, `spec` gets the vision through its declared ROLE, the
 * three locks record together at commit, and a RE-RUN replays from the transcript
 * instead of re-interviewing the human.
 */

let root: string;
const TASK = '01-leg/01-a';

const GRILL = JSON.stringify({ summary: 'Buildable.', validation: [{ verdict: 'ok', claim: 'Fits the goal', basis: ['x-spec'], confidence: 'high' }], questions: [] });
const VISION = JSON.stringify({ summary: 'A vision summary.', usage: [{ claim: 'The user runs it', kind: 'scenario', basis: [], confidence: 'high' }], look: [], questions: [] });
const SPEC = '# Spec\n\n## Requirements\n- It works [vision]\n';

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

function setup(): Commands {
  root = mkdtempSync(join(tmpdir(), 'ann-steps-'));
  for (const [id, contract, events] of [
    ['01-leg', {}, []],
    [TASK, { intent: 'Build the thing', acceptanceCriteria: ['AC-1'] }, [ev('created')]],
  ] as Array<[string, unknown, Array<Record<string, unknown>>]>) {
    const dir = join(root, '.ann', 'journey', 'legs', id);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
    if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  // THE PROJECT'S OWN CHAIN SHAPE (shaping, v4) — grill-bound validator whose verdict
  // carries the depth, then a CONDITIONAL envision (only when ambiguous), then spec
  mkdirSync(join(root, '.ann', 'rules', 'flow'), { recursive: true });
  writeFileSync(
    join(root, '.ann', 'rules', 'flow', 'default.json'),
    JSON.stringify({
      chains: {
        default: [
          { id: 'idea-validate', at: 'grill', verdict: { clear: { gate: 'accept' }, ambiguous: { gate: 'accept' }, revise: { gate: 'reject', feedback: 'sharpen the idea' }, reject: { gate: 'reject', feedback: 'the idea was rejected' } } },
          { id: 'envision', when: { verdict: { step: 'idea-validate', decision: 'ambiguous' } } },
          { id: 'spec', inputs: { vision: 'envision' } },
        ],
      },
    }),
  );
  // the conditional chain needs flow.conditionals enabled (project registry)
  mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
  writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ flow: { conditionals: true } }));
  return new Commands(new Store(root), 'test');
}
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake human. The frame's OWN gate question is answered `accept`; the validation
 *  session's solidness question gets the scripted verdict; the session's DEPTH question
 *  (shaping) gets the scripted route. Three distinct decisions on one channel — which is
 *  exactly the shape the real chain has. */
class Human implements InteractAbility {
  readonly asked: string[] = [];
  readonly decided: string[] = [];
  constructor(private readonly verdict = 'solid', private readonly route: 'vision' | 'light' = 'vision') {}
  async present() {}
  async ask(q: string) {
    this.asked.push(q);
    return 'an answer';
  }
  async research(topics: string[]): Promise<ResearchFinding[]> {
    return topics.map((t) => ({ topic: t, findings: 'researched' }));
  }
  async decide(q: string, _o: string[]) {
    this.decided.push(q);
    if (q.startsWith('decide gate')) return 'accept';
    if (q.includes('solid enough to proceed')) return this.verdict;
    return this.route; // the depth decide — vision or light
  }
}

/** Completions keyed by WHICH ENGINE asked — a rework re-runs a step, so a positional
 *  queue would run dry and fail the step for the wrong reason. */
function abilities(human: Human): { abilities: Abilities; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    abilities: {
      llm: {
        async complete(req) {
          prompts.push(req.prompt);
          if (req.prompt.includes('validate/grilling engine')) return GRILL;
          if (req.prompt.includes('envision engine')) return VISION;
          return SPEC;
        },
      },
      interact: human,
    },
  };
}

const runFrame = (c: Commands, human: Human) => {
  const a = abilities(human);
  return new Frame({ commands: c, root, registry: buildStepRegistry(), abilities: a.abilities }).run(TASK).then((r) => ({ r, prompts: a.prompts }));
};

const artifact = (name: string) => readFileSync(join(root, '.ann', 'journey', 'legs', TASK, 'artifacts', `${name}.md`), 'utf8');

describe('the real shaping chain: idea-validate@grill → [vision] → spec', () => {
  it("an AMBIGUOUS idea routes the full path: vision runs, its claims reach the spec by ROLE, and all three lock at commit", async () => {
    const c = setup();
    const human = new Human('solid', 'vision');
    const { r, prompts } = await runFrame(c, human);

    expect(r.problems).toEqual([]);
    expect(r.stop).toBe('completed');
    // the grill gate was decided by the STEP — the human was asked for a verdict, not a gate
    expect(c.events(TASK).some((e) => e.type === 'confirmed' && e.gate === 'grill')).toBe(true);
    expect(human.decided.some((q) => q.includes('solid enough to proceed'))).toBe(true);

    // the spec prompt carries the vision claims — the role bound to envision's artifact
    const specPrompt = prompts.find((p) => p.includes('spec-expansion step'))!;
    expect(specPrompt).toContain('The user runs it');

    expect(r.committed?.locked.map((l) => l.name).sort()).toEqual(['idea-validation', 'spec', 'vision']);
    expect(artifact('vision')).toContain('# Product Vision');
    // the thin model (leg 07): the working file stays the step's own bytes — lock!
    // records the log event and never stamps or rewrites the file
    expect(artifact('spec')).toContain(SPEC);
    expect(artifact('spec')).not.toMatch(/^<!-- specs:locked:/);
    expect(artifact('idea-validation')).toContain('# Idea Validation Doc');
  });

  it('a `revise` verdict routes the grill gate to REJECT and the rework rung re-runs the validator', async () => {
    const c = setup();
    const { r } = await runFrame(c, new Human('revise'));
    expect(r.stop).toBe('escalated'); // three rejections — the bound is gate!'s constant
    const rejects = c.events(TASK).filter((e) => e.type === 'rejected');
    expect(rejects).toHaveLength(3);
    // the STEP's own feedback wins over the map's default — the map says what a decision
    // MEANS for the gate; the step says why it reached it
    expect(rejects[0].feedback).toContain('The idea as validated');
    expect(rejects[0].feedback).not.toBe('sharpen the idea');
  });
});

describe('depth routing (shaping AC-2/AC-3) — the vision is CONDITIONAL on the grill verdict', () => {
  it('a CLEAR solid idea (route: light) runs straight to a LIGHT spec — NO vision runs, NO vision artifact', async () => {
    const c = setup();
    const human = new Human('solid', 'light');
    const { r, prompts } = await runFrame(c, human);

    expect(r.problems).toEqual([]);
    expect(r.stop).toBe('completed');
    expect(r.outcomes.find((o) => o.step === 'envision')?.ran).toBe(false); // skipped
    // the skip is RECORDED as a frame-phase trace
    const skips = c.events(TASK).map((e) => e.trace as { kind?: string; stepId?: string; condition?: string } | undefined).filter((t) => t?.kind === 'skip');
    expect(skips).toContainEqual({ kind: 'skip', stepId: 'envision', condition: 'verdict:idea-validate=ambiguous', evaluated: false });
    // the light path locked idea-validation + spec only — the vision NEVER ran (its
    // prompt was never asked) and no vision artifact exists
    expect(r.committed?.locked.map((l) => l.name).sort()).toEqual(['idea-validation', 'spec']);
    expect(prompts.some((p) => p.includes('envision engine'))).toBe(false); // no VISION completion
    expect(prompts.find((p) => p.includes('spec-expansion step'))).toContain('no vision bound');
    // the spec still locked a real (light) document
    expect(artifact('spec')).toContain(SPEC);
    expect(existsSync(join(root, '.ann', 'journey', 'legs', TASK, 'artifacts', 'vision.md'))).toBe(false);
  });

  it('an AMBIGUOUS solid idea (route: vision) still runs vision then spec (the full path survives)', async () => {
    const c = setup();
    const { r, prompts } = await runFrame(c, new Human('solid', 'vision'));
    expect(r.problems).toEqual([]);
    expect(r.stop).toBe('completed');
    expect(r.outcomes.find((o) => o.step === 'envision')?.ran).toBe(true);
    expect(r.committed?.locked.map((l) => l.name).sort()).toEqual(['idea-validation', 'spec', 'vision']);
    expect(existsSync(join(root, '.ann', 'journey', 'legs', TASK, 'artifacts', 'vision.md'))).toBe(true);
    // the spec prompt still carries the vision claims (role-bound)
    expect(prompts.find((p) => p.includes('spec-expansion step'))).toContain('The user runs it');
  });
});

describe('replay — the transcript, not the feedback, decides', () => {
  it('a re-run after an undecided confirm gate REPLAYS: the human is never re-interviewed', async () => {
    const c = setup();
    const human = new Human('solid');
    await runFrame(c, human);
    const askedFirst = [...human.asked];
    const decidedFirst = [...human.decided];
    expect(decidedFirst.length).toBeGreaterThan(0);

    // re-run the SAME completed task: every gate is decided, so the frame re-runs the
    // steps and every recordable call is served from the transcript
    const second = new Human('solid');
    const { r, prompts } = await runFrame(c, second);
    expect(r.problems).toEqual([]);
    expect(r.stop).toBe('completed');
    expect(second.asked).toEqual([]); // no re-interview
    expect(second.decided).toEqual([]); // no re-decision
    expect(prompts).toEqual([]); // no re-completion — the llm was replayed too
    expect(askedFirst.length + decidedFirst.length).toBeGreaterThan(0);
  });

  it('the transcript records every recordable call, and `present` is NOT among them', () => {
    const c = setup();
    return runFrame(c, new Human('solid')).then(() => {
      const kinds = c
        .events(TASK)
        .map((e) => (e.trace as { kind?: string } | undefined)?.kind)
        .filter(Boolean);
      expect(kinds).toContain('llm');
      expect(kinds).toContain('decide');
      expect(kinds).not.toContain('present');
    });
  });
});
