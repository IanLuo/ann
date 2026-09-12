import { describe, it, expect } from 'vitest';
import { UI_HTML } from '../ui.js';

/**
 * THE SERVED PAGE'S DRILLS (leg 11 rework — the confirm rejection: "the card shows stuff,
 * but we can drill in to each item to see more information"). The e2e proves the ROUTES the
 * page issues; this runs the PAGE ITSELF against a MINIMAL DOM (hand-rolled — no jsdom, no
 * new dependency) with the reads stubbed, and asserts what the human asked for: every item
 * on the WHAT'S NEXT card opens the detail pane with that item's OWN data.
 *
 * The stub's element ids are taken FROM the script (its `byId('…')` calls), so a renamed or
 * misspelled id cannot pass silently — the page would write into a node nobody asserts on.
 */

class FakeEl {
  readonly tag: string;
  className = '';
  hidden = false;
  private own = '';
  readonly children: FakeEl[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.own = String(v);
    this.children.length = 0;
  }
  appendChild<T extends FakeEl>(child: T): T {
    this.children.push(child);
    return child;
  }
  replaceChildren(...next: FakeEl[]): void {
    this.children.length = 0;
    this.own = '';
    next.forEach((n) => this.children.push(n));
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  click(): void {
    (this.listeners.click ?? []).forEach((fn) => fn());
  }
  descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  text(): string {
    return this.descendants().map((c) => c.textContent).join(' ');
  }
  /** The first descendant button whose text contains `needle` — the drill affordance. */
  button(needle: string): FakeEl {
    const found = this.descendants().find((c) => c.tag === 'button' && c.textContent.includes(needle));
    if (!found) throw new Error(`no button containing '${needle}' — saw: ${this.text().slice(0, 700)}`);
    return found;
  }
  buttons(): FakeEl[] {
    return this.descendants().filter((c) => c.tag === 'button');
  }
}

const SCRIPT = UI_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

interface Stub {
  get(id: string): FakeEl;
  fetched: string[];
}

function boot(reads: Record<string, unknown>): Stub {
  const ids = [...SCRIPT.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
  const nodes = new Map<string, FakeEl>();
  for (const id of ids) nodes.set(id, new FakeEl('div'));
  const document = {
    getElementById: (id: string): FakeEl | null => nodes.get(id) ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
    addEventListener: (): void => {},
  };
  const fetched: string[] = [];
  const fetchStub = (path: string): Promise<{ status: number; json: () => Promise<unknown> }> => {
    // the page ENCODES ids into the query (`?id=01-leg%2F01-a`) — the stub keys on the
    // decoded path, so the assertions read like the routes do
    const decoded = path.replace(/id=([^&]*)/, (_, v: string) => `id=${decodeURIComponent(v)}`);
    fetched.push(decoded);
    const body = reads[decoded];
    return Promise.resolve({
      status: body === undefined ? 404 : 200,
      json: async () => (body === undefined ? { error: { code: 'not-found', message: path } } : body),
    });
  };
  new Function('document', 'window', 'fetch', SCRIPT)(document, { addEventListener: (): void => {} }, fetchStub);
  return {
    get: (id) => {
      const n = nodes.get(id);
      if (!n) throw new Error(`no stub element #${id} (the page never looked it up)`);
      return n;
    },
    fetched,
  };
}

/** Let the page's read promises settle (they are `fetch` hops, not timers). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

const TASK = '01-leg/01-a';
const LEG = '01-leg';
const DIRTY = 'uncommitted tracked change:  M .ann/journey/legs/01-leg/01-a/events.jsonl';

const journey = {
  ahead: { activeLeg: LEG, frontmostReady: { task: TASK, status: 'queued' }, legGate: { met: true } },
  legs: [{ id: LEG, status: 'queued', tasks: [{ id: TASK, status: 'queued' }] }],
};
const card = (over: Record<string, unknown> = {}) => ({
  advance: { leg: LEG, action: 'continue-leg', detail: `next task: ${TASK} (queued)` },
  frontmost: { leg: LEG, task: TASK, status: 'queued' },
  legGate: { met: true },
  pendingGates: [{ task: TASK, gate: 'grill' }],
  integrity: { clean: true, blockers: [] },
  executable: true,
  ...over,
});
const confirmRead = (id: string) => ({
  detail: { id, status: 'queued', contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'] }, gates: { grill: { state: 'confirmed' }, confirm: { state: 'none' } }, inputs: [], openQuestions: [], claims: [], checks: [] },
  results: [],
});
const packetRead = {
  pathDecisions: {},
  nodeContract: { intent: 'do the thing', expectedOutputs: ['the doc'] },
  dependencies: [{ name: 'core-design', status: 'resolved', path: 'docs/core-design.md', sha: 'abc1234', sourceType: 'derived-from' }],
  readiness: { ready: true, blockers: [] },
  siblingStatus: { siblings: [{ id: '01-leg/02-b', status: 'queued' }], children: [] },
  bindingState: { links: [] },
  openQuestions: [{ id: 'Q1', question: 'which shape?', impact: 'high', provenance: 'inferred' }],
};
const detailRead = {
  id: LEG,
  isLeg: true,
  status: 'queued',
  superseded: false,
  contract: { intent: 'the leg', acceptanceCriteria: ['the leg is done'] },
  gates: { grill: { state: 'none' }, confirm: { state: 'none' } },
  artifacts: [],
  events: [],
  blockers: [],
  tasks: [{ id: TASK, status: 'queued' }],
};
const nextRead = {
  advance: { leg: LEG, action: 'continue-leg', detail: `next task: ${TASK} (queued)` },
  lookBack: {
    activeLeg: LEG,
    activeLegStatus: 'queued',
    frontmostReady: { leg: LEG, task: TASK, status: 'queued' },
    alsoReady: [{ leg: LEG, task: '01-leg/02-b', status: 'queued' }],
    legGate: { met: true },
    pendingGates: [{ task: TASK, gate: 'grill' }],
  },
};

const reads = (whatsnext: unknown): Record<string, unknown> => ({
  '/api/journey': journey,
  '/api/gates': [],
  '/api/whatsnext': whatsnext,
  [`/api/confirm?id=${TASK}`]: confirmRead(TASK),
  [`/api/packet?id=${TASK}`]: packetRead,
  [`/api/detail?id=${LEG}`]: detailRead,
  '/api/next': nextRead,
});

describe('the served page — every WHAT\'S NEXT item drills into the detail pane', () => {
  it('renders the card, then drills the frontmost-ready task into its node + context packet', async () => {
    const stub = boot(reads(card()));
    await flush();
    expect(stub.get('wn-action').textContent).toBe('continue-leg');
    expect(stub.get('wn-badge').textContent).toBe('MACHINE-EXECUTABLE');
    expect(stub.get('wn-actions').hidden).toBe(false); // the approve is offered: clean + executable
    // the facts are BUTTONS (the rejection: "we can drill in to each item")
    expect(stub.get('wn-facts').buttons().length).toBe(3);
    expect(stub.get('wn-facts').button('frontmost-ready').textContent).toContain(TASK);

    stub.get('wn-facts').button('frontmost-ready').click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('frontmost-ready');
    expect(stub.get('card-title').textContent).toBe(TASK);
    expect(stub.fetched).toContain(`/api/confirm?id=${TASK}`);
    expect(stub.fetched).toContain(`/api/packet?id=${TASK}`);
    // the drill's own data: the node card AND the packet the frame will materialize
    expect(stub.get('card-node').textContent).toContain('intent: do the thing');
    expect(stub.get('card-node').textContent).toContain('Context packet');
    expect(stub.get('card-node').textContent).toContain('core-design');
    expect(stub.get('card-node').textContent).toContain('docs/core-design.md @ abc1234');
    expect(stub.get('card-node').textContent).toContain('which shape?');
    expect(stub.get('card-decide').hidden).toBe(true); // a drill is PRESENTED, never decided
  });

  it('drills the leg gate into the leg and its tasks (each of which drills further)', async () => {
    const stub = boot(reads(card()));
    await flush();
    stub.get('wn-facts').button('leg gate').click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('the leg gate');
    expect(stub.get('card-title').textContent).toBe(LEG);
    expect(stub.fetched).toContain(`/api/detail?id=${LEG}`);
    expect(stub.get('card-node').textContent).toContain('the leg is done');
    expect(stub.get('card-node').textContent).toContain('Tasks (1)');
    // …and the task inside is itself a drill
    stub.get('card-node').button(TASK).click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('frontmost-ready');
    expect(stub.fetched).toContain(`/api/packet?id=${TASK}`);
  });

  it('drills the pending gates into the DECISION surface (the same card the queue opens)', async () => {
    const stub = boot(reads(card()));
    await flush();
    stub.get('wn-facts').button('pending gates').click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('pending gates');
    expect(stub.get('card-node').textContent).toContain(TASK);
    stub.get('card-node').button('decide it').click();
    await flush();
    // the gate card: the decision UI appears ONLY for a submitted gate chosen here
    expect(stub.get('card-title').textContent).toBe(TASK);
    expect(stub.get('card-gates').textContent).toContain('grill');
  });

  it('drills the derivation itself into the look-back, and its items in turn', async () => {
    const stub = boot(reads(card()));
    await flush();
    stub.get('wn-action').click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('the derivation');
    expect(stub.get('card-title').textContent).toBe('the F5 pull proposal');
    expect(stub.fetched).toContain('/api/next');
    expect(stub.get('card-node').textContent).toContain('also ready');
    expect(stub.get('card-node').textContent).toContain('01-leg/02-b');
    expect(stub.get('card-node').button(LEG)).toBeTruthy();
  });

  it('drills an integrity blocker into its class, the read that derives it, and the node it names', async () => {
    const stub = boot(reads(card({ integrity: { clean: false, blockers: [DIRTY] }, executable: false })));
    await flush();
    expect(stub.get('wn-badge').textContent).toBe('BLOCKED — CANNOT ADVANCE');
    expect(stub.get('wn-actions').hidden).toBe(true); // no approve where it cannot work
    const row = stub.get('wn-blockers').button('blocker:');
    expect(row.textContent).toContain('uncommitted tracked journey changes — commit them'); // the operator's step
    row.click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('integrity blocker');
    expect(stub.get('card-node').textContent).toContain('a dirty tree: uncommitted tracked work');
    expect(stub.get('card-node').textContent).toContain('git status --porcelain -- .ann/journey docs');
    expect(stub.get('card-node').textContent).toContain('your step');
    // the node the blocker names is itself drillable
    stub.get('card-node').button(TASK).click();
    await flush();
    expect(stub.fetched).toContain(`/api/packet?id=${TASK}`);
  });

  it('a boundary derivation offers no approve, and its facts still drill', async () => {
    const stub = boot(
      reads(card({ advance: { leg: LEG, action: 'closure-needed', detail: 'leg gate UNMET: 0 done, 1 blocked — close via a gated closure task' }, frontmost: undefined, executable: false })),
    );
    await flush();
    expect(stub.get('wn-badge').textContent).toBe('PRESENTED AND STOPPED');
    expect(stub.get('wn-actions').hidden).toBe(true);
    expect(stub.get('wn-message').textContent).toContain('authored-work boundary');
    stub.get('wn-facts').button('frontmost-ready').click(); // 'none' → says so instead of drilling nothing
    await flush();
    expect(stub.get('wn-message').textContent).toContain('no frontmost-ready task');
    stub.get('wn-facts').button('leg gate').click();
    await flush();
    expect(stub.get('card-step-label').textContent).toContain('the leg gate');
  });
});

/**
 * THE EXIT GATE'S DRILLS (leg 11, the SECOND confirm rejection): "on the exit gate, where
 * also lot of info can drill in, like the git submit, the local file path — first check if
 * we have command tool to access those resources, then build minimum UI to show them".
 *
 * The command layer already had it (`ann results <id> [n]` — commit → `git show`, ref →
 * the file/dir at its path); this proves the served page USES it: every result item, and
 * every claim-evidence pointer that NAMES a result item, drills into the same pane.
 */
const COMMIT = 'abc1234deadbeef5678';
const exitResults = [
  { kind: 'commit', label: COMMIT, sha: COMMIT, note: '', at: '2026-09-12' },
  { kind: 'ref', label: 'src/surface/approve.ts', path: 'src/surface/approve.ts', at: '2026-09-12' },
];
const PROSE = 'the rework answering the rejection, described in prose';
const exitConfirm = {
  detail: {
    id: TASK,
    status: 'blocked',
    contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'] },
    gates: { grill: { state: 'confirmed' }, confirm: { state: 'submitted', at: '2026-09-12' } },
    inputs: [],
    openQuestions: [],
    claims: [
      { ac: 'AC-1', statement: 'the thing is done', evidence: [`${COMMIT} [resolves in git]`, 'src/surface/approve.ts [258 lines]', PROSE] },
    ],
    checks: [{ command: 'npm test', result: 'pass', detail: '663 passed', sha: COMMIT, at: '2026-09-12' }],
  },
  results: exitResults,
};
const commitDrill = {
  item: exitResults[0],
  sha: `${COMMIT}\nian luo <ianluo63@gmail.com>\n\nfeat(serve): drill into every WHAT'S NEXT item`, // the git show body
  stat: ' src/surface/ui.ts | 225 ++++++++++++++++++++++++++++++++++',
};
const refDrill = { item: exitResults[1], file: 'src/surface/approve.ts', head: ["import { join } from 'node:path';", 'export const ONCE = true;'] };

const exitReads = (gates: unknown[] = [{ task: TASK, gate: 'confirm', role: 'exit', leg: LEG, intent: 'do the thing', since: '2026-09-12', delivered: { commits: 1, claims: 1, unclaimed: 0, checks: 1, bound: 1 } }]): Record<string, unknown> => ({
  '/api/journey': {
    ahead: { activeLeg: LEG, frontmostReady: { task: TASK, status: 'blocked' }, legGate: { met: true } },
    legs: [{ id: LEG, status: 'queued', tasks: [{ id: TASK, status: 'blocked' }] }],
  },
  '/api/gates': gates,
  '/api/whatsnext': card({ frontmost: undefined, executable: false }),
  [`/api/confirm?id=${TASK}`]: exitConfirm,
  [`/api/results?id=${TASK}&n=1`]: commitDrill,
  [`/api/results?id=${TASK}&n=2`]: refDrill,
});
/** Open the EXIT gate card the way the operator does: from its WAITING ON YOU row. */
async function openExitGate(stub: Stub): Promise<void> {
  stub.get('queue').button('confirm').click();
  await flush();
}

describe('the served page — the EXIT GATE drills into every result and evidence item', () => {
  it('the exit-gate card makes every result a drill and every naming evidence pointer one too', async () => {
    const stub = boot(exitReads());
    await flush();
    await openExitGate(stub);
    expect(stub.get('card-step-label').textContent).toContain('EXIT');
    expect(stub.get('card-decide').hidden).toBe(false); // the decision card is open
    expect(stub.get('card-what').textContent).toContain('DRILLS IN');
    // the results are BUTTONS now (they used to be plain 'kind · label' rows)
    expect(stub.get('card-results').buttons().length).toBe(2);
    expect(stub.get('card-results').button(COMMIT).textContent).toContain('commit · ' + COMMIT);
    expect(stub.get('card-results').button('approve.ts').textContent).toContain('ref · src/surface/approve.ts');
    // the two evidence pointers that NAME a result item are drills; the prose one is text
    expect(stub.get('card-claims').buttons().length).toBe(2);
    expect(stub.get('card-claims').textContent).toContain('evidence: ' + PROSE);
  });

  it("drills a COMMIT result into its git show — the command layer's own drill", async () => {
    const stub = boot(exitReads());
    await flush();
    await openExitGate(stub);
    stub.get('card-results').button(COMMIT).click();
    await flush();
    expect(stub.fetched).toContain(`/api/results?id=${TASK}&n=1`); // the SAME drill the CLI addresses
    expect(stub.get('card-step-label').textContent).toContain('EXIT STEP');
    expect(stub.get('card-node').textContent).toContain('git show');
    expect(stub.get('card-node').textContent).toContain("feat(serve): drill into every WHAT'S NEXT item");
    expect(stub.get('card-node').textContent).toContain('src/surface/ui.ts | 225'); // the changeset
    expect(stub.get('card-node').textContent).toContain('ann results ' + TASK + ' 1');
    expect(stub.get('card-decide').hidden).toBe(false); // still INSIDE the exit decision
  });

  it('drills a REF result into the local file at its path', async () => {
    const stub = boot(exitReads());
    await flush();
    await openExitGate(stub);
    stub.get('card-results').button('approve.ts').click();
    await flush();
    expect(stub.fetched).toContain(`/api/results?id=${TASK}&n=2`);
    expect(stub.get('card-node').textContent).toContain('file: src/surface/approve.ts');
    expect(stub.get('card-node').textContent).toContain("import { join } from 'node:path';"); // the file's own bytes
    expect(stub.get('card-node').textContent).toContain('export const ONCE = true;');
  });

  it('drills a CLAIM evidence pointer that names a result item (and leaves prose alone)', async () => {
    const stub = boot(exitReads());
    await flush();
    await openExitGate(stub);
    stub.get('card-claims').button(COMMIT).click();
    await flush();
    expect(stub.fetched).toContain(`/api/results?id=${TASK}&n=1`); // the pointer resolves to the same item
    expect(stub.get('card-node').textContent).toContain('git show');
  });

  it('a drill from OUTSIDE the exit gate is still PRESENTED, never decided', async () => {
    const stub = boot(exitReads([])); // nothing in the queue: this node has no undecided gate
    await flush();
    stub.get('legs').button(TASK).click(); // the journey view
    await flush();
    expect(stub.get('card-decide').hidden).toBe(true);
    stub.get('card-results').button(COMMIT).click();
    await flush();
    expect(stub.fetched).toContain(`/api/results?id=${TASK}&n=1`);
    expect(stub.get('card-decide').hidden).toBe(true); // no decision UI for a node nobody picked
    expect(stub.get('card-step-label').textContent).not.toContain('EXIT STEP');
  });
});
