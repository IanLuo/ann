import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalFixture, FlowFixture } from './types.js';

/**
 * S9 — THE FIXTURE SUITE (requirements-spec v3 §5: "measured continuously from the
 * first fixture"; ann-system-design-v3 §21: "Fixture suite: ≤ 50 fixtures; full eval
 * run < 10 min"). Deterministic journey stores with GROUND TRUTH — the K1–K4
 * expectations are hardcoded here, never derived from the same code under test (that
 * would be measuring the meter with the meter).
 */

/** Write one journey node: node.json + events.jsonl under root/.ann/journey/legs. */
export function writeNode(root: string, id: string, contract: unknown, events: Array<Record<string, unknown>>): void {
  const dir = join(root, '.ann', 'journey', 'legs', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
  if (events.length) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

/** A leg + its tasks, from a compact spec — the common fixture shape. */
export function writeJourney(root: string, legs: Array<{ id: string; contract?: Record<string, unknown>; tasks?: Array<{ id: string; events: Array<Record<string, unknown>> }> }>): void {
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  for (const leg of legs) {
    writeNode(root, leg.id, { intent: 'leg', acceptanceCriteria: ['done'] }, [ev('created')]);
    for (const t of leg.tasks ?? []) {
      writeNode(root, `${leg.id}/${t.id}`, { intent: 'task', acceptanceCriteria: ['done'] }, t.events);
    }
  }
}

const TASK_CONTRACT = { intent: 'do the thing', acceptanceCriteria: ['it is done'] };

/* ══ K1–K4 navigation fixtures ══════════════════════════════════════════════ */

export const NAV_FIXTURES: EvalFixture[] = [
  {
    id: 'nav-frontmost',
    name: 'frontmost-ready — a queued task is the correct next action',
    build: (root) =>
      writeJourney(root, [
        {
          id: '01-leg',
          tasks: [
            { id: '01-a', events: [ev('created'), ev('completed')] },
            { id: '02-b', events: [ev('created'), ev('activated'), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' }), ev('completed')] },
            { id: '03-c', events: [ev('created')] },
          ],
        },
      ]),
    expectedStatuses: {
      '01-leg/01-a': 'done',
      '01-leg/02-b': 'done',
      '01-leg/03-c': 'queued',
      '01-leg': 'queued',
    },
    locateTarget: '01-leg/03-c',
    expectedNext: '01-leg/03-c',
  },
  {
    id: 'nav-blocked-gate',
    name: 'a submitted-undecided gate blocks the task — the next action is the blocked wait',
    build: (root) =>
      writeJourney(root, [
        {
          id: '01-leg',
          tasks: [
            { id: '01-a', events: [ev('created'), ev('submitted', { gate: 'confirm' })] },
            { id: '02-b', events: [ev('created')] },
          ],
        },
      ]),
    expectedStatuses: {
      '01-leg/01-a': 'blocked',
      '01-leg/02-b': 'queued',
      '01-leg': 'blocked',
    },
    locateTarget: '01-leg/01-a',
    expectedNext: '01-leg/02-b',
  },
  {
    id: 'nav-leg-gate',
    name: 'all tasks done → the leg gate is MET; advance is the next action',
    build: (root) =>
      writeJourney(root, [
        {
          id: '01-leg',
          tasks: [
            { id: '01-a', events: [ev('created'), ev('completed')] },
            { id: '02-b', events: [ev('created'), ev('completed')] },
          ],
        },
      ]),
    expectedStatuses: { '01-leg/01-a': 'done', '01-leg/02-b': 'done', '01-leg': 'done' },
    locateTarget: '01-leg/02-b',
    expectedNext: '',
  },
  {
    id: 'nav-mixed-superseded',
    name: 'done + superseded tasks derive the leg done',
    build: (root) =>
      writeJourney(root, [
        {
          id: '01-leg',
          tasks: [
            { id: '01-a', events: [ev('created'), ev('completed')] },
            { id: '02-b', events: [ev('created'), ev('superseded', { successor: { name: 'x', path: 'p' } })] },
          ],
        },
      ]),
    expectedStatuses: { '01-leg/01-a': 'done', '01-leg/02-b': 'superseded', '01-leg': 'done' },
    locateTarget: '01-leg/02-b',
    expectedNext: '',
  },
];

/* ══ K5 flow fixtures ══════════════════════════════════════════════════════ */

/** A spec step: STAGES a doc to docs/<name>.md — the first-pass completion shape
 *  (docs-as-git: the deliverable is a staged doc; the operator's commit evidence
 *  concludes it — no artifact lock, no artifacts/ file). */
export const specStep = (id = 'spec', docName = 'spec'): FlowFixture['steps'][number] => ({
  id,
  execute: async () => ({
    ok: true,
    artifact: `${id} artifact`,
    intents: [{ kind: 'stage-doc', name: docName, content: `# ${docName}\n\nproduced by ${id}\n` }],
  }),
});

/** A multi-doc step: STAGES `docs/<docName>.md` — a second first-pass shape. */
export const lockStep = (id: string, docName: string): FlowFixture['steps'][number] => ({
  id,
  execute: async () => ({
    ok: true,
    artifact: `${id} artifact`,
    intents: [{ kind: 'stage-doc', name: docName, content: `# ${docName}\n\nproduced by ${id}\n` }],
  }),
});

export const FLOW_FIXTURES: FlowFixture[] = [
  {
    id: 'flow-spec',
    name: 'a spec chain first-passes — ACs met, doc staged + operator-committed (no rework)',
    chain: ['spec'],
    steps: [specStep('spec', 'spec-result')],
    interactAnswers: ['accept', 'accept'],
    expectedFirstPass: true,
  },
  {
    id: 'flow-multi',
    name: 'a two-step chain first-passes — both docs staged + operator-committed',
    chain: ['step-a', 'step-b'],
    steps: [lockStep('step-a', 'artifact-a'), lockStep('step-b', 'artifact-b')],
    interactAnswers: ['accept', 'accept'],
    expectedFirstPass: true,
  },
  {
    id: 'flow-rework',
    name: 'a grill rejection reworks — NOT a first pass (the rework is honest)',
    chain: ['spec'],
    steps: [specStep('spec', 'spec-result')],
    interactAnswers: ['reject', 'the spec is wrong', 'accept', 'accept'],
    expectedFirstPass: false,
  },
  {
    id: 'flow-empty-chain',
    name: 'the empty chain — the RUNNER does the work; the frame WAITS (never a fake pass)',
    chain: [],
    steps: [],
    interactAnswers: [],
    expectedFirstPass: false, // the empty chain never first-passes in the frame — the runner commits
  },
];
