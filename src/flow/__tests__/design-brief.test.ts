import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { GrillSession, DECISION_OPTIONS, EXHAUSTED_OPTIONS } from '../grill-session.js';
import { DESIGN_PROFILE, DESIGN_BRIEF_GRILL_MODE, DESIGN_BRIEF_DISCUSS_MODE } from '../design-grill.js';
import { GOAL_GRILL_MODE, GOAL_DISCUSS_MODE } from '../goal-grill.js';
import { docsDesignTarget, runDesignBrief, designBriefFrom } from '../design-brief.js';
import { Store } from '../../store/store.js';

/**
 * THE DESIGN AREA (flow/design-grill + flow/design-brief) — AC-3/AC-4/AC-5:
 *
 *   (a) DESIGN_PROFILE carries the DESIGN boundary directives and wires them into the
 *       SAME portable GrillSession core the goal area runs on — this is the portability
 *       proof: two real areas (goal + design) on one core, goal behavior unchanged;
 *   (b) the profile's copy is area-owned (its own title/noun/GO verb — never the goal
 *       area's); the shared engine's appended-instructions header is area-neutral;
 *   (c) the driver (runDesignBrief) materializes the converged brief on the human's GO
 *       into docs/design/ (the DECIDED landing — a design folder inside docs/), the
 *       manifest regenerates so the repo's own resolution conventions reach it, and the
 *       goal suites stay green unchanged.
 *
 * Same test doubles as the goal area's suites: a scripted human (FIFO answers/decisions,
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

const clean = (summary: string, claim = 'the direction is actionable') =>
  grill(summary, [{ verdict: 'ok', claim, basis: [], confidence: 'high' }]);

const HIGH_Q = () => ({
  question: 'Which surface does the design lead with?',
  reason: 'defines the first flow',
  impact: 'high' as const,
  options: ['the journey view', 'the node view'],
  default: 'the journey view',
});

const DIRECTION = 'Design a calm, glanceable journeys-at-a-glance UI for the journey product.';

const decisionCalls = (i: ScriptedInteractor) => i.decided.filter((d) => d.options.includes('GO'));

describe('(a/AC-3) DESIGN_PROFILE — the design boundary, wired into the SAME portable core', () => {
  it('the profile registers the design area with its own copy and the DESIGN boundary directives', () => {
    expect(DESIGN_PROFILE.id).toBe('design');
    expect(DESIGN_PROFILE.title).toBe('Design grill');
    expect(DESIGN_PROFILE.noun).toBe('brief');
    expect(DESIGN_PROFILE.goAction).toBe('Land the brief'); // the GO verb is the AREA's — never the goal's 'Seed now'
    expect(DESIGN_PROFILE.grilling).toBe(DESIGN_BRIEF_GRILL_MODE);
    expect(DESIGN_PROFILE.reasoning).toBe(DESIGN_BRIEF_DISCUSS_MODE);
    // the directive grills WITHIN the design band …
    for (const inside of ['FLOWS', 'INFORMATION ARCHITECTURE', 'VISUAL DIRECTION', 'users']) {
      expect(DESIGN_BRIEF_GRILL_MODE.toUpperCase()).toContain(inside.toUpperCase());
    }
    // … and DEFERS what is below (implementation) or already fixed upstream
    expect(DESIGN_BRIEF_GRILL_MODE).toContain('belongs to the implementation stage');
    expect(DESIGN_BRIEF_GRILL_MODE).toContain('already decided upstream (the goal/requirements)');
    expect(DESIGN_BRIEF_GRILL_MODE).toContain('DEFER');
    expect(DESIGN_BRIEF_DISCUSS_MODE).toContain('belongs to the implementation stage');
  });

  it('PORTABILITY — a scripted DESIGN grill converges to solid on the same doubles the goal area uses: one grill → exhausted menu → human GO', async () => {
    const { llm, prompts } = fakeLlm([clean('A calm journeys-at-a-glance UI.')]);
    const interact = new ScriptedInteractor([], ['GO']);
    const r = await new GrillSession({ llm, interact }, DESIGN_PROFILE).run({ subject: DIRECTION, maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', statement: 'A calm journeys-at-a-glance UI.', rounds: 1 });
    if (!r.ok || r.verdict !== 'solid') return;
    // the DESIGN directive ran — never the GOAL one; the appended header is area-neutral
    expect(prompts[0]).toContain(DESIGN_BRIEF_GRILL_MODE);
    expect(prompts[0]).not.toContain(GOAL_GRILL_MODE);
    expect(prompts[0]).toContain('## Session-mode instructions');
    expect(prompts[0]).not.toContain('Goal-mode instructions');
    // the area's own headers/copy — not the goal's
    expect(interact.presented.some((p) => p.includes('── Design grill · round 1 ──'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('BRIEF (as it reads): A calm journeys-at-a-glance UI.'))).toBe(true);
    // EXHAUSTED semantics are the SAME across areas: GO / refine / skip — no 'dig more'
    const calls = decisionCalls(interact);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual([...EXHAUSTED_OPTIONS]);
    // and the GO verb is the DESIGN area's copy, never the goal's 'Seed now'
    expect(calls[0].question).toContain('Land the brief (GO)');
    expect(calls[0].question).not.toContain('Seed now');
  });

  it('PORTABILITY — the reasoning path is area-neutral too: a question round reasons with the DESIGN directive, not the GOAL one', async () => {
    const q = HIGH_Q();
    const { llm, prompts } = fakeLlm([
      grill('A calm UI.', [{ verdict: 'ok', claim: 'the surface split is sound', basis: [], confidence: 'high' }], [q]),
      'The journey view leads; nothing else is open.',
      JSON.stringify({ recommendation: 'GO', reason: 'the design direction is actionable at this level' }),
    ]);
    const interact = new ScriptedInteractor(['the journey view', 'sorted'], ['GO']);
    const r = await new GrillSession({ llm, interact }, DESIGN_PROFILE).run({ subject: DIRECTION, maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid' });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(r.resolved).toEqual([{ id: 'q1', question: q.question, answer: 'the journey view', impact: 'high' }]);
    expect(prompts).toHaveLength(3); // grill → synthesis → DECISION — the same mechanics as the goal tests
    expect(prompts[1]).toContain(DESIGN_BRIEF_DISCUSS_MODE); // the DESIGN reasoning directive ran
    expect(prompts[1]).not.toContain(GOAL_DISCUSS_MODE); // never the goal one
    // a NON-exhausted round offers the full four options — same as every area
    const calls = decisionCalls(interact);
    expect(calls[0].options).toEqual([...DECISION_OPTIONS]);
    expect(calls[0].question).not.toContain('Seed now');
  });

  it('PORTABILITY — refine reshapes the brief in-session; the next round grills the human words and GO returns the refined direction', async () => {
    const refined = 'A calm, glanceable journey map with the node inspector tucked behind the detail pane.';
    const round1 = grill('A calm UI.', [{ verdict: 'ok', claim: 'a lead surface is needed', basis: [], confidence: 'high' }], [HIGH_Q()]);
    const round2 = clean('A calm journey map with the node detail tucked behind a pane.');
    const { llm, prompts } = fakeLlm([round1, 'Read-back one.', JSON.stringify({ recommendation: 'refine', reason: 'the direction needs a concrete lead surface' }), round2]);
    const interact = new ScriptedInteractor(['the journey view', 'sorted', refined], ['refine', 'GO']);
    const r = await new GrillSession({ llm, interact }, DESIGN_PROFILE).run({ subject: DIRECTION, maxRounds: 3 });

    expect(r).toMatchObject({ ok: true, verdict: 'solid', statement: 'A calm journey map with the node detail tucked behind a pane.', rounds: 2 });
    if (!r.ok || r.verdict !== 'solid') return;
    expect(prompts[3]).toContain('node inspector tucked behind the detail pane'); // the re-grill grills the human's own words
    expect(interact.asked).toContain('What should change about the design direction? Refine the brief in your own words — the next round grills what you say here.');
  });
});

describe('(c/AC-4 + driver) runDesignBrief — the converged brief lands in docs/design (the decided home)', () => {
  let root: string;
  const legs = () => join(root, '.ann', 'journey', 'legs');
  const briefPath = (slug: string) => join(root, 'docs', 'design', `${slug}.md`);
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const fresh = (): string => {
    root = mkdtempSync(join(tmpdir(), 'ann-designbrief-'));
    mkdirSync(legs(), { recursive: true });
    return root;
  };

  it('GO on a clean grill lands the brief at docs/design/<slug>.md, manifest-regenerated and resolvable (commitments: direction first, then the ok claims and answered constraints)', async () => {
    fresh();
    const claim = 'the design stays glanceable: no more than a screenful of journey at once';
    const { llm, calls } = fakeLlm([clean('A calm journeys-at-a-glance UI with a tuckable detail pane.', claim)]);
    const interact = new ScriptedInteractor([], ['GO']);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact }, { idea: DIRECTION, name: 'journey-ui', constraints: ['No new infra'] });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.landed).toBe(true);
    if (!r.landed) return;
    expect(calls.n).toBe(1); // one grill, one round, one GO
    expect(r.name).toBe('journey-ui');
    expect(r.path).toBe('docs/design/journey-ui.md');
    expect(r.direction).toBe('A calm journeys-at-a-glance UI with a tuckable detail pane.');
    // the brief is REAL git content in the decided home — manifest-regenerated + resolvable
    const md = readFileSync(briefPath('journey-ui'), 'utf8');
    expect(md.startsWith('# Design Brief\n\nBrief: A calm journeys-at-a-glance UI with a tuckable detail pane.')).toBe(true);
    expect(md).toContain(`- ${claim}`);
    expect(r.commitments[0]).toBe('A calm journeys-at-a-glance UI with a tuckable detail pane.');
    expect(r.commitments).toContain(claim);
    // the landing regenerated the manifest — the repo's own resolution conventions reach it
    const reloaded = new Store(root);
    expect(reloaded.resolveDoc('design/journey-ui')?.path).toBe('docs/design/journey-ui.md');
    expect(reloaded.resolveDoc('design/journey-ui')?.sha).toMatch(/^[0-9a-f]{7}$/);
    // docs/design content is git content — the store verifies clean (no orphan/lock claims)
    expect(reloaded.verify()).toEqual([]);
  });

  it('a question round folds the answer into the brief as a commitment (question → answer), grounded from the session', async () => {
    fresh();
    const q = HIGH_Q();
    const { llm } = fakeLlm([
      grill('A calm journeys-at-a-glance UI.', [{ verdict: 'ok', claim: 'the lead surface matters', basis: [], confidence: 'high' }], [q]),
      'The journey view leads the design.',
      JSON.stringify({ recommendation: 'GO', reason: 'the lead surface is settled — actionable' }),
    ]);
    const interact = new ScriptedInteractor(['the journey view', 'sorted'], ['GO']);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact }, { idea: DIRECTION, name: 'journey-ui' });

    expect(r.ok && r.landed).toBe(true);
    if (!r.ok || !r.landed) return;
    expect(r.commitments).toContain(`${q.question} → the journey view`);
    expect(readFileSync(briefPath('journey-ui'), 'utf8')).toContain(`${q.question} → the journey view`);
  });

  it('a name derived from the idea when none is given — the brief still lands under a safe slug', async () => {
    fresh();
    const { llm } = fakeLlm([clean('A calm journeys-at-a-glance UI.')]);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact: new ScriptedInteractor([], ['GO']) }, { idea: DIRECTION });
    expect(r.ok && r.landed).toBe(true);
    if (!r.ok || !r.landed) return;
    expect(r.name).toBe('design-a-calm-glanceable-journeys-at-a-glance-ui-for-the-journey-product');
    expect(existsSync(briefPath(r.name))).toBe(true);
  });

  it('SKIP ends with nothing landed — an honest note', async () => {
    fresh();
    const { llm } = fakeLlm([clean('A reading.')]);
    const interact = new ScriptedInteractor([], ['SKIP']);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact }, { idea: DIRECTION, name: 'journey-ui' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.landed) return;
    expect(r.verdict).toBe('reject');
    expect(r.note).toContain('skipped');
    expect(existsSync(briefPath('journey-ui'))).toBe(false);
  });

  it('a name that is already landed refuses — nothing is overwritten silently', async () => {
    fresh();
    const { llm } = fakeLlm([clean('A calm journeys-at-a-glance UI.')]);
    const first = await runDesignBrief(docsDesignTarget(root), { llm, interact: new ScriptedInteractor([], ['GO']) }, { idea: DIRECTION, name: 'journey-ui' });
    expect(first.ok && first.landed).toBe(true);
    const before = readFileSync(briefPath('journey-ui'), 'utf8');
    const { llm: l2 } = fakeLlm([clean('A DIFFERENT direction.')]);
    const second = await runDesignBrief(docsDesignTarget(root), { llm: l2, interact: new ScriptedInteractor([], ['GO']) }, { idea: DIRECTION, name: 'journey-ui' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('name-taken');
    expect(second.error.blocker).toContain('nothing was overwritten');
    expect(readFileSync(briefPath('journey-ui'), 'utf8')).toBe(before); // the first brief is untouched
  });

  it('an unlandable name fails BEFORE any provider call (fail-closed, dogfoodable without a provider)', async () => {
    fresh();
    const { llm, calls } = throwingLlm('should never be reached');
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact: new ScriptedInteractor() }, { idea: DIRECTION, name: '!!!' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid-name');
    expect(calls.n).toBe(0);
  });

  it('provider-absent fails CLOSED — the session returns ok:false and nothing is landed', async () => {
    fresh();
    const { llm, calls } = throwingLlm('no provider reachable');
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact: new ScriptedInteractor() }, { idea: DIRECTION, name: 'journey-ui' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('provider-unavailable');
    expect(calls.n).toBeGreaterThan(0);
    expect(existsSync(briefPath('journey-ui'))).toBe(false);
  });

  it('GATHER: a blank idea asks the human channel before grilling', async () => {
    fresh();
    const { llm } = fakeLlm([clean('A calm journeys-at-a-glance UI.')]);
    const interact = new ScriptedInteractor([DIRECTION], ['GO']);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact }, { name: 'journey-ui' });
    expect(r.ok && r.landed).toBe(true);
    if (!r.ok || !r.landed) return;
    expect(interact.presented.some((p) => p.includes('Design grill'))).toBe(true);
    expect(existsSync(briefPath('journey-ui'))).toBe(true);
  });

  it('ANTI-RUNAWAY: a grill dug across converged rounds hits the small explicit ceiling → the anti-runaway close-out, nothing landed', async () => {
    fresh();
    const closeText = 'Two rounds dug and no open edge surfaced; the direction reads actionable. To continue, re-run design! brief sharper or raise the round ceiling.';
    const { llm } = fakeLlm([clean('Reading one.'), clean('Reading two.'), closeText]);
    const interact = new ScriptedInteractor([], ['dig more', 'dig more']);
    const r = await runDesignBrief(docsDesignTarget(root), { llm, interact }, { idea: DIRECTION, name: 'journey-ui', maxRounds: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.landed) return;
    expect(r.verdict).toBe('revise');
    expect(r.note).toContain('anti-runaway');
    expect(r.note).toContain('nothing was created');
    expect(interact.presented.some((p) => p.includes('Design grill — anti-runaway stop'))).toBe(true);
    expect(interact.presented.some((p) => p.includes('re-run design! brief'))).toBe(true); // the area's own seed command in the copy
    expect(existsSync(briefPath('journey-ui'))).toBe(false);
  });
});

describe('designBriefFrom — the deterministic materialize (NO second model call)', () => {
  it('lands the direction first, then the ok claims and the high/medium answered constraints; low-impact answers never become commitments', () => {
    const md = designBriefFrom({
      direction: 'A calm\njourneys-at-a-glance UI.', // a newline the model left — collapses to ONE line
      okClaims: ['glanceable: a screenful of journey at once', ''],
      resolved: [
        { id: 'q1', question: 'Which surface leads?', answer: 'the journey view', impact: 'high' },
        { id: 'q2', question: 'Detail pane?', answer: 'yes, tucked', impact: 'medium' },
        { id: 'q3', question: 'Aesthetic mood?', answer: 'warm', impact: 'low' }, // low → never a commitment
      ],
    });
    const commitments = md.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    expect(md.startsWith('# Design Brief\n\nBrief: A calm journeys-at-a-glance UI.\n\nDesign commitments (the design must keep these true):')).toBe(true);
    expect(commitments).toEqual([
      'A calm journeys-at-a-glance UI.',
      'glanceable: a screenful of journey at once',
      'Which surface leads? → the journey view',
      'Detail pane? → yes, tucked',
    ]);
    expect(md).not.toContain('warm');
    expect(md).not.toContain('(none)'); // a converged brief always carries the direction
  });
});
