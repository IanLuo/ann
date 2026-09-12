import { describe, it, expect } from 'vitest';
import { UI_HTML } from '../ui.js';

/**
 * THE SERVED PAGE'S DRILLS (leg 11 rework). The confirm rejection asked to "drill in to
 * each item to see more information"; the follow-up asked for the drill to open IN A NEW
 * TAB. Both are verified HERE, by RUNNING THE SERVED PAGE SCRIPT against a MINIMAL DOM
 * (hand-rolled — no jsdom, no new dependency):
 *
 *   · every drill affordance is a LINK carrying its item in the FRAGMENT
 *     (`#drill=<kind>&id=…`), with `target=_blank` + `rel=noopener`;
 *   · the new tab is that same page booted at the link's own href — which is exactly how
 *     the test opens it, so the URL contract is what is exercised, not a private call;
 *   · a drill is PRESENTED, never decided — except a RESULT drilled from an exit gate,
 *     which keeps the decision in hand (the fragment carries the gate).
 *
 * The stub's element ids are taken FROM the script (its `byId('…')` calls), so a renamed or
 * misspelled id cannot pass silently — the page would write into a node nobody asserts on.
 */

class FakeEl {
  readonly tag: string;
  className = '';
  hidden = false;
  href = '';
  target = '';
  rel = '';
  title = '';
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
  /** The first descendant LINK whose text contains `needle` — the drill affordance. */
  link(needle: string): FakeEl {
    const found = this.descendants().find((c) => c.tag === 'a' && c.textContent.includes(needle));
    if (!found) throw new Error(`no link containing '${needle}' — saw: ${this.text().slice(0, 700)}`);
    return found;
  }
  links(): FakeEl[] {
    return this.descendants().filter((c) => c.tag === 'a');
  }
}

const SCRIPT = UI_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

interface Stub {
  get(id: string): FakeEl;
  fetched: string[];
  href: string;
  title: string;
}

/** Boot the served page — optionally AT a drill URL (that is what a new tab does). */
function boot(reads: Record<string, unknown>, hash = ''): Stub {
  const ids = [...SCRIPT.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]);
  const nodes = new Map<string, FakeEl>();
  for (const id of ids) nodes.set(id, new FakeEl('div'));
  const document: { title: string; body: FakeEl } & Record<string, unknown> = {
    title: '',
    body: new FakeEl('body'),
    getElementById: (id: string): FakeEl | null => nodes.get(id) ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
    addEventListener: (): void => {},
    hidden: false,
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
  new Function('document', 'window', 'fetch', 'location', SCRIPT)(document, { addEventListener: (): void => {} }, fetchStub, { hash });
  return {
    get: (id) => {
      const n = nodes.get(id);
      if (!n) throw new Error(`no stub element #${id} (the page never looked it up)`);
      return n;
    },
    fetched,
    href: hash,
    title: document.title,
  };
}

/** Let the page's read promises settle (they are `fetch` hops, not timers). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/** THE NEW TAB: boot the page at a drill link's own href and hand back the rendered stub —
 *  asserting on every drill that the tab is FOCUSED: the item is shown and the journey
 *  views are neither rendered nor READ. */
async function openTab(link: FakeEl, reads: Record<string, unknown>): Promise<Stub> {
  expect(link.target, 'a drill must open in a new tab').toBe('_blank');
  expect(link.rel).toBe('noopener');
  expect(link.href.startsWith('#drill='), `link href must be a drill fragment: ${link.href}`).toBe(true);
  const tab = boot(reads, link.href);
  await flush();
  expect(tab.get('wn').hidden, 'a focused tab hides the WHAT\'S NEXT card').toBe(true);
  expect(tab.get('queue-view').hidden).toBe(true);
  expect(tab.get('journey-view').hidden).toBe(true);
  expect(tab.get('state').hidden, 'a focused tab hides the journey state line').toBe(true);
  expect(tab.get('back').hidden, 'a focused tab keeps the way back').toBe(false);
  // …and it does NOT load the page it is not showing
  expect(tab.fetched.filter((f) => f === '/api/journey' || f === '/api/gates')).toEqual([]);
  return tab;
}

const TASK = '01-leg/01-a';
const LEG = '01-leg';
const DIRTY = 'uncommitted tracked change:  M .ann/journey/legs/01-leg/01-a/events.jsonl';
const SHA = 'abc1234';

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
const confirmRead = (over: Record<string, unknown> = {}) => ({
  detail: {
    id: TASK,
    status: 'queued',
    contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'] },
    gates: { grill: { state: 'confirmed' }, confirm: { state: 'none' } },
    inputs: [],
    openQuestions: [],
    claims: [],
    checks: [],
    ...over,
  },
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
/** The exit gate's own card: a submitted confirm gate with results and a claim naming one. */
const resultsRead = {
  item: { kind: 'commit', label: SHA, sha: SHA, at: '2026-09-12' },
  sha: `commit ${SHA}\n\n    the deliverable\n`,
  stat: ' docs/thing.md | 2 ++',
};
const gateCard = (over: Record<string, unknown> = {}) => ({
  detail: {
    id: TASK,
    status: 'blocked',
    contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'] },
    gates: { grill: { state: 'confirmed' }, confirm: { state: 'submitted', at: '2026-09-12' } },
    inputs: [],
    openQuestions: [],
    claims: [{ ac: 'AC-1', statement: 'the thing is done', evidence: [`${SHA} [resolved]`] }],
    checks: [{ command: 'npm test', result: 'pass', sha: SHA }],
    ...over,
  },
  results: [{ kind: 'commit', label: SHA, sha: SHA }],
});

const reads = (whatsnext: unknown): Record<string, unknown> => ({
  '/api/journey': journey,
  '/api/gates': [],
  '/api/whatsnext': whatsnext,
  [`/api/confirm?id=${TASK}`]: confirmRead(),
  [`/api/packet?id=${TASK}`]: packetRead,
  [`/api/detail?id=${LEG}`]: detailRead,
  '/api/next': nextRead,
});

describe('the served page — a drill opens its own tab, and the URL is the drill', () => {
  it('the card renders, and every fact is a NEW-TAB link carrying its item', async () => {
    const page = boot(reads(card()));
    await flush();
    // the FULL page still reads and renders the journey views
    expect(page.fetched).toEqual(['/api/journey', '/api/gates', '/api/whatsnext']);
    expect(page.get('wn').hidden).toBe(false);
    expect(page.get('queue-view').hidden).toBe(false);
    expect(page.get('journey-view').hidden).toBe(false);
    expect(page.get('back').hidden).toBe(true); // no way-back from the full page
    expect(page.get('wn-action').textContent).toBe('continue-leg');
    expect(page.get('wn-badge').textContent).toBe('MACHINE-EXECUTABLE');
    expect(page.get('wn-actions').hidden).toBe(false); // the approve is offered: clean + executable
    // the derivation head is a link to its own drill
    expect(page.get('wn-action').href).toBe('#drill=advance');
    expect(page.get('wn-action').target).toBe('_blank');
    // the facts are LINKS (the rejection: "we can drill in to each item")
    const facts = page.get('wn-facts');
    expect(facts.links().length).toBe(3);
    expect(facts.link('frontmost-ready').href).toBe('#drill=task&id=' + encodeURIComponent(TASK));
    expect(facts.link('frontmost-ready').target).toBe('_blank');
    expect(facts.link('frontmost-ready').rel).toBe('noopener');
    expect(facts.link('leg gate').href).toBe('#drill=leg&id=' + encodeURIComponent(LEG));
    expect(facts.link('pending gates').href).toBe('#drill=gates');
  });

  it('the new tab for the frontmost-ready task shows its node + the context packet', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('frontmost-ready'), reads(card()));
    expect(tab.get('card-step-label').textContent).toContain('frontmost-ready');
    expect(tab.get('card-title').textContent).toBe(TASK);
    expect(tab.fetched).toContain(`/api/confirm?id=${TASK}`);
    expect(tab.fetched).toContain(`/api/packet?id=${TASK}`);
    expect(tab.get('card-node').textContent).toContain('intent: do the thing');
    expect(tab.get('card-node').textContent).toContain('Context packet');
    expect(tab.get('card-node').textContent).toContain('docs/core-design.md @ abc1234');
    expect(tab.get('card-node').textContent).toContain('which shape?');
    expect(tab.get('card-decide').hidden).toBe(true); // a drill is PRESENTED, never decided
  });

  it('the leg tab shows the leg and its tasks, each drilling into its own tab', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('leg gate'), reads(card()));
    expect(tab.get('card-step-label').textContent).toContain('the leg gate');
    expect(tab.get('card-title').textContent).toBe(LEG);
    expect(tab.fetched).toContain(`/api/detail?id=${LEG}`);
    expect(tab.get('card-node').textContent).toContain('the leg is done');
    expect(tab.get('card-node').textContent).toContain('Tasks (1)');
    // …and the task inside is itself a new-tab drill
    const nested = tab.get('card-node').link(TASK);
    const deeper = await openTab(nested, reads(card()));
    expect(deeper.fetched).toContain(`/api/packet?id=${TASK}`);
  });

  it('the derivation tab shows the whole look-back, its items drillable in turn', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-action'), reads(card()));
    expect(tab.get('card-step-label').textContent).toContain('the derivation');
    expect(tab.get('card-title').textContent).toBe('the F5 pull proposal');
    expect(tab.fetched).toContain('/api/next');
    expect(tab.get('card-node').textContent).toContain('also ready');
    expect(tab.get('card-node').textContent).toContain('01-leg/02-b');
    expect(tab.get('card-node').link(LEG)).toBeTruthy();
  });

  it('the pending-gates tab lists them, and one gate opens the DECISION card', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('pending gates'), reads(card()));
    expect(tab.get('card-step-label').textContent).toContain('pending gates');
    expect(tab.get('card-node').textContent).toContain(TASK);
    const gateLink = tab.get('card-node').link('decide it');
    expect(gateLink.href).toBe('#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=grill');
    const gateTab = await openTab(gateLink, reads(card()));
    expect(gateTab.get('card-title').textContent).toBe(TASK);
    expect(gateTab.get('card-gates').textContent).toContain('grill');
  });

  it('a blocker tab names its class, the read that derives it, and the node it names', async () => {
    const dirty = card({ integrity: { clean: false, blockers: [DIRTY] }, executable: false });
    const page = boot(reads(dirty));
    await flush();
    expect(page.get('wn-badge').textContent).toBe('BLOCKED — CANNOT ADVANCE');
    expect(page.get('wn-actions').hidden).toBe(true); // no approve where it cannot work
    const row = page.get('wn-blockers').link('blocker:');
    expect(row.textContent).toContain('uncommitted tracked journey changes — commit them'); // the operator's step
    expect(row.href).toContain('drill=blocker');
    const tab = await openTab(row, reads(dirty));
    expect(tab.get('card-step-label').textContent).toContain('integrity blocker');
    expect(tab.get('card-node').textContent).toContain('a dirty tree: uncommitted tracked work');
    expect(tab.get('card-node').textContent).toContain('git status --porcelain -- .ann/journey docs');
    expect(tab.get('card-node').textContent).toContain('your step');
    const named = await openTab(tab.get('card-node').link(TASK), reads(dirty)); // the node the blocker names
    expect(named.fetched).toContain(`/api/packet?id=${TASK}`);
  });

  it('a RESULT drilled from the exit gate keeps the decision in hand (the fragment carries the gate)', async () => {
    const gateReads: Record<string, unknown> = {
      ...reads(card()),
      [`/api/confirm?id=${TASK}`]: gateCard(),
      [`/api/results?id=${TASK}&n=1`]: resultsRead,
    };
    // the exit gate's own card (opened from the queue / by its drill URL)
    const gateTab = boot(gateReads, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm');
    await flush();
    expect(gateTab.get('card-decide').hidden).toBe(false); // the submitted gate IS decidable
    const resultLink = gateTab.get('card-results').link('commit');
    expect(resultLink.href).toBe('#drill=result&id=' + encodeURIComponent(TASK) + '&gate=confirm&n=1');
    // …and the new tab for it shows the drill AND keeps Accept/Reject
    const tab = await openTab(resultLink, gateReads);
    expect(tab.get('card-step-label').textContent).toContain('EXIT STEP');
    expect(tab.get('card-title').textContent).toBe(`${TASK} · result 1`);
    expect(tab.fetched).toContain(`/api/results?id=${TASK}&n=1`);
    expect(tab.get('card-node').textContent).toContain('git show');
    expect(tab.get('card-decide').hidden).toBe(false); // the review survives the drill
  });

  it('a focused tab RE-READS only its item (Refresh) — never the journey it is not showing', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('frontmost-ready'), reads(card()));
    const before = tab.fetched.length;
    tab.get('refresh').click(); // the Refresh button
    await flush();
    const after = tab.fetched.slice(before);
    expect(after).toContain(`/api/packet?id=${TASK}`); // the item's own read, again
    expect(after.filter((f) => f === '/api/journey' || f === '/api/gates' || f === '/api/whatsnext')).toEqual([]);
    expect(tab.get('updated').textContent).toContain('as of ');
  });

  it('a result drill from a gate DECIDED since the link was made shows no decision it cannot take', async () => {
    const decided: Record<string, unknown> = {
      ...reads(card()),
      [`/api/confirm?id=${TASK}`]: gateCard({ gates: { grill: { state: 'confirmed' }, confirm: { state: 'confirmed', at: '2026-09-12' } } }),
      [`/api/results?id=${TASK}&n=1`]: resultsRead,
    };
    const tab = boot(decided, '#drill=result&id=' + encodeURIComponent(TASK) + '&gate=confirm&n=1');
    await flush();
    expect(tab.get('card-node').textContent).toContain('git show');
    expect(tab.get('card-decide').hidden, 'the gate is decided — no Accept/Reject that cannot land').toBe(true);
  });

  it('every hidden thing is REALLY hidden — the CSS guard the bare attribute does not give', async () => {
    // THE BUG the operator hit: `.actions { display: flex }` outweighs the UA rule for
    // [hidden], so `wn-actions.hidden = true` left the approve button visible and clickable
    // on a card that could not advance. The page therefore carries ONE guard rule, and the
    // two groups that need it are pinned here (a CSS-blind harness cannot catch this by
    // running the page — it has no layout engine).
    const style = UI_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style).toContain('[hidden] { display: none !important; }');
    // …and it is LOAD-BEARING: the approve group and the gate chips set display themselves
    expect(style).toContain('.actions { display: flex;');
    expect(style).toContain('.gates { display: flex;');
    expect(UI_HTML).toContain('class="actions" id="wn-actions" hidden'); // absent until the approve can work
    // the behaviour the guard makes true (the blocks the page hides):
    const blocked = boot(reads(card({ integrity: { clean: false, blockers: [DIRTY] }, executable: false })));
    await flush();
    expect(blocked.get('wn-actions').hidden).toBe(true);
    const tab = await openTab(blocked.get('wn-blockers').link('blocker:'), reads(card({ integrity: { clean: false, blockers: [DIRTY] }, executable: false })));
    expect(tab.get('card-gates').hidden, 'a view with no gate chips hides the .gates row').toBe(true);
  });

  it('an EXHAUSTED journey with a dirty tree says so — the boundary is the headline, not the blocker', async () => {
    // reported: with the journey done (derivation `none`) and an uncommitted journey tree,
    // the card said BLOCKED — CANNOT ADVANCE. The blocker blocks an APPROVE, and there is
    // none to offer: the move (goal! met / a subtle task / archive) is the human's.
    const exhausted = card({
      advance: { leg: '', action: 'none', detail: 'journey exhausted — verdict UNCONFIRMED: the human chooses — (1) goal! met (criteria met) · (2) a subtle task · (3) goal! archive & start a new goal' },
      frontmost: undefined,
      integrity: { clean: false, blockers: [DIRTY] },
      executable: false,
    });
    const page = boot(reads(exhausted));
    await flush();
    expect(page.get('wn-badge').textContent).toBe('PRESENTED AND STOPPED'); // NOT 'BLOCKED'
    expect(page.get('wn-detail').textContent).toContain('goal! met'); // the move, on the card
    expect(page.get('wn-blockers').textContent).toContain('commit them');
    expect(page.get('wn-blockers').textContent).toContain('none is offered here'); // it blocks an approve, not the move
    expect(page.get('wn-message').textContent).toContain('nothing to approve');
    expect(page.get('wn-actions').hidden).toBe(true);
    // …and the blocker still drills (what it is, the read that derives it, its node)
    const tab = await openTab(page.get('wn-blockers').link('blocker:'), reads(exhausted));
    expect(tab.get('card-node').textContent).toContain('git status --porcelain -- .ann/journey docs');
  });

  it('a boundary derivation offers no approve, and its frontmost-ready fact is inert text', async () => {
    const boundary = card({ advance: { leg: LEG, action: 'closure-needed', detail: 'leg gate UNMET: 0 done, 1 blocked — close via a gated closure task' }, frontmost: undefined, executable: false });
    const page = boot(reads(boundary));
    await flush();
    expect(page.get('wn-badge').textContent).toBe('PRESENTED AND STOPPED');
    expect(page.get('wn-actions').hidden).toBe(true);
    expect(page.get('wn-message').textContent).toContain('authored-work boundary');
    // 'frontmost-ready: none' is NOT a dead link — it is plain text (no anchor for it)
    const facts = page.get('wn-facts');
    expect(facts.links().some((l) => l.textContent.includes('frontmost-ready'))).toBe(false);
    expect(facts.links().length).toBe(2); // leg gate + pending gates only
    const tab = await openTab(facts.link('leg gate'), reads(boundary));
    expect(tab.get('card-step-label').textContent).toContain('the leg gate');
  });
});
