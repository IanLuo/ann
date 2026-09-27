import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type ReviewSeverity } from '../../store/store.js';
import { Commands, REJECT_BOUND, type CommandResult } from '../../commands/index.js';
import type { CaptureEnv } from '../../commands/capture.js';
import type { Abilities, InteractAbility, LlmAbility, ResearchFinding } from '../types.js';
import { shapeFindings } from '../review-session.js';
import { deriveGateVerdict, GATE_REVIEW_PROVENANCE, runGateReview } from '../gate-review.js';

/**
 * THE REVIEW WORKER (leg 12/22) — the headless reviewer that DECIDES the exit gate.
 *
 * WHY THIS FILE EXISTS LATE, and it is worth stating: the worker landed as 251 lines of
 * `gate-review.ts` with no test beside it, so for one node's worth of work the ONE actor
 * that decides every future exit gate was the only actor in the tree nothing exercised.
 * The suite stayed green because nothing reached it — which is exactly how an untested
 * decider passes for a working one. Everything below runs with NO PROVIDER: `Abilities` is
 * an L2 protocol, so a test scripts the model's reply and the whole path — material,
 * findings, landing, rule, write — runs for real.
 *
 * WHAT IS PINNED, by AC:
 *   · AC-2 — the three arms and their edges, on a rule that reads SEVERITIES ONLY, plus the
 *     central property: the model is never asked for a verdict, so a reply that PROSE-
 *     announces one changes nothing.
 *   · AC-3 — a worker's rejection is the SAME `rejected` event a human's is: same type,
 *     same gate, same derived state. No new event kind, no new state, no second writer.
 *   · AC-4 — the decision carries ENGINE-STAMPED provenance, and a worker's accept and a
 *     human's are distinguishable on the record for the same gate.
 *   · AC-5 — the bound is read BEFORE anything is spent: at REJECT_BOUND the worker does not
 *     call the model at all.
 *   · AC-6 — every absence (an unparseable reply, an empty review, a provider that throws)
 *     decides NOTHING: the submission stands and the reason is named.
 */

let root: string;
const nodeDir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const TASK = '01-leg/01-a';
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-26', type, ...extra });

function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>> = []) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-09-26' }));
  if (events.length) writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const valueOf = <T>(r: CommandResult<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.blocker}`);
  return r.value;
};

/** A sha that RESOLVES in the ann repo — the close traces the cited commit with git, so a
 *  fabricated sha would make the fixture pass for the wrong reason. */
const realSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim().slice(0, 7);

/** The capture seam is the ONE thing the engine injects (leg 12/03), so a pass is exercised
 *  without running a suite inside a test; everything else stays the engine's. */
const stubCapture = (o: { head?: string; dirty?: string[] } = {}): CaptureEnv => ({
  head: () => o.head ?? realSha(),
  dirty: () => o.dirty ?? [],
  run: () => ({ exitCode: 0, stdout: 'Tests  3 passed (3)\n', stderr: '' }),
});
const cmds = (capture: CaptureEnv = stubCapture()) => new Commands(new Store(root), 'test', capture);

const CONTRACT = { intent: 'deliver the thing', acceptanceCriteria: ['the thing lands', 'the thing is checked'] };

/**
 * A task at its CONFIRM gate whose conclusion the floor CAN close (12/22 AC-1): a captured
 * pass over a real commit, and every criterion claimed against it. This is the state the
 * worker runs in — a submission the engine would have refused is a submission the worker is
 * never spent on.
 */
function atConfirm(id = TASK): Commands {
  writeNode(id, CONTRACT, [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
  const c = cmds(); // the store SCANS at construction — the fixture is on disk first
  valueOf(c.capture(id, 'npm test'));
  valueOf(
    c.evidence(id, [{ sha: realSha() }], {
      claims: [
        { ac: 'AC-1', check: 'npm test' },
        { ac: 'AC-2', check: 'npm test' },
      ],
    }),
  );
  valueOf(c.submit(id, 'confirm'));
  return c;
}

/** A task at its confirm gate with the bound ALREADY exhausted — the escalation's door, in
 *  the state `12/23` is actually in: the bound is spent AND the gate is OPEN AGAIN, because a
 *  re-submission is what puts a spent gate back in front of the worker. (Three rejections and
 *  no re-submission would leave the gate reading `rejected`, which is the rework state and not
 *  an open decision at all.) */
function atBound(id = TASK): Commands {
  const rejected = (n: number) => Array.from({ length: n }, () => ev('rejected', { gate: 'confirm', feedback: 'not yet' }));
  writeNode(id, CONTRACT, [
    ev('created'),
    ev('submitted', { gate: 'grill' }),
    ev('confirmed', { gate: 'grill' }),
    ev('submitted', { gate: 'confirm' }),
    ...rejected(REJECT_BOUND),
    ev('submitted', { gate: 'confirm' }),
  ]);
  return cmds(); // the store SCANS at construction — the fixture is on disk first
}

/* ── the scripted actor ─────────────────────────────────────────────────────── */

/** A model that answers with a FIXED reply and keeps every prompt it was given. */
const model = (answer: string | (() => string)) => {
  const prompts: string[] = [];
  const llm: LlmAbility = {
    async complete(req) {
      prompts.push(req.prompt);
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return { llm, prompts, calls: () => prompts.length };
};

/** A human channel that REFUSES to be used. The worker decides on its own material — if it
 *  ever asks, presents or researches, the test says so instead of a human quietly covering
 *  for it. */
const noHuman = (): InteractAbility => ({
  async present() {
    throw new Error('the worker presented to a human');
  },
  async ask(): Promise<string> {
    throw new Error('the worker asked a human');
  },
  async research(): Promise<ResearchFinding[]> {
    throw new Error('the worker researched');
  },
  async decide(): Promise<string> {
    throw new Error('the worker asked a human to decide');
  },
});
const abilities = (llm: LlmAbility): Abilities => ({ llm, interact: noHuman() });

const SEV = (severity: ReviewSeverity, status: 'open' | 'resolved' = 'open', id = 'F1') => ({ id, severity, where: 'src/flow/gate-review.ts:1', text: `the ${severity} finding`, status });
const reply = (findings: unknown[], summary = 'every criterion walked against the delivered bytes; nothing is left open') =>
  JSON.stringify({ findings, summary });

/** What AC-6 promises after an absence, read from the gate's own view: the submission is
 *  STANDING and undecided — the task reads `blocked` on the gate that is the human's again,
 *  never `done` and never silently decided. */
const stillTheHumans = (c: Commands, id = TASK) => {
  expect(c.brief(id).gates.confirm).toBe('submitted'); // submitted, undecided
  expect(c.status(id)).toBe('blocked');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-gate-review-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('AC-2 · the verdict is DERIVED, never asked — and the rule is over SEVERITIES ONLY', () => {
  it('reads the three arms and their edges, with no provider and no fixture', () => {
    const v = (findings: Array<{ severity: ReviewSeverity; status: 'open' | 'resolved' }>) => deriveGateVerdict(findings);
    // NO findings is a reviewer that said nothing, and nothing is not evidence of anything —
    // an accept must be CARRIED by at least one `matches`.
    expect(v([])).toBe('human');
    // an open defect REWORKS — the existing reject → re-execute loop, not a new one
    expect(v([SEV('gap')])).toBe('rework');
    expect(v([SEV('regression')])).toBe('rework');
    // an open `quality` — defective bytes, no contract defect — goes to the human: it must
    // not auto-rework (nothing is broken) and must not auto-accept (something is wrong)
    expect(v([SEV('quality')])).toBe('human');
    expect(v([SEV('quality'), SEV('matches', 'open', 'F2')])).toBe('human');
    // `uncertain` DOES NOT BLOCK (changed 2026-09-27) — it is a question with no file:line,
    // so nothing the author can fix and nothing the next pass can settle. But it cannot
    // CARRY an accept either: a review that settled nothing establishes nothing, which is
    // the same invariant as the empty list above.
    expect(v([SEV('uncertain')])).toBe('human'); // nothing settled — the guard, not the arm
    expect(v([SEV('uncertain'), SEV('uncertain', 'open', 'F2')])).toBe('human');
    expect(v([SEV('uncertain'), SEV('matches', 'open', 'F2')])).toBe('accept');
    // the ONE automatic outcome
    expect(v([SEV('matches')])).toBe('accept');
    // a RESOLVED finding is out of the way at any severity — this is what lets a rework's
    // second review accept the bytes that settled it
    expect(v([SEV('gap', 'resolved')])).toBe('accept');
    expect(v([SEV('gap', 'resolved'), SEV('matches', 'open', 'F2')])).toBe('accept');
    // a defect still open WINS over a question the worker could not settle
    expect(v([SEV('uncertain', 'open', 'F2'), SEV('gap')])).toBe('rework');
  });

  it('is asked ONCE, over the assembly the card reads — criteria, checks and range all present', async () => {
    const c = atConfirm();
    const m = model(reply([SEV('matches')]));
    const r = await runGateReview(c, abilities(m.llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'accept', findings: 1 });
    expect(m.calls()).toBe(1); // ONE pass: no second round, nobody to ask
    const prompt = m.prompts[0];
    expect(prompt).toContain('deliver the thing'); // the intent
    expect(prompt).toContain('AC-1: the thing lands'); // the criteria, as constraints
    expect(prompt).toContain('npm test: pass — CAPTURED FACT'); // the checks, at their sha
    expect(prompt).toContain('STRICT JSON'); // the reply contract the parse below enforces
  });

  it('an ACCEPT FIRES OVER AN OPEN QUESTION — recorded in the why, never silently', async () => {
    const c = atConfirm();
    const m = model(reply([SEV('matches', 'open', 'F1'), SEV('uncertain', 'open', 'F2')]));
    const r = await runGateReview(c, abilities(m.llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'accept', findings: 2 });
    // THE TASK IS CLOSED — the whole point of the change: a reviewer that walked every
    // criterion and settled them does not hand the gate to a human over a question that
    // has no file:line and therefore no fix.
    expect(c.status(TASK)).toBe('done');
    expect(c.rejections(TASK, 'confirm')).toBe(0); // a question burns no rejection
    // …AND THE QUESTION IS ON THE RECORD TWICE, because a human reads the why and a machine
    // reads the findings: neither can be the only place it lives
    expect(String((r as { why: string }).why)).toContain('CARRIED WITH 1 OPEN QUESTION(S)');
    expect(String((r as { why: string }).why)).toContain('F2 [uncertain]');
    expect(c.reviewFindings(TASK).findings.map((f) => f.severity)).toContain('uncertain');
  });

  it('a reply that PROSE-ANNOUNCES a verdict decides nothing — prose is not a severity', async () => {
    const c = atConfirm();
    const m = model('ACCEPT — I reviewed the delivery and everything looks good to me.');
    const r = await runGateReview(c, abilities(m.llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: false });
    // nothing decided: the gate still holds the human's own submission, undecided
    expect(c.status(TASK)).not.toBe('done');
    expect(c.store.events(TASK).some((e) => e.type === 'confirmed' && e.gate === 'confirm')).toBe(false);
    expect(c.store.events(TASK).some((e) => e.type === 'rejected')).toBe(false);
  });
});

describe('AC-3 · re-execution is the EXISTING loop — same event, same state, no second writer', () => {
  it('a worker rejection writes what a human rejection writes', async () => {
    const HUMAN = '01-leg/01-a';
    const WORKER = '01-leg/02-b';
    const human = atConfirm(HUMAN);
    const worker = atConfirm(WORKER);
    valueOf(human.gate(HUMAN, 'confirm', 'reject', 'the second criterion is unmet'));

    const m = model(reply([SEV('gap', 'open', 'F1')]));
    const r = await runGateReview(worker, abilities(m.llm), WORKER, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'rework' });

    // THE SAME EVENT TYPE — the check is a comparison, not a constant, so a future worker
    // that invents `review-rejected` fails here rather than quietly forking the record.
    const kinds = (c: Commands, id: string) => c.store.events(id).filter((e) => e.type === 'rejected').map((e) => ({ type: e.type, gate: e.gate }));
    expect(kinds(worker, WORKER)).toEqual(kinds(human, HUMAN));
    // THE SAME DERIVED STATE behind it: the frame's re-execute rung reads this, not a
    // worker-specific one.
    expect(worker.status(WORKER)).toBe(human.status(HUMAN));
    // and the rejection carries the defect as feedback — what a rework is checked against
    const rej = worker.store.events(WORKER).find((e) => e.type === 'rejected');
    expect(String(rej?.feedback)).toContain('the gap finding');
    // THE LANDING NOTE NAMES THE WORKER (found by running it, not by reading it): it read
    // "review session (model) worker" — the interactive SESSION's constant with the word
    // appended — so the record's own prose attributed the worker's findings to the actor
    // this module exists to be separate FROM.
    const landing = worker.store.events(WORKER).find((e) => e.type === 'evidence' && Array.isArray(e.findings));
    expect(String(landing?.note)).toContain(GATE_REVIEW_PROVENANCE);
    expect(String(landing?.note)).not.toContain('review session');
  });
});

describe('AC-4 · the record says WHO decided', () => {
  it('stamps a worker accept with decider=worker AND the run, and a human accept with human', async () => {
    const HUMAN = '01-leg/01-a';
    const WORKER = '01-leg/02-b';
    const human = atConfirm(HUMAN);
    const worker = atConfirm(WORKER);
    valueOf(human.gate(HUMAN, 'confirm', 'accept', 'I read it myself and it holds'));

    const m = model(reply([SEV('matches')]));
    const r = await runGateReview(worker, abilities(m.llm), WORKER, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'accept' });

    const decided = (c: Commands, id: string) => c.store.events(id).find((e) => e.type === 'confirmed' && e.gate === 'confirm');
    // distinguishable on the SAME gate, in both directions — the machine-accepted share of
    // a journey is countable from the record rather than guessed from the prose
    expect(decided(worker, WORKER)?.decider).toBe('worker');
    expect(decided(worker, WORKER)?.run).toBe('run-7'); // a machine decision is never anonymous
    expect(decided(human, HUMAN)?.decider).toBe('human');
    expect(decided(human, HUMAN)?.run).toBeUndefined();
    // and the accept CLOSED the task — the automatic exit gate, end to end: the record was
    // closeable, so nobody had to be asked
    expect(worker.status(WORKER)).toBe('done');
  });
});

describe('AC-5 · the bound is read BEFORE anything is spent', () => {
  it('at REJECT_BOUND the worker does not run at all, and the reason names the gestures', async () => {
    const c = atBound();
    expect(c.rejections(TASK, 'confirm')).toBe(REJECT_BOUND); // the fixture is the state it claims
    const m = model(reply([SEV('matches')]));
    const r = await runGateReview(c, abilities(m.llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'human' });
    expect(m.calls()).toBe(0); // the bound must not COST a model call to discover
    expect(String((r as { reason: string }).reason)).toContain('--force');
  });

  it('AC-3 (12/27) — the bound writes NOTHING, and the STANDING names it off the rejection events', async () => {
    const c = atBound();
    const before = JSON.stringify(c.events(TASK));
    await runGateReview(c, abilities(model(reply([SEV('matches')])).llm), TASK, { run: 'run-7' });
    // no outcome event, no evidence event, no decision: the bound is a property of the GATE,
    // and recording it would put a review's outcome in the log for a review that never ran.
    expect(JSON.stringify(c.events(TASK))).toBe(before);
    expect(c.reviewFindings(TASK).outcome).toBeUndefined();
    // …and the fact is still READABLE, derived where every other outcome is stated, at NO cost
    const standing = c.brief(TASK).review!;
    expect(standing.kind).toBe('bound');
    expect(standing.line).toContain('AT THE BOUND');
    expect(standing.line).toContain(`${REJECT_BOUND} of ${REJECT_BOUND} rejections`);
  });
});

describe('AC-1/AC-2/AC-5 (12/27) · every arm is on the record, and the DECIDING ones are not restated', () => {
  it('AC-1 — the DECLINING arm rides its own review: findings + outcome on ONE event, gate untouched', async () => {
    const c = atConfirm();
    const decisionsBefore = c.brief(TASK).decisions;
    const r = await runGateReview(c, abilities(model(reply([SEV('quality')])).llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'human', findings: 1 });
    // the landing, typed as the RECORD it is: the store's event view carries `outcome` as free
    // JSON, and this is the test that reads the writer's shape back out of the log
    type Landing = { type: string; findings: unknown[]; anchorSha?: string; outcome: { verdict: string; reason: string; count: number; run?: string } };
    const landed = c.events(TASK).at(-1)! as unknown as Landing;
    expect(landed.type).toBe('evidence');
    expect(landed.findings).toHaveLength(1); // ONE review, ONE record — never findings without their verdict
    expect(landed.anchorSha).toBeTruthy(); // the commit the citations were read at (AC-1)
    expect(landed.outcome).toMatchObject({ verdict: 'human', count: 1, run: 'run-7' });
    expect(c.rejections(TASK, 'confirm')).toBe(0); // no rejection burned
    expect(c.brief(TASK).decisions).toEqual(decisionsBefore); // no decision event written
    stillTheHumans(c);
    // AC-5 — the recorded outcome IS what the rule returned for the findings it recorded
    expect(landed.outcome.verdict).toBe(deriveGateVerdict(c.reviewFindings(TASK).findings));
    // …and the card's ONE read of it says REVIEWED AND LEFT, with the arm's own reason
    const standing = c.brief(TASK).review!;
    expect(standing.kind).toBe('human');
    expect(standing.line).toContain('REVIEWED AND LEFT');
    expect(standing.line).toContain(String(landed.outcome.reason));
    expect(standing).toMatchObject({ findings: 1, run: 'run-7' });
  });

  /** An arm's effect on ONE fresh fixture — the store SCANS at construction, so each arm needs
   *  its own root (the shared `beforeEach` gives every `it` exactly one). */
  const decidingArm = async (severity: ReviewSeverity, verdict: 'accept' | 'rework') => {
    const c = atConfirm();
    const r = await runGateReview(c, abilities(model(reply([SEV(severity)])).llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict });
    // the decision IS the record; a second statement beside it is the drift the writer refuses
    expect(c.events(TASK).filter((e) => e.outcome !== undefined)).toEqual([]);
    expect(c.events(TASK).filter((e) => e.type === (verdict === 'accept' ? 'confirmed' : 'rejected') && e.gate === 'confirm')).toHaveLength(1);
    // a decided gate has no standing to state — the decision is in hand, not the worker's opinion
    expect(c.brief(TASK).review).toBeUndefined();
  };

  it('AC-5 — the DECIDING arm that ACCEPTS restates nothing (the `confirmed` event is the record)', async () => {
    await decidingArm('matches', 'accept');
  });

  it('AC-5 — the DECIDING arm that REWORKS restates nothing (the `rejected` event is the record)', async () => {
    await decidingArm('gap', 'rework');
  });

  /** An absence's effect on ONE fresh fixture, asserted the same way for every cause. */
  const absenceCase = async (llm: LlmAbility, why: string) => {
    const c = atConfirm();
    const r = await runGateReview(c, abilities(llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: false });
    const outcome = c.reviewFindings(TASK).outcome!;
    expect(outcome).toMatchObject({ verdict: 'absent', why, count: 0, run: 'run-7' });
    // the reason is the arm's own words, and it is the SAME string the operator is shown
    expect(String((r as { absent: string }).absent)).toContain(outcome.reason);
    // ONCE: one landing, no findings (there were none to find), and no separate outcome event
    expect(c.events(TASK).filter((e) => e.outcome !== undefined)).toHaveLength(1);
    expect(c.events(TASK).filter((e) => e.outcome !== undefined).every((e) => e.findings === undefined)).toBe(true);
    stillTheHumans(c); // the submission stands, nothing is decided
    // …and the card says it rather than the one sentence that means four things
    expect(c.brief(TASK).review).toMatchObject({ kind: 'absent', why });
    expect(c.brief(TASK).review!.line).toContain('ABSENT');
  };

  it('AC-2 — an UNREACHABLE provider names itself on the node', async () => {
    await absenceCase({ async complete() { throw new Error('provider-unavailable: provider x failed after 3 retries: fetch failed'); } }, 'unavailable');
  });

  it('AC-2 — an UNPARSEABLE reply names itself on the node', async () => {
    await absenceCase(model('I looked at it and it is fine.').llm, 'unparseable');
  });

  it('AC-2 — an EMPTY review names itself on the node', async () => {
    await absenceCase(model(JSON.stringify({ findings: [] })).llm, 'empty');
  });
});

describe('AC-6 · absence degrades to the human, visibly', () => {
  it('an unparseable reply is an ABSENCE, never an accept and never a rejection', async () => {
    const c = atConfirm();
    const r = await runGateReview(c, abilities(model('I looked at it and it is fine.').llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { absent: string }).absent)).toContain('strict JSON');
    stillTheHumans(c);
  });

  it('an EMPTY review is not a record — no findings lands nothing and decides nothing', async () => {
    const c = atConfirm();
    const r = await runGateReview(c, abilities(model(JSON.stringify({ findings: [] })).llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { absent: string }).absent)).toContain('NO findings');
    expect(c.reviewFindings(TASK).findings).toEqual([]);
    stillTheHumans(c);
  });

  it('a provider that throws is an ABSENCE with the reason NAMED, and the submission stands', async () => {
    const c = atConfirm();
    const llm: LlmAbility = {
      async complete() {
        throw new Error('provider-unavailable: provider openai-compatible failed after 3 retries: fetch failed');
      },
    };
    const r = await runGateReview(c, abilities(llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: false });
    expect(String((r as { absent: string }).absent)).toContain('fetch failed'); // the CAUSE, not a generic failure
    stillTheHumans(c);
  });

  it('a review that SETTLED NOTHING hands the gate back to the human — and burns no rejection', async () => {
    const c = atConfirm();
    const findings = shapeFindings([SEV('uncertain')], 'gate review worker (model)');
    const r = await runGateReview(c, abilities(model(reply([SEV('uncertain')])).llm), TASK, { run: 'run-7' });
    expect(r).toMatchObject({ ok: true, verdict: 'human', findings: 1 });
    // the finding is ON THE RECORD (a worker that decides and one that crashes leave the
    // same record of what it found) …
    expect(c.reviewFindings(TASK).findings.map((f) => f.id)).toEqual(findings.map((f) => f.id));
    // … and the rejection count is UNTOUCHED: a question the worker could not settle must
    // neither rubber-stamp the delivery nor walk it toward the bound
    expect(c.rejections(TASK, 'confirm')).toBe(0);
    stillTheHumans(c);
  });
});
