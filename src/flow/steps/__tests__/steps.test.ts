import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  // THE PROJECT'S OWN CHAIN SHAPE — grill-bound validator, then envision, then spec
  mkdirSync(join(root, '.ann', 'rules', 'flow'), { recursive: true });
  writeFileSync(
    join(root, '.ann', 'rules', 'flow', 'default.json'),
    JSON.stringify({
      chains: {
        default: [
          { id: 'idea-validate', at: 'grill', verdict: { solid: { gate: 'accept' }, revise: { gate: 'reject', feedback: 'sharpen the idea' }, reject: { gate: 'reject', feedback: 'the idea was rejected' } } },
          { id: 'envision' },
          { id: 'spec', inputs: { vision: 'envision' } },
        ],
      },
    }),
  );
  return new Commands(new Store(root), 'test');
}
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake human. The frame's OWN gate question is answered `accept`; the validation
 *  session's verdict question gets the scripted verdict. Two distinct decisions on one
 *  channel — which is exactly the shape the real chain has. */
class Human implements InteractAbility {
  readonly asked: string[] = [];
  readonly decided: string[] = [];
  constructor(private readonly verdict = 'solid') {}
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
    return q.startsWith('decide gate') ? 'accept' : this.verdict;
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

describe('the real chain: idea-validate@grill → envision → spec', () => {
  it("takes the grill gate from the validator's verdict, binds the vision by ROLE, and locks all three at commit", async () => {
    const c = setup();
    const human = new Human('solid');
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
    // lock! stamps the provenance marker at commit; the body is the step's own bytes
    expect(artifact('spec')).toContain(SPEC);
    expect(artifact('spec')).toMatch(/^<!-- specs:locked:[0-9a-f]{7} /);
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
