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
 * SPEC is the one staged doc (docs/spec.md — git content), and a RE-RUN replays from the
 * transcript instead of re-interviewing the human.
 *
 * TWO-PHASE CONCLUSION (F-AC18): a run that STAGES a doc stops `blocked-waiting` once the
 * confirm gate is decided accept but no commit evidence exists; the task concludes on a
 * RE-RUN after the operator records `evidence.commits[]`.
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

/** A staged doc lives at the repo's git home — <root>/docs/<name>.md. */
const docPath = (name: string) => join(root, 'docs', `${name}.md`);
const doc = (name: string) => readFileSync(docPath(name), 'utf8');

/** The OPERATOR's half of the two-phase conclusion: the staged doc is `git commit`ed and
 *  the commit is recorded as structured evidence (evidence.commits[]). The sha is a
 *  placeholder — only store.check() resolves shas in git, and these tests never call it. */
function recordCommitEvidence(c: Commands): void {
  const r = c.evidence(TASK, [{ sha: 'abc1234', note: 'spec staged' }], { note: 'the staged doc is committed' });
  expect(r.ok).toBe(true);
}

describe('the real shaping chain: idea-validate@grill → [vision] → spec', () => {
  it("an AMBIGUOUS idea routes the full path: vision runs, its claims reach the spec by ROLE, and the staged spec concludes in two phases", async () => {
    const c = setup();
    const human = new Human('solid', 'vision');
    const { r: first, prompts } = await runFrame(c, human);

    // run 1 — the spec is STAGED, the confirm gate is decided accept, but with no commit
    // evidence the frame stops blocked-waiting (F-AC18 two-phase conclusion)
    expect(first.problems).toEqual([]);
    expect(first.stop).toBe('blocked-waiting');
    // the grill gate was decided by the STEP — the human was asked for a verdict, not a gate
    expect(c.events(TASK).some((e) => e.type === 'confirmed' && e.gate === 'grill')).toBe(true);
    expect(human.decided.some((q) => q.includes('solid enough to proceed'))).toBe(true);

    // the spec prompt carries the vision claims — the role bound to envision's in-memory artifact
    const specPrompt = prompts.find((p) => p.includes('spec-expansion step'))!;
    expect(specPrompt).toContain('The user runs it');

    // ONLY the spec is staged as a doc — the validation + vision are in-memory role
    // artifacts (idea-validate produces nothing; envision declares no produces)
    expect(doc('spec')).toContain(SPEC);
    expect(doc('spec')).not.toMatch(/^<!-- specs:locked:/);
    expect(existsSync(docPath('idea-validation'))).toBe(false);
    expect(existsSync(docPath('vision'))).toBe(false);

    // run 2 — commit evidence recorded: the re-run concludes
    recordCommitEvidence(c);
    const { r: second } = await runFrame(c, new Human('solid'));
    expect(second.problems).toEqual([]);
    expect(second.stop).toBe('completed');
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
  it('a CLEAR solid idea (route: light) runs straight to a LIGHT spec — NO vision runs, NO vision doc', async () => {
    const c = setup();
    const human = new Human('solid', 'light');
    const { r: first, prompts } = await runFrame(c, human);

    expect(first.problems).toEqual([]);
    expect(first.stop).toBe('blocked-waiting'); // staged spec — the two-phase conclusion
    expect(first.outcomes.find((o) => o.step === 'envision')?.ran).toBe(false); // skipped
    // the skip is RECORDED as a frame-phase trace
    const skips = c.events(TASK).map((e) => e.trace as { kind?: string; stepId?: string; condition?: string } | undefined).filter((t) => t?.kind === 'skip');
    expect(skips).toContainEqual({ kind: 'skip', stepId: 'envision', condition: 'verdict:idea-validate=ambiguous', evaluated: false });
    // the light path staged spec only — the vision NEVER ran (its prompt was never asked)
    expect(prompts.some((p) => p.includes('envision engine'))).toBe(false); // no VISION completion
    expect(prompts.find((p) => p.includes('spec-expansion step'))).toContain('no vision bound');
    // the spec still staged a real (light) document
    expect(doc('spec')).toContain(SPEC);
    expect(existsSync(docPath('vision'))).toBe(false);

    // conclude on the re-run once the operator records commit evidence
    recordCommitEvidence(c);
    const { r: second } = await runFrame(c, new Human('solid'));
    expect(second.problems).toEqual([]);
    expect(second.stop).toBe('completed');
  });

  it('an AMBIGUOUS solid idea (route: vision) still runs vision then spec (the full path survives)', async () => {
    const c = setup();
    const { r: first, prompts } = await runFrame(c, new Human('solid', 'vision'));
    expect(first.problems).toEqual([]);
    expect(first.stop).toBe('blocked-waiting'); // staged spec — the two-phase conclusion
    expect(first.outcomes.find((o) => o.step === 'envision')?.ran).toBe(true);
    // the vision is IN-MEMORY — its claims reach the spec by role, but no vision doc is staged
    expect(existsSync(docPath('spec'))).toBe(true);
    expect(existsSync(docPath('vision'))).toBe(false);
    // the spec prompt still carries the vision claims (role-bound)
    expect(prompts.find((p) => p.includes('spec-expansion step'))).toContain('The user runs it');

    // conclude on the re-run once the operator records commit evidence
    recordCommitEvidence(c);
    const { r: second } = await runFrame(c, new Human('solid'));
    expect(second.problems).toEqual([]);
    expect(second.stop).toBe('completed');
  });
});

describe('replay — the transcript, not the feedback, decides', () => {
  it('a re-run after the two-phase wait REPLAYS: the human is never re-interviewed', async () => {
    const c = setup();
    const human = new Human('solid');
    const { r: first } = await runFrame(c, human);
    expect(first.stop).toBe('blocked-waiting'); // the spec was staged; waiting on commit evidence
    const askedFirst = [...human.asked];
    const decidedFirst = [...human.decided];
    expect(decidedFirst.length).toBeGreaterThan(0);

    // release the wait — the operator commits the staged doc (structured commit evidence)
    recordCommitEvidence(c);

    // re-run the SAME task: every gate is decided, so the frame replays the steps and
    // every recordable call is served from the transcript
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
