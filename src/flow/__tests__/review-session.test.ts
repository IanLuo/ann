import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { Store } from '../../store/store.js';
import { Commands } from '../../commands/index.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';
import {
  REVIEW_FINDINGS_MODE,
  REVIEW_PROFILE,
  REVIEW_PROVENANCE,
  buildReviewMaterial,
  runReviewSession,
  shapeFindings,
} from '../review-session.js';

/**
 * THE REVIEW SESSION (leg 12/09) — the session a human runs AT A GATE whose output is a
 * RECORD. What these prove:
 *  (a) AC-1 — it rides the PORTABLE core (the profile is data; the loop is the goal/specs/
 *      design loop), so the findings land through the one writer and are read back by the
 *      one derivation;
 *  (b) AC-4 — it decides NOTHING: no gate event is ever written, the findings land AS
 *      ASSERTED (a session that dies mid-way loses nothing), and the rounds are bounded;
 *  (c) AC-5 — the material it is run over is DERIVED and contains every named input
 *      (contract · criteria · commits · range · checks · resolved docs · prior findings),
 *      and where an input cannot be derived that is SAID rather than fabricated.
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-19', type, ...extra });

function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>>) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-09-19' }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const commands = () => new Commands(new Store(root), 'test');

const CONTRACT = {
  intent: 'Land a review findings record',
  acceptanceCriteria: ['the findings land on the addressed node', 'the gate read exposes them per finding'],
  requiredInputs: ['reviewed-spec'],
};

/** A task standing at its CONFIRM gate with a submission already recorded — the state a
 *  review is run in. The submission cites commits and carries one reported check. */
const atConfirm = () =>
  writeNode('01-leg/01-a', CONTRACT, [
    ev('created'),
    ev('submitted', { gate: 'grill' }),
    ev('confirmed', { gate: 'grill' }),
    ev('submitted', { gate: 'confirm' }),
    ev('evidence', { commits: [{ sha: 'abc1234', note: 'the delivery' }], checks: [{ command: 'npm test', result: 'pass', source: 'reported', detail: '9/9' }] }),
  ]);

/** The resolved defining doc the contract requires — the packet's dependency half. */
const withDocs = () => {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'reviewed-spec.md'), '# Reviewed spec\n\nThe record is per finding.\n');
  writeDocsManifest(root, scanDocsDir(root));
};

/** A scripted human — FIFO; running out is the ABORT. */
class ScriptedInteractor implements InteractAbility {
  readonly presented: string[] = [];
  readonly decided: { question: string; options: string[] }[] = [];
  constructor(
    private readonly answers: string[] = [],
    private readonly decisions: string[] = [],
  ) {}
  async present(text: string) {
    this.presented.push(text);
  }
  async ask(): Promise<string> {
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

/**
 * A model that answers by WHAT IT WAS ASKED — the findings turn is scripted per ROUND (the
 * round number is in its own prompt), so a test says what each pass found without counting
 * model calls. The default branch is the grill turn, which is the first call of each round.
 */
const scriptedLlm = (rounds: unknown[][]) => {
  const prompts: string[] = [];
  let round = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      const p = req.prompt;
      prompts.push(p);
      if (p.includes('producing the FINDINGS')) {
        const n = Number(/\(round (\d+)\)/.exec(p)?.[1] ?? 1);
        return JSON.stringify({ findings: rounds[n - 1] ?? [] });
      }
      if (p.includes('DECISION advisor')) return JSON.stringify({ recommendation: 'GO', reason: 'the findings are complete and localized' });
      if (p.includes('mid-DISCUSSION')) return JSON.stringify({ reply: 'noted', research: null });
      if (p.includes('mid-session on a')) return 'My call: GO — the record is complete.';
      round++; // the grill turn — the first model call of every round
      // the engine refuses an EMPTY grill, so the read carries one settled row (an 'ok'
      // read needs no reasoning turn: the round is exhausted and the menu is GO/refine/skip)
      return JSON.stringify({ summary: 'the delivery as it reads against its contract', validation: [{ verdict: 'ok', claim: 'AC-1 is met by the profile' }], questions: [] });
    },
  };
  return { llm, prompts };
};

/** A model whose findings turn FAILS on round 2 — a session that dies mid-way. */
const dyingLlm = (): { llm: LlmAbility; calls: () => number } => {
  let round = 0;
  let calls = 0;
  const llm: LlmAbility = {
    async complete(req: { prompt: string }) {
      calls++;
      const p = req.prompt;
      if (p.includes('producing the FINDINGS')) {
        if (round >= 2) throw new Error('the provider died mid-review');
        return JSON.stringify({ findings: [F1] });
      }
      if (p.includes('DECISION advisor')) return JSON.stringify({ recommendation: 'GO', reason: 'complete' });
      if (p.includes('mid-DISCUSSION')) return JSON.stringify({ reply: 'noted', research: null });
      if (p.includes('mid-session on a')) return 'My call: GO — the record is complete.';
      round++;
      return JSON.stringify({ summary: 'the delivery as it reads', validation: [{ verdict: 'ok', claim: 'AC-1 holds' }], questions: [] });
    },
  };
  return { llm, calls: () => calls };
};

const F1 = { id: 'F1', severity: 'gap', where: 'src/surface/approve.ts:212', text: 'AC-2 is unmet: the gate read does not print the findings', status: 'open' };
const F2 = { id: 'F2', severity: 'quality', where: 'src/store/store.ts:1819', text: 'the stale case is unmarked when a pass omits a finding', status: 'open' };

const FIXED = 'a59bf00d3bbf572a73d75da178aaa2f3e2608834';
const FIXED_HEAD = 'b54b67a00f97e15c74e805deb001f5752548aeb8';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-review-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('AC-1 · the session rides the portable core and lands a RECORD', () => {
  it('lands what the model asserted — through the one writer, read back by the one derivation', async () => {
    atConfirm();
    withDocs();
    const c = commands();
    const human = new ScriptedInteractor([], ['GO']);
    const { llm, prompts } = scriptedLlm([[F1, F2]]);
    const r = await runReviewSession(c, { llm, interact: human }, '01-leg/01-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe('recorded');
    expect(r.passes).toBe(1);
    expect(r.rounds).toBe(1);

    // (a) the record is on the ADDRESSED node, shaped and stamped by the area
    const landed = c.events('01-leg/01-a').at(-1)!;
    expect(landed.type).toBe('evidence');
    expect(landed.findings).toEqual([F1, F2].map((f) => ({ ...f, provenance: REVIEW_PROVENANCE })));
    // the review's own files are noted, and the citations hang off the anchor
    expect(String(landed.note)).toContain('test');
    // (b) DERIVED-READABLE: the card's one derivation exposes them, per finding
    expect(c.reviewFindings('01-leg/01-a').findings.map((f) => [f.id, f.severity, f.where, f.status])).toEqual([
      ['F1', 'gap', 'src/surface/approve.ts:212', 'open'],
      ['F2', 'quality', 'src/store/store.ts:1819', 'open'],
    ]);
    // (c) the session ASKED the model for findings — the profile's hook is wired
    expect(prompts.some((p) => p.includes(REVIEW_FINDINGS_MODE))).toBe(true);
    // (d) the human saw the menu under the AREA's GO verb, and GO is a done gesture —
    //     the option itself stays the engine's neutral word
    expect(human.decided.at(-1)!.options).toEqual(['GO', 'refine', 'skip']);
    expect(human.decided.at(-1)!.question).toContain('Land the findings (GO)');
  });

  it('the AREA stamps provenance and PICKS the fields — a model cannot author a finding or smuggle a key', async () => {
    // the raw items are the CORE's (unknown[]): the area maps them, never spreads them
    const shaped = shapeFindings(
      [
        { ...F1, provenance: 'human (the operator)', basis: ['the diff'], severity: 'gap', status: 'open' },
        { id: 'F9', severity: 'strange', where: 'x.ts:1', text: 'x', status: 'fixed' },
        'not an object',
      ],
      REVIEW_PROVENANCE,
    );
    expect(shaped).toEqual([
      { id: 'F1', severity: 'gap', where: 'src/surface/approve.ts:212', text: F1.text, status: 'open', provenance: REVIEW_PROVENANCE },
      // the VOCABULARY is the writer's to refuse; the area only maps (an unreadable status
      // reads as OPEN — the conservative reading, re-checked by the next pass)
      { id: 'F9', severity: 'strange', where: 'x.ts:1', text: 'x', status: 'open', provenance: REVIEW_PROVENANCE },
    ]);
    // …and the forged author never reaches the log: the writer refuses the unknown field the
    // area dropped, and stores the one the area stamped
    atConfirm();
    const c = commands();
    expect(c.landFindings('01-leg/01-a', shaped).ok).toBe(false); // 'strange' is not a severity
    expect(c.landFindings('01-leg/01-a', [shaped[0]]).ok).toBe(true);
    expect(c.events('01-leg/01-a').at(-1)!.findings).toEqual([shaped[0]]);
    expect(c.events('01-leg/01-a').at(-1)!.findings).not.toHaveProperty('basis');
  });
});

describe('AC-4 · the session decides NOTHING, and is bounded', () => {
  it('writes NO gate event — reviewing a task can never accept, reject or close it', async () => {
    atConfirm();
    const c = commands();
    const before = c.events('01-leg/01-a').map((e) => e.type);
    const { llm } = scriptedLlm([[F1, F2]]);
    const r = await runReviewSession(c, { llm, interact: new ScriptedInteractor([], ['GO']) }, '01-leg/01-a');
    expect(r.ok).toBe(true);
    // the record is the ONLY thing a session adds: no confirmed/rejected/completed appears
    expect(c.events('01-leg/01-a').map((e) => e.type)).toEqual([...before, 'evidence']);
    expect(c.status('01-leg/01-a')).toBe('blocked');
    expect(c.detail('01-leg/01-a').next).toEqual({ gate: 'confirm', verdict: 'waiting-on-decision' });
  });

  it('lands AS ASSERTED — a session that dies mid-way loses nothing it already found', async () => {
    atConfirm();
    const c = commands();
    const { llm, calls } = dyingLlm();
    // round 1 records F1 and the human asks to REFINE; round 2's grill succeeds but its
    // findings turn hits a dead provider → the session fails CLOSED, and F1 is already
    // on the node — the record is never further behind the conversation that produced it.
    const r = await runReviewSession(c, { llm, interact: new ScriptedInteractor(['focus the review on AC-2'], ['refine']) }, '01-leg/01-a');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('provider-unavailable');
    expect(r.error.blocker).toContain('the provider died mid-review');
    const finds = c.reviewFindings('01-leg/01-a').findings;
    expect(finds.map((f) => [f.id, f.status])).toEqual([['F1', 'open']]);
    expect(calls()).toBeGreaterThan(1);
  });

  it('is BOUNDED — the anti-runaway ceiling closes honestly with the record intact', async () => {
    atConfirm();
    const c = commands();
    const { llm } = scriptedLlm([[F1]]);
    // maxRounds 1 + the human refining every round = the ceiling, never an open loop
    const r = await runReviewSession(c, { llm, interact: new ScriptedInteractor(['sharpen it'], ['refine']) }, '01-leg/01-a', { maxRounds: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe('exhausted');
    expect(r.rounds).toBe(1);
    expect(r.findings.map((f) => f.id)).toEqual(['F1']);
  });

  it('a skipped review lands nothing — no findings, and still no gate event', async () => {
    atConfirm();
    const c = commands();
    const before = c.events('01-leg/01-a').map((e) => e.type);
    const { llm } = scriptedLlm([[]]); // the model found nothing to record
    const r = await runReviewSession(c, { llm, interact: new ScriptedInteractor([], ['skip']) }, '01-leg/01-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe('aborted');
    expect(r.passes).toBe(0);
    expect(c.events('01-leg/01-a').map((e) => e.type)).toEqual(before);
  });
});

describe('AC-5 · the material is DERIVED, and every named input is in it', () => {
  it('carries the contract · the criteria · the commits · the range · the checks · the resolved docs', () => {
    atConfirm();
    withDocs();
    const m = buildReviewMaterial(commands(), '01-leg/01-a');
    const byLabel = new Map(m.context.map((c) => [c.label, c]));

    expect(m.subject).toContain('01-leg/01-a');
    expect(m.subject).toContain('Land a review findings record');
    expect(m.constraints).toEqual(['AC-1: the findings land on the addressed node', 'AC-2: the gate read exposes them per finding']);
    expect(byLabel.get('submission.commits')!.text).toContain('abc1234 — the delivery');
    expect(byLabel.get('checks')!.text).toContain('npm test: pass — REPORTED CLAIM');
    expect(byLabel.get('input.reviewed-spec')!.text).toContain('docs/reviewed-spec.md @');
    expect(byLabel.get('input.reviewed-spec')!.text).toContain('The record is per finding.');

    // the RANGE cannot be derived here (the fixture's shas are not commits in any repo) —
    // and that is SAID rather than fabricated: the honesty layer extends to the material.
    expect(m.range).toBe('');
    expect(m.anchor).toBe('abc1234');
    expect(byLabel.get('submission.range')!.text).toContain('could not be derived');
  });

  it('says which sha a citation is anchored to, and carries any PRIOR findings', () => {
    atConfirm();
    const c = commands();
    c.landFindings('01-leg/01-a', [{ ...F1, severity: 'gap' as const, status: 'open' as const, provenance: REVIEW_PROVENANCE }], { anchorSha: 'abc1234' });
    const m = buildReviewMaterial(c, '01-leg/01-a');
    const prior = m.context.find((x) => x.label === 'prior.findings')!;
    // the landing is dated by the WRITER's clock (the record's own date, never the finder's)
    expect(prior.text).toMatch(/Pass 1 \(\d{4}-\d{2}-\d{2}\)/);
    expect(prior.text).toContain('cited at abc1234');
    expect(prior.text).toContain('F1 [gap] src/surface/approve.ts:212');
  });

  // AC-5a′ — against the REAL journey. 12/08's own review read the bytes of
  // `a59bf00..b54b67a`; the naive rule (the previous cited head as the base) yields
  // `1dc9b92..b54b67a` — one commit short, and exactly the commit that INTRODUCED the work
  // under review. So this asserts the derivation on real shas, not a fixture's.
  it("derives 12/08's range from real shas — the range its own review was read over", () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const m = buildReviewMaterial(new Commands(new Store(repoRoot), 'test'), '12-operate-loop/08-implementation-one-gate-derivation');
    expect(m.range).toBe(`${FIXED}..b54b67a`);
    expect(m.anchor).toBe('b54b67a');
    expect(m.context.find((c) => c.label === 'submission.commits')!.text).toContain('1dc9b92');
    expect(m.context.find((c) => c.label === 'submission.commits')!.text).toContain('b54b67a');
    // the DIFF is the primary object of a review — it is really there, and really bounded
    const diff = m.context.find((c) => c.label === 'submission.diff')!;
    expect(diff.text).toContain('diff --git');
    expect(m.constraints[0]).toMatch(/^AC-1: /);
    expect(FIXED_HEAD.startsWith('b54b67a')).toBe(true); // the head the log recorded, resolved
  });

  // AC-5's oracle MEASURED two context defects (2026-09-22, over 12/08's range): the patch
  // was cut before the first source body, and a defect in a file the delivery never touched
  // could not appear at all. Both fixes are pinned here.
  it('carries the change MAP whole, and excludes only the record’s own churn from the patch', () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const m = buildReviewMaterial(new Commands(new Store(repoRoot), 'test'), '12-operate-loop/08-implementation-one-gate-derivation');
    const byLabel = new Map(m.context.map((c) => [c.label, c]));
    // the MAP is complete — a file whose patch was cut is still named, so nothing is invisible
    const map = byLabel.get('submission.changedFiles')!.text;
    expect(map).toContain('src/store/workflow.ts');
    expect(map).toContain('src/surface/approve.ts');
    expect(map).toContain('files changed');
    // the patch carries real SOURCE bytes (not just the journey log, which path order puts first)
    const diff = byLabel.get('submission.diff')!.text;
    expect(diff).toContain('+++ b/src/flow/frame.ts');
    expect(diff).not.toContain('+++ b/.ann/journey');
    // …and the exclusion is DISCLOSED, never silent
    expect(diff).toContain('omits .ann/journey');
    // the cut is declared inline, so a partial view is never mistaken for the whole
    expect(diff).toMatch(/chars cut/);
  });

  it('a profile that declares no findings hook is untouched — the material is the only difference', () => {
    // REVIEW is the ONLY profile with the hook: the three existing areas run the same loop
    expect(REVIEW_PROFILE.findings).toEqual({ instruction: REVIEW_FINDINGS_MODE });
    expect(REVIEW_PROFILE.id).toBe('review');
    expect(REVIEW_PROFILE.seedVerb).toBe('ann review!');
    expect(REVIEW_PROFILE.defaultMaxRounds).toBeGreaterThan(0);
  });
});

/**
 * 12/23 · THE CRITERION-LEVEL EVIDENCE — the fix for the reason `auto accept` was inert.
 *
 * MEASURED 2026-09-26, driving the worker against the configured provider on a clone: a
 * delivery the floor had certified closeable drew `uncertain` after `uncertain`, and every
 * one of them asked for the same thing — the evidence behind a CLAIM. `brief` already held
 * it (`conclusion.claims`, with the engine's own resolution of each mapping); the material
 * carried only the flat `checks` list, so four criteria mapped to one `npm test` pass were
 * indistinguishable from four separately-verified ones, and no test text was carried at all.
 *
 * WHAT IS PINNED: the mapping reaches the reviewer WITH the record's resolution of it (AC-1);
 * the test content behind a claim is carried, selected by a rule and BOUNDED with its bound
 * stated (AC-2); and the material names its own limits rather than leaving the reviewer to
 * discover them (AC-4).
 */

/** A task at confirm whose conclusion CLAIMS its criteria — a mapping for the material to
 *  render, and one that exercises all three of its cases at once: a claim that RESOLVES, a
 *  claim whose check was never run, and an AC never claimed at all. The checks are REPORTED
 *  (written as events, never executed) so the fixture stays hermetic and fast. */
const claiming = () =>
  writeNode(
    '01-leg/01-a',
    { ...CONTRACT, acceptanceCriteria: ['the first thing lands', 'the second thing lands', 'the third thing lands'] },
    [
      ev('created'),
      ev('submitted', { gate: 'grill' }),
      ev('confirmed', { gate: 'grill' }),
      ev('evidence', {
        commits: [{ sha: 'abc1234', note: 'the delivery' }],
        checks: [{ command: 'npm test', result: 'pass', source: 'reported', detail: '9/9' }],
        claims: [
          { ac: 'AC-1', check: 'npm test', statement: 'the suite pins it' },
          { ac: 'AC-2', check: 'npm run typecheck', statement: 'the check that was never run' },
        ],
      }),
    ],
  );

describe('AC-1 · the claims are CARRIED, each beside the run the record resolves for it', () => {
  it('renders the mapping WITH its resolution, and NAMES the unbound and the unclaimed', () => {
    claiming();
    const m = buildReviewMaterial(commands(), '01-leg/01-a');
    const claims = m.context.find((c) => c.label === 'submission.claims')!.text;

    // the author's half — the statement and which run they stand behind …
    expect(claims).toContain('AC-1 — the first thing lands');
    expect(claims).toContain('claimed: the suite pins it');
    // … and the RECORD's half, marked as the record's: a reported check is a typed claim,
    // and the reviewer is told which of the two it is looking at
    expect(claims).toContain('npm test — pass (REPORTED CLAIM');

    // A CLAIM WHOSE RUN NEVER HAPPENED IS SAID, NOT DROPPED. Omitting it would read as "no
    // claim here", which is the opposite of what the record holds — the failure mode this
    // whole section exists to close.
    expect(claims).toContain('AC-2 — the second thing lands');
    expect(claims).toContain('npm run typecheck — UNBOUND');

    // an AC neither claimed nor transferred is NAMED for the same reason: silence about it
    // is the one reading a reviewer cannot tell apart from "there is nothing here"
    expect(claims).toContain('AC-3 — the third thing lands');
    expect(claims).toContain('UNCLAIMED');
  });

  it('is assembled from the record, never typed — no claims means every AC reads UNCLAIMED', () => {
    atConfirm(); // the fixture's evidence carries a CHECK but no claims
    withDocs();
    const m = buildReviewMaterial(commands(), '01-leg/01-a');
    const claims = m.context.find((c) => c.label === 'submission.claims')!.text;
    // nothing is invented: with no mapping on the record the section states that, per AC,
    // rather than going quiet — an unreviewed criterion is exactly what a reviewer must see
    expect(claims).toContain('AC-1 — the findings land on the addressed node');
    expect(claims).toContain('UNCLAIMED');
    // no INVENTED claim line — the header's own sentence names the label, so the assertion is
    // about the rendered field rather than about the word appearing anywhere
    expect(claims).not.toMatch(/^ {2}claimed: /m);
  });

  it("carries the criterion VERBATIM — the contract's own text, whole, not a label derived from it", () => {
    // The reviewer's F3, and it is a fair question to ask of any prose the assembly writes:
    // is `acText` the contract's own criterion, or the engine's summary of it? It must be the
    // former, because the whole review is "does the delivery meet THIS", and a paraphrased
    // criterion is a criterion nobody agreed to. The proof is EXACT EQUALITY against a
    // criterion long and peculiar enough that no truncation, elision or re-wrap survives it:
    // it carries an ellipsis, a backtick, an em-dash and a distinctive tail, and the test
    // asserts every one of them arrives.
    const AC = 'AC-1 — the worker emits the FULL sentence … including `code`, an em—dash, and the tail token ZZQQ-end-of-criterion';
    writeNode(
      '01-leg/01-a',
      { ...CONTRACT, acceptanceCriteria: [AC.replace(/^AC-1 — /, '')] },
      [
        ev('created'),
        ev('submitted', { gate: 'grill' }),
        ev('confirmed', { gate: 'grill' }),
        ev('evidence', { commits: [{ sha: 'abc1234', note: 'the delivery' }], claims: [{ ac: 'AC-1', check: 'npm test', statement: 'it lands' }] }),
      ],
    );
    const claims = buildReviewMaterial(commands(), '01-leg/01-a').context.find((c) => c.label === 'submission.claims')!.text;

    expect(claims).toContain(AC);
    expect(claims).toContain('ZZQQ-end-of-criterion');
  });
});

describe('AC-2 · the criterion-level evidence is CARRIED, and its BOUND is stated', () => {
  const testsOf = (id: string) => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const m = buildReviewMaterial(new Commands(new Store(repoRoot), 'test'), id);
    return { m, tests: m.context.find((c) => c.label === 'submission.tests')?.text };
  };

  it('carries real test BYTES at the anchor sha, and the selection is DERIVED', () => {
    const { m, tests } = testsOf('12-operate-loop/08-implementation-one-gate-derivation');

    // real test BYTES — not a stat line in the change map, which is all the material had
    // before and the reason every `uncertain` was a request for what this now carries
    expect(tests).toMatch(/^--- src\/.*\.test\.ts/m);
    expect(tests).toContain('describe(');
    expect(tests).toContain('it(');
    // the selection is DERIVED (the test files the range touches), so it moves with the
    // delivery rather than being a list someone maintains
    expect(m.range).toContain('..');
  });

  it('SELECTS ON THE CLAIMS TOO, and a claim-named file is carried BEFORE the range sweep', () => {
    // 12/02 is the measured case, not a constructed one: its range touches three test files
    // and its claims name two, and ONE of the named files — src/flow/__tests__/
    // semantic-driver.test.ts — the range never touches. Under the original range-only
    // selection that file was not carried at all; under a range-FIRST ordering it would have
    // been selected last and been the first thing the budget dropped, which is the same harm
    // wearing a different hat. This is the ordinary shape of "one assertion added to a suite
    // nobody rewrote", which is why the reviewer called it a gap rather than an edge.
    const { tests } = testsOf('12-operate-loop/02-implementation-semantic-driver');
    const selection = tests!.split('\n').find((l) => l.startsWith('(THE SELECTION'))!;

    // the two reads are both stated, and they are stated as DIFFERENT numbers — a selection
    // naming only one input could not show this
    expect(selection).toMatch(/test files the reviewed range changes \(\d+\)/);
    expect(selection).toMatch(/test files the claims name as evidence \(2\)/);
    // and the outside-named file ARRIVES, FIRST, captioned with the claim and the run it is
    // evidence for — AC-2's "mapped check's command" made visible where it is actually used
    const blocks = tests!.split(/^--- /m).slice(1);
    expect(blocks[0]).toMatch(/^src\/flow\/__tests__\/semantic-driver\.test\.ts {2}\[named as evidence by: AC-\d+ → npm test — "/);
    expect(blocks[0]).not.toContain('NOT readable');
    expect(blocks[0]).toContain('describe(');
    // it is NOT in the range, so no range-only selection could have carried it — asserted
    // against the material's own accounting rather than against my reading of git
    expect(selection).toMatch(/range changes \(3\)/);
  });

  it('a range that selects NOTHING still emits the section, stating the empty selection', () => {
    // AC-4 requires the material to name what falls outside the selection WHERE IT APPLIES.
    // The original code guarded the whole section on `changed.length`, so this delivery —
    // a range that touches no test file — carried NO section and NO boundary: the reviewer
    // had to DISCOVER that the evidence it wanted was never coming, which is the difference
    // between a known boundary and an unseen one.
    const { m, tests } = testsOf('02-archive-access/02-implementation-sessions-listing');
    expect(m.range).toContain('..');
    expect(tests).toBeDefined();
    expect(tests).toContain('range changes (0)');
    expect(tests).toContain('this range selects NONE, so no test text is carried at all');
    expect(tests).toContain('a real browser'); // the boundary is still named, not replaced by silence
  });

  it('DECLARES A CUT PER FILE, with the numbers — never a truncated body that reads as whole', () => {
    // The cut used to slice the JOINED bodies at the budget, so whichever file straddled it
    // arrived truncated and SILENT about it. A partial view is fine; a partial view that
    // cannot be told apart from the whole is the one thing this must not do.
    const { tests } = testsOf('12-operate-loop/08-implementation-one-gate-derivation');
    // split into per-file blocks at the captions, so "which file is this marker in" is
    // answered by the material's own structure rather than by my reading of it
    const blocks = tests!.split(/^--- /m).slice(1);
    const cut = blocks.filter((b) => b.includes('THIS FILE IS CUT'));

    // EXACTLY ONE, and it carries the numbers: how much is missing and out of how much. Not a
    // bare "…", which is the form that reads as a continuation rather than a loss.
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatch(/\[THIS FILE IS CUT: the last [\d,]+ of its [\d,]+ chars are NOT below/);
    expect(cut[0]).toContain('END OF THE FILE, not a summary');
    // and it says WHERE THE REST IS, the way the patch's own cut says "the full range is in
    // git" — a disclosure a reader can act on rather than a shrug
    expect(cut[0]).toMatch(/the full file is at [0-9a-f]{7,}:\S+\.test\.ts in git/);
    expect(cut[0]).toMatch(/^src\/.*\.test\.ts/); // the marker sits INSIDE the file's own block

    // THE POINT: the files that fit are clean, so the two are distinguishable — a property of
    // a FILE, which is exactly what slicing the joined string could not state
    const whole = blocks.filter((b) => b.includes('describe(') && !b.includes('THIS FILE IS CUT'));
    expect(whole.length).toBeGreaterThan(0);
  });

  it('names what is NOT carried — the files the budget dropped, by path', () => {
    const { tests } = testsOf('12-operate-loop/08-implementation-one-gate-derivation');
    expect(tests).toContain('(THE SELECTION —');
    expect(tests).toMatch(/NOT carried — the budget ended first — src\//);
    expect(tests).toContain('neither the range nor a claim names');
    expect(tests).toContain('a real browser');
  });
});
