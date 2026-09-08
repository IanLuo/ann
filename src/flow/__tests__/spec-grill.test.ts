import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { GrillSession, DECISION_OPTIONS, EXHAUSTED_OPTIONS } from '../grill-session.js';
import { SPECS_PROFILE, SPEC_GRILL_MODE, SPEC_DISCUSS_MODE } from '../spec-grill.js';
import { GOAL_GRILL_MODE, GOAL_DISCUSS_MODE } from '../goal-grill.js';
import { DESIGN_BRIEF_GRILL_MODE, DESIGN_BRIEF_DISCUSS_MODE } from '../design-grill.js';
import { docsSpecsTarget, runSpecSession, specDocFrom } from '../spec-doc.js';
import { Store } from '../../store/store.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';

/**
 * THE SPECS AREA (flow/spec-grill + flow/spec-doc) — a SPECS GrillArea on the portable
 * GrillSession core (AC-1/AC-2/AC-3 of leg 05):
 *
 *   (a) SPECS_PROFILE carries the REQUIREMENTS/SYSTEM-DESIGN boundary and wires it into the
 *       SAME portable core the goal + design areas run on — one core, three real areas;
 *   (b) a PRODUCE session grills the SEEDED GOAL (grounded on the goal + the in-force docs)
 *       toward ONE named spec doc (default requirements); on the human's GO it writes
 *       docs/<name>.md + regenerates the manifest and returns {path, sha} for the operator
 *       to git-commit — docs-as-git, exactly like goal! seed's goal.md hand-off;
 *   (c) an AMEND session targets an EXISTING in-force spec doc, grounds on its CURRENT
 *       content + the goal + work context, and on GO overwrites docs/<name>.md in place
 *       (the old version stays in git history) — the session states it is AMENDING, because
 *       specs are LIVING, amendable guidance (unlike the immutable goal);
 *   (d) the deterministic materializer writes the living/amendable doc header — specs say
 *       so in the doc itself.
 *
 * Same doubles as the goal/design suites: a scripted human (FIFO answers/decisions,
 * running out is the ABORT) + a fake llm (sequential completions).
 */

class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly asked: string[] = [];
  readonly decided: { question: string; options: string[] }[] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly decisions: string[] = [],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(question: string): Promise<string> {
    this.asked.push(question);
    const a = this.answers.shift();
    if (a === undefined) throw new InteractAbort('scripted interactor ran out of answers');
    return a;
  }
  async research(): Promise<ResearchFinding[]> {
    return [];
  }
  async decide(question: string, options: string[]): Promise<string> {
    this.decided.push({ question, options });
    const d = this.decisions.shift();
    if (d === undefined) throw new InteractAbort('scripted interactor ran out of decisions');
    return d;
  }
}

const fakeLlm = (responses: string[]): { llm: LlmAbility; prompts: string[]; calls: { n: number } } => {
  const prompts: string[] = [];
  const calls = { n: 0 };
  let i = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      prompts.push(req.prompt);
      calls.n += 1;
      const next = responses[i++];
      if (next === undefined) throw new Error('fake llm ran out of scripted responses');
      return next;
    },
  };
  return { llm, prompts, calls };
};

const throwingLlm = (message: string): { llm: LlmAbility; calls: { n: number } } => {
  const calls = { n: 0 };
  const llm: LlmAbility = {
    async complete() {
      calls.n += 1;
      throw new Error(message);
    },
  };
  return { llm, calls };
};

const grill = (summary: string, validation: unknown[] = [], questions: unknown[] = []) =>
  JSON.stringify({ summary, validation, questions });

const clean = (summary: string, claim = 'the spec states a concrete, checkable requirement') =>
  grill(summary, [{ verdict: 'ok', claim, basis: [], confidence: 'high' }]);

const HIGH_Q = () => ({
  question: 'What surface must the system expose first?',
  reason: 'defines the v1 requirement boundary',
  impact: 'high' as const,
  options: ['the CLI', 'the API'],
  default: 'the CLI',
});

const decisionCalls = (i: ScriptedInteractor) => i.decided.filter((d) => d.options.includes('GO'));

/** A goal.md that the store parses 1:1 (Goal:/Success criteria: machine sections). */
const GOAL_MD = `# Goal

Goal: A goal! seed command that turns a rough goal into a seeded, checkable session.

Success criteria:
- A goal! seed command exists.
- the seeded session is checkable (Goal:/criteria machine-readable).
`;

let root: string;
const legs = () => join(root, '.ann', 'journey', 'legs');
const specDoc = (name: string) => join(root, 'docs', `${name}.md`);

/** A fresh project with a REAL seeded goal (docs/goal.md + the goal leg, exactly as
 *  goal! seed writes them) — the ground every SPECS session requires. */
const seeded = (): void => {
  root = mkdtempSync(join(tmpdir(), 'ann-specs-'));
  mkdirSync(legs(), { recursive: true });
  new Store(root).seedGoal(GOAL_MD);
};

/** Add an in-force doc (docs/<name>.md + a manifest entry) — grounding the session. */
const addInForceDoc = (name: string, content: string): void => {
  writeFileSync(specDoc(name), content);
  writeDocsManifest(root, scanDocsDir(root)); // the manifest regenerates from the dir
};

describe('(a) SPECS_PROFILE — the requirements boundary, wired into the SAME portable core', () => {
  it('registers the SPECS area with its own copy + the boundary directives (never the goal/design ones)', () => {
    expect(SPECS_PROFILE.id).toBe('spec');
    expect(SPECS_PROFILE.title).toBe('Spec grill');
    expect(SPECS_PROFILE.noun).toBe('spec');
    expect(SPECS_PROFILE.goAction).toBe('Write the spec'); // the GO verb is the AREA's
    expect(SPECS_PROFILE.grilling).toBe(SPEC_GRILL_MODE);
    expect(SPECS_PROFILE.reasoning).toBe(SPEC_DISCUSS_MODE);
  });

  it('the SPECS directive grills WITHIN the requirements/system-design band …', () => {
    for (const inside of ['requirements/system-design', 'scope', 'constraints', 'acceptance', 'what the system must do']) {
      expect(SPEC_GRILL_MODE.toUpperCase()).toContain(inside.toUpperCase());
    }
  });

  it('… and DEFERS code-level implementation — a HOW is never grilled, never a blocking concern', () => {
    // the directive must forbid code-level implementation questions …
    expect(SPEC_GRILL_MODE).toContain('NEVER ask HOW');
    expect(SPEC_GRILL_MODE).toContain('code-level');
    expect(SPEC_GRILL_MODE).toContain('DEFER');
    expect(SPEC_GRILL_MODE).toContain('belongs to the implementation stage');
    // … and must not re-grill what the (immutable) goal already fixed
    expect(SPEC_GRILL_MODE.toUpperCase()).toContain('GOAL'.toUpperCase());
    expect(SPEC_GRILL_MODE).toContain('already fixed');
    // the reasoning half is aligned to the SAME boundary
    expect(SPEC_DISCUSS_MODE).toContain('belongs to the implementation stage');
  });
});

describe('(b/AC-2) runSpecSession — PRODUCE grills the seeded goal into docs/<name>.md on GO', () => {
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('GO on a clean grill writes docs/requirements.md (the default name), regenerates the manifest, and returns path/sha — goal + verify clean', async () => {
    seeded();
    addInForceDoc('core-design', '# Core design\n\nThe journey is a table of gated legs.');
    const claim = 'the goal doc locks on the human GO and stays machine-checkable';
    const statement = 'The system must provide a goal! seed command that grills a rough goal at session scope and seeds a checkable session.';
    const { llm, prompts, calls } = fakeLlm([clean(statement, claim)]);
    const interact = new ScriptedInteractor([], ['GO']);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact }, { mode: 'produce' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(calls.n).toBe(1); // one grill, one round, one GO
    expect(r.mode).toBe('produce');
    expect(r.name).toBe('requirements'); // the decided default doc
    expect(r.path).toBe('docs/requirements.md');
    expect(r.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(r.statement).toBe(statement);
    expect(r.commitments[0]).toBe(statement); // the refined reading always leads the doc
    expect(r.commitments).toContain(claim);

    // the doc is REAL git content in docs/ — living/amendable header + the Spec: line
    const md = readFileSync(specDoc('requirements'), 'utf8');
    expect(md.startsWith('# Requirements\n')).toBe(true);
    expect(md.toUpperCase()).toContain('LIVING');
    expect(md.toUpperCase()).toContain('AMENDABLE');
    expect(md).toContain(`Spec: ${statement}`);
    expect(md).toContain(`- ${claim}`);

    // the landing regenerated the manifest — the repo's own resolution reaches the doc
    const reloaded = new Store(root);
    expect(reloaded.resolveDoc('requirements')?.path).toBe('docs/requirements.md');
    expect(reloaded.resolveDoc('requirements')?.sha).toMatch(/^[0-9a-f]{7}$/);
    // the goal is untouched; docs content is git content — verify stays clean (D2/D4)
    expect(reloaded.ids()).toEqual(['01-goal']);
    expect(reloaded.verify()).toEqual([]);

    // the grill ran under the SPECS directive — never the goal/design one — grounded on
    // the goal + the in-force docs
    expect(prompts[0]).toContain(SPEC_GRILL_MODE);
    expect(prompts[0]).not.toContain(GOAL_GRILL_MODE);
    expect(prompts[0]).not.toContain(DESIGN_BRIEF_GRILL_MODE);
    expect(prompts[0]).toContain('core-design'); // the in-force docs grounded the session
    // the session's own copy, not the goal's
    expect(interact.presented.some((p) => p.includes('── Spec grill · round 1 ──'))).toBe(true);
    expect(decisionCalls(interact)[0].options).toEqual([...EXHAUSTED_OPTIONS]);
    expect(decisionCalls(interact)[0].question).toContain('Write the spec (GO)');
  });

  it('a question round folds the answered constraint into the doc as a commitment (question → answer)', async () => {
    seeded();
    const q = HIGH_Q();
    const { llm } = fakeLlm([
      grill('The system must provide a goal! seed command.', [{ verdict: 'ok', claim: 'the lead surface matters', basis: [], confidence: 'high' }], [q]),
      'The CLI is the lead surface; nothing else is open.',
      JSON.stringify({ recommendation: 'GO', reason: 'the v1 requirement boundary is settled' }),
    ]);
    const interact = new ScriptedInteractor(['the CLI', 'sorted'], ['GO']);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact }, { mode: 'produce' });

    expect(r.ok && r.written).toBe(true);
    if (!r.ok || !r.written) return;
    expect(r.commitments).toContain(`${q.question} → the CLI`);
    expect(readFileSync(specDoc('requirements'), 'utf8')).toContain(`${q.question} → the CLI`);
  });

  it('SKIP ends with nothing written — an honest note', async () => {
    seeded();
    const { llm } = fakeLlm([clean('A reading.')]);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor([], ['SKIP']) }, { mode: 'produce' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.written) return;
    expect(r.verdict).toBe('reject');
    expect(r.note).toContain('skipped');
    expect(existsSync(specDoc('requirements'))).toBe(false);
  });

  it('PRODUCE onto a name that is already in force refuses BEFORE any provider call (a spec is amended, never duplicated)', async () => {
    seeded();
    addInForceDoc('requirements', '# Requirements\n\nexisting in-force spec');
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'produce' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('in-force');
    expect(r.error.blocker).toContain('--amend');
    expect(calls.n).toBe(0); // the refusal precedes the grill — dogfoodable without a provider
    expect(readFileSync(specDoc('requirements'), 'utf8')).toBe('# Requirements\n\nexisting in-force spec'); // untouched
  });

  it('provider-absent fails CLOSED — nothing is written', async () => {
    seeded();
    const { llm, calls } = throwingLlm('no provider reachable');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'produce' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('provider-unavailable');
    expect(calls.n).toBeGreaterThan(0);
    expect(existsSync(specDoc('requirements'))).toBe(false);
  });

  it('ANTI-RUNAWAY: a grill dug across converged rounds hits the small ceiling → the close-out, nothing written', async () => {
    seeded();
    const closeText = 'Two rounds dug and no open edge surfaced; the spec reads concrete. To continue, re-run spec! sharper or raise the round ceiling.';
    const { llm } = fakeLlm([clean('Reading one.'), clean('Reading two.'), closeText]);
    const interact = new ScriptedInteractor([], ['dig more', 'dig more']);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact }, { mode: 'produce', maxRounds: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.written) return;
    expect(r.verdict).toBe('revise'); // the value that recommends a sharper re-run
    expect(r.note).toContain('anti-runaway');
    expect(r.note).toContain('nothing was created');
    expect(interact.presented.some((p) => p.includes('Spec grill — anti-runaway stop'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('re-run spec!'))).toBe(true);
    expect(existsSync(specDoc('requirements'))).toBe(false);
  });
});

describe('(c/AC-3) runSpecSession — AMEND revises an existing in-force spec doc in place', () => {
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  /** Produce docs/requirements.md in-force first, so an amend has something to target. */
  const produceOnce = async (statement: string, decisions: string[] = ['GO']): Promise<void> => {
    const { llm } = fakeLlm([clean(statement)]);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor([], decisions) }, { mode: 'produce' });
    expect(r.ok && r.written).toBe(true);
  };

  it('grounds on the CURRENT doc + the goal, states it is AMENDING, and rewrites docs/<name>.md on GO', async () => {
    seeded();
    const first = 'The system must provide a goal! seed command for v1.';
    const revised = 'The system must provide a goal! seed command AND a spec! amend command for v1.';
    await produceOnce(first);

    const { llm, prompts } = fakeLlm([clean(revised)]);
    const interact = new ScriptedInteractor([], ['GO']);
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact }, { mode: 'amend' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.written).toBe(true);
    if (!r.written) return;
    expect(r.mode).toBe('amend');
    expect(r.name).toBe('requirements');
    expect(r.path).toBe('docs/requirements.md'); // the doc stays current — git holds the old version
    expect(r.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(r.statement).toBe(revised);

    // the SESSION states it is amending (the preamble, before the first round)
    expect(interact.presented[0]).toMatch(/AMEND/i);
    expect(interact.presented[0]).toContain('docs/requirements.md');
    // the grill grounded on the CURRENT doc content (the old version as the draft) + the goal
    expect(prompts[0]).toContain(SPEC_GRILL_MODE);
    expect(prompts[0]).toContain(first);

    // docs/<name>.md was REWRITTEN in place — only the revised doc remains, resolvable
    const md = readFileSync(specDoc('requirements'), 'utf8');
    expect(md).toContain(`Spec: ${revised}`);
    expect(md).not.toContain(first);
    const reloaded = new Store(root);
    expect(reloaded.resolveDoc('requirements')?.path).toBe('docs/requirements.md');
    expect(reloaded.ids()).toEqual(['01-goal']);
    expect(reloaded.verify()).toEqual([]);
  });

  it('AMEND of a name NOT in force refuses BEFORE any provider call (produce it first)', async () => {
    seeded();
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'amend' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('no-spec-doc');
    expect(calls.n).toBe(0);
  });

  it('AMEND of the goal doc itself refuses — the goal is IMMUTABLE (specs are amendable; the goal is not)', async () => {
    seeded();
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'amend', name: 'goal' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('goal-immutable');
    expect(r.error.blocker).toMatch(/goal/);
    expect(calls.n).toBe(0);
    // the goal doc is untouched
    expect(new Store(root).resolveDoc('goal')?.path).toBe('docs/goal.md');
  });
});

describe('(guard) runSpecSession — the seeded-goal and name guards fail CLOSED before the grill', () => {
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('NO SEEDED GOAL refuses before any provider call (docs/goal.md is the authored truth — seed it first)', async () => {
    root = mkdtempSync(join(tmpdir(), 'ann-specs-'));
    mkdirSync(legs(), { recursive: true });
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'produce' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('no-goal');
    expect(r.error.blocker).toContain('goal! seed');
    expect(calls.n).toBe(0);
  });

  it('an unlandable doc name fails before any provider call', async () => {
    seeded();
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runSpecSession(docsSpecsTarget(root), { llm, interact: new ScriptedInteractor() }, { mode: 'produce', name: 'Requirements Spec' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-name');
    expect(calls.n).toBe(0);
  });
});

describe('specDocFrom — the deterministic materialize (NO second model call)', () => {
  it('writes the living/amendable header, the Spec: line, then the claims and answered constraints; low-impact never commits', () => {
    const md = specDocFrom({
      name: 'requirements',
      statement: 'The system must provide\na goal! seed command.', // a model newline — collapses to ONE line
      okClaims: ['the goal doc locks on GO', ''],
      resolved: [
        { id: 'q1', question: 'Which surface leads?', answer: 'the CLI', impact: 'high' },
        { id: 'q2', question: 'Amendable?', answer: 'yes, in place', impact: 'medium' },
        { id: 'q3', question: 'Mood?', answer: 'calm', impact: 'low' }, // low → never a commitment
      ],
    });
    const commitments = md.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    expect(md.startsWith('# Requirements\n')).toBe(true);
    expect(md.toUpperCase()).toContain('LIVING');
    expect(md.toUpperCase()).toContain('AMENDABLE');
    expect(md).toContain('Spec: The system must provide a goal! seed command.');
    expect(commitments).toEqual([
      'The system must provide a goal! seed command.',
      'the goal doc locks on GO',
      'Which surface leads? → the CLI',
      'Amendable? → yes, in place',
    ]);
    expect(md).not.toContain('calm');
  });
});
