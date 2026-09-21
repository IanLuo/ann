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

/** Boot the served page — optionally AT a drill URL (that is what a new tab does), and
 *  optionally with a path whose reply NEVER arrives (the lazy integrity snapshot in flight —
 *  the pending state cannot be observed any other way). */
function boot(reads: Record<string, unknown>, hash = '', pending: string[] = []): Stub {
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
    if (pending.includes(decoded)) return new Promise<never>(() => {}); // in flight, forever
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
  legs: [
    {
      id: LEG,
      status: 'queued',
      tasks: [{ id: TASK, status: 'queued', readiness: { ready: true, blockers: [] } }],
    },
  ],
};
const card = (over: Record<string, unknown> = {}) => ({
  advance: { leg: LEG, action: 'continue-leg', detail: `next task: ${TASK} (queued)` },
  frontmost: { leg: LEG, task: TASK, status: 'queued' },
  legGate: { met: true },
  pendingGates: [{ task: TASK, gate: 'grill' }],
  // the READ's own half (leg 12/07): NO verdict — the pre-check is the write's guard, and
  // the page fetches it lazily from /api/integrity (see `reads`)
  integrity: { state: 'unchecked', note: 'not read by the page load — GET /api/integrity answers it' },
  chainSteps: 3, // the frontmost-ready task's RESOLVED chain has content steps (the machine executes it)
  executable: true,
  ...over,
});
/** The LAZY integrity snapshot — the SAME pre-check the approve refuses on. */
const integrity = (over: Record<string, unknown> = {}) => ({ clean: true, blockers: [], ...over });
const confirmRead = (over: Record<string, unknown> = {}) => ({
  detail: {
    id: TASK,
    status: 'queued',
    contract: { intent: 'do the thing', acceptanceCriteria: ['the thing is done'] },
    gates: { grill: { state: 'accepted' }, confirm: { state: 'none' } },
    rework: false,
    next: { verdict: 'entry-accepted' },
    inputs: [],
    openQuestions: [],
    claims: [],
    checks: [],
    brief: { decisions: [], conclusion: { claims: [], unclaimed: [], checks: [] } },
    ...over,
  },
  results: [],
});const packetRead = {
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
  tasks: [{ id: TASK, status: 'queued', readiness: { ready: true, blockers: [] } }],
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
    gates: { grill: { state: 'accepted' }, confirm: { state: 'submitted', at: '2026-09-12' } },
    rework: false,
    next: { verdict: 'waiting-on-decision', gate: 'confirm' },
    inputs: [],
    openQuestions: [],
    brief: {
      decisions: [{ at: '2026-09-19', type: 'rejected', gate: 'confirm', note: 'rejected (ianluo)', why: 'the AC is not met yet' }],
      conclusion: { claims: [{ ac: 'AC-1', statement: 'x', evidence: [] }], unclaimed: [], checks: [] },
    },
    claims: [{ ac: 'AC-1', statement: 'the thing is done', evidence: [`${SHA} [resolved]`] }],
    checks: [{ command: 'npm test', result: 'pass', sha: SHA }],
    ...over,
  },
  results: [{ kind: 'commit', label: SHA, sha: SHA }],
});

/** The node's EVENT LIST + one event DRILLED — the service's `GET /api/events` (the read
 *  leg 10/04 exposed, whose body is the CLI's `ann events <id> [n]` value). */
const eventsRead = {
  id: TASK,
  kind: 'TASK',
  events: [
    { n: 1, at: '2026-09-12', type: 'created', note: 'spawned by bookkeeper (agent)' },
    { n: 2, at: '2026-09-12', type: 'submitted', gate: 'grill', note: 'submitted for the grill gate (agent)' },
    { n: 3, at: '2026-09-12', type: 'evidence', note: `captured 'npm test' → pass (exit 0) against ${SHA}` },
  ],
};
/** A LEG root: no events of its own by design (v8 §3) — the pane must say so. */
const legEventsRead = { id: LEG, kind: 'LEG', events: [] };
const eventDrillRead = {
  id: TASK,
  kind: 'TASK',
  n: 1,
  total: 3,
  event: { at: '2026-09-12', type: 'created', note: 'spawned by bookkeeper (agent)' },
  links: [
    { kind: 'node', what: TASK, detail: 'the whole node: contract · inputs · gates · the full event walk', command: `ann journey ${TASK}` },
    { kind: 'commit', what: SHA, detail: 'resolves in git — the deliverable', command: `ann results ${TASK} 1` },
  ],
};

const reads = (whatsnext: unknown, integ: unknown = integrity()): Record<string, unknown> => ({
  '/api/journey': journey,
  '/api/gates': [],
  '/api/whatsnext': whatsnext,
  '/api/integrity': integ,
  [`/api/confirm?id=${TASK}`]: confirmRead(),
  [`/api/packet?id=${TASK}`]: packetRead,
  [`/api/detail?id=${LEG}`]: detailRead,
  [`/api/events?id=${TASK}`]: eventsRead,
  [`/api/events?id=${LEG}`]: legEventsRead,
  [`/api/events?id=${TASK}&n=1`]: eventDrillRead,
  '/api/next': nextRead,
});

describe('the served page — a submitted gate is never an unlock claim (leg 12/19)', () => {
  /** A task whose grill is SUBMITTED and whose declared dependency is still open: the
   *  human owes a decision, and the ENGINE refuses the run. The card must say both. */
  const submittedGrill = (over: Record<string, unknown> = {}) =>
    gateCard({
      status: 'blocked',
      gates: { grill: { state: 'submitted', at: '2026-09-21' }, confirm: { state: 'none' } },
      next: { verdict: 'waiting-on-decision', gate: 'grill' },
      readiness: { ready: false, blockers: ['dependency open: 01-leg/02-b (queued)'] },
      ...over,
    });
  const bootGrill = async (over: Record<string, unknown> = {}) => {
    const tab = boot({ ...reads(card()), [`/api/confirm?id=${TASK}`]: submittedGrill(over) }, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=grill');
    await flush();
    return tab;
  };

  it('AC-1/AC-2 — the card names the WAIT in the derivation’s own words and prints NO unlock claim', async () => {
    const tab = await bootGrill();
    const next = tab.get('card-next').textContent;
    const what = tab.get('card-what').textContent;
    // the wait, by id and status — 12/17's wording, not a second phrasing of the same fact
    expect(next).toContain('waiting on dependency open: 01-leg/02-b (queued)');
    // …and the engine's answer is never asserted from the human's fact
    for (const line of [next, what]) {
      expect(line).not.toContain('lets the work start');
      expect(line).not.toContain('lets it land');
    }
  });

  it('AC-3 — the decision stays the human’s, and the card says exactly what an accept does', async () => {
    const tab = await bootGrill();
    expect(tab.get('card-decide').hidden, 'Accept/Reject stay available while the run is refused').toBe(false);
    const next = tab.get('card-next').textContent;
    // an accept settles the CONTRACT and does not start the work — never pointless, never a run
    expect(next).toContain('settles the contract');
    expect(next).toContain('does not start the work');
    expect(tab.get('card-what').textContent).toContain('does not start the work');
  });

  it('AC-4 — the READY cases keep their wording: the entry accept starts the work', async () => {
    const tab = await bootGrill({ readiness: { ready: true, blockers: [] } });
    expect(tab.get('card-next').textContent).toContain('accepting grill lets the work start');
    expect(tab.get('card-what').textContent).toContain('approving it lets the work start');
    expect(tab.get('card-next').textContent).not.toContain('waiting on');
  });

  it('AC-4 — the READY exit gate is untouched: an accept lands it, and readiness is not its question', async () => {
    const tab = boot({ ...reads(card()), [`/api/confirm?id=${TASK}`]: gateCard() }, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm');
    await flush();
    expect(tab.get('card-next').textContent).toContain('accepting confirm lets it land');
    // the exit gate's `what` is about the CLOSE in both states — readiness never rewrites it
    expect(tab.get('card-what').textContent).toContain('approving it closes the task when the conclusion evidence is recorded');
  });

  it('AC-4 — an EXIT gate whose run is refused still makes no run claim', async () => {
    const tab = boot(
      {
        ...reads(card()),
        [`/api/confirm?id=${TASK}`]: gateCard({ readiness: { ready: false, blockers: ['dependency open: 01-leg/02-b (queued)'] } }),
      },
      '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm',
    );
    await flush();
    const next = tab.get('card-next').textContent;
    expect(next).not.toContain('lets it land');
    expect(next).toContain('waiting on dependency open: 01-leg/02-b (queued)');
    expect(tab.get('card-decide').hidden).toBe(false); // the decision is still yours to make
  });
});

describe('the served page — a drill opens its own tab, and the URL is the drill', () => {
  it('the card shows the DEPENDENCY EDGES — inputs resolved, and task edges labelled as read from the record (leg 12/14)', async () => {
    const gateTab = boot(
      {
        ...reads(card()),
        [`/api/confirm?id=${TASK}`]: gateCard({
          deps: {
            dependsOn: [
              { kind: 'input', ref: 'journey-format-spec', detail: 'docs/journey-format-spec.md @ dca1018', status: 'resolved', how: 'requiredInputs' },
              { kind: 'task', ref: '01-leg/02-b', detail: 'blocked', status: 'resolved', how: 'named-in-record' },
              { kind: 'task', ref: '01-leg/09-gone', detail: 'not a node', status: 'absent', how: 'affectedTaskIds' },
            ],
            referencedBy: [{ id: '01-leg/03-c', status: 'queued', how: 'named-in-record' }],
          },
        }),
      },
      '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm',
    );
    await flush();
    const text = gateTab.get('card-node').textContent;
    expect(text).toContain('depends on');
    expect(text).toContain('journey-format-spec → docs/journey-format-spec.md @ dca1018');
    // a TASK edge says it was read from the record — never dressed as a declared guarantee
    expect(text).toContain('01-leg/02-b → blocked');
    expect(text).toContain('read from the record');
    expect(text).toContain('01-leg/09-gone → not a node'); // a named target that is gone stays VISIBLE
    expect(text).toContain('referenced by');
    expect(text).toContain('01-leg/03-c (queued)');
  });

  it('the card carries the DECISION MATERIAL — decisions with their whys, the close readiness, and a CAPPED note row (leg 12/15 AC-4)', async () => {
    const gateTab = boot(
      {
        ...reads(card()),
        [`/api/confirm?id=${TASK}`]: gateCard(),
        [`/api/events?id=${TASK}`]: {
          ...eventsRead,
          events: [
            ...eventsRead.events,
            { n: 9, at: '2026-09-19', type: 'extended', note: 'N'.repeat(900) },
          ],
        },
      },
      '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm',
    );
    await flush();
    const node = gateTab.get('card-node').textContent;
    // the choice already made, WITH its why (the same value `ann brief` prints)
    expect(node).toContain('decision');
    expect(node).toContain('rejected@confirm');
    expect(node).toContain('why: the AC is not met yet');
    // and whether a close would pass right now
    expect(node).toContain('close');
    expect(node).toContain('auto-close');
    // a 900-char note is CUT on the card, with the cut NAMED and the drill intact
    await flush();
    const events = gateTab.get('card-events').textContent;
    expect(events).toContain('… (+660 chars');
    expect(events).not.toContain('N'.repeat(400));
  });

  it('the card renders, and every fact is a NEW-TAB link carrying its item', async () => {
    const page = boot(reads(card()));
    await flush();
    // the FULL page still reads and renders the journey views — plus the LAZY integrity
    // snapshot, fetched AFTER the render so a load never blocks on the ~3.3s pre-check
    expect(page.fetched).toEqual(['/api/journey', '/api/gates', '/api/whatsnext', '/api/integrity']);
    expect(page.get('wn').hidden).toBe(false);
    expect(page.get('queue-view').hidden).toBe(false);
    expect(page.get('journey-view').hidden).toBe(false);
    expect(page.get('back').hidden).toBe(true); // no way-back from the full page
    expect(page.get('wn-action').textContent).toBe('continue-leg');
    expect(page.get('wn-badge').textContent).toBe('MACHINE-EXECUTABLE');
    expect(page.get('wn-actions').hidden).toBe(false); // the approve is offered: clean + executable
    // …and the derivation's own words still promise the run: the chain HAS content steps
    expect(page.get('wn-facts').text()).toContain('the machine can run this step through the frame');
    // the integrity fact is the LAZY snapshot's verdict — never the read's (it has none)
    expect(page.get('wn-facts').text()).toContain('integrity: clean — re-checked fail-closed');
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

  /* AC-2 (leg 12/18) — THE ROW WHERE THE WALK STARTS. The leg list and the leg tab's task
   * buttons used to print the bare status word, so `blocked`-because-a-human-owes-a-decision
   * and `blocked`-because-the-engine-refuses read identically. Both rows carry the verdict
   * now: the same word the card and the gate queue carry. */
  it('the task rows carry the verdict — the journey leg list AND the leg tab (leg 12/18)', async () => {
    const blocked = { ready: false, blockers: ['dependency open: 01-leg/09-x (queued)'] };
    const j = {
      ahead: { activeLeg: LEG, frontmostReady: { task: TASK, status: 'blocked' }, legGate: { met: true } },
      legs: [
        {
          id: LEG,
          status: 'blocked',
          tasks: [
            { id: TASK, status: 'blocked', readiness: blocked },
            { id: '01-leg/02-b', status: 'queued', readiness: { ready: true, blockers: [] } },
          ],
        },
      ],
    };
    const d = {
      ...detailRead,
      status: 'blocked',
      tasks: [
        { id: TASK, status: 'blocked', readiness: blocked },
        { id: '01-leg/02-b', status: 'queued', readiness: { ready: true, blockers: [] } },
      ],
    };
    const page = boot({ ...reads(card()), '/api/journey': j, [`/api/detail?id=${LEG}`]: d });
    await flush();
    // the journey list
    expect(page.get('legs').text()).toContain('01-leg/01-a · blocked · executability BLOCKED — dependency open: 01-leg/09-x (queued)');
    expect(page.get('legs').text()).toContain('01-leg/02-b · queued · executability READY');
    // …and the leg tab, whose task rows are the same read one level down
    const tab = await openTab(page.get('wn-facts').link('leg gate'), { ...reads(card()), [`/api/detail?id=${LEG}`]: d });
    expect(tab.get('card-node').text()).toContain('executability BLOCKED — dependency open: 01-leg/09-x (queued)');
    expect(tab.get('card-node').text()).toContain('executability READY');
  });

  /* ABSENT IS NOT READY (leg 12/18): a row with no readiness — a leg, which is never run —
   * says NOTHING. Printing `executability READY` there would be the same one-word-two-facts
   * error in a new place. */
  it('a leg row prints no verdict at all (leg 12/18)', async () => {
    const page = boot({ ...reads(card()), '/api/journey': { ...journey, legs: [{ id: LEG, status: 'queued', tasks: [] }] } });
    await flush();
    expect(page.get('legs').text()).not.toContain('executability');
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

  /* AC-2/AC-3 (leg 12/18) — the start gate is the decision the read exists for: the row
   * carries the decision owed AND what the engine would still refuse after accepting it. */
  it('the pending-gates row carries the executability BESIDE the gate wait (leg 12/18)', async () => {
    const twoGates = card({
      pendingGates: [
        { task: TASK, gate: 'grill', readiness: { ready: true, blockers: [] } },
        { task: '01-leg/02-b', gate: 'grill', readiness: { ready: false, blockers: ['dependency open: 01-leg/09-x (queued)'] } },
      ],
    });
    const page = boot(reads(twoGates));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('pending gates'), reads(twoGates));
    const body = tab.get('card-node').textContent;
    expect(body).toContain('accepting it makes the task runnable');
    expect(body).toContain('it would still not run — dependency open: 01-leg/09-x (queued)');
  });

  /* The EXIT gate is not a run (leg 12/18). `closesOnAccept` is the auto-close predicate
   * itself, so the sentence is decidable: an accept that CLOSES says so; one that leaves the
   * close owed says that, and neither borrows the entry gate's "makes the task runnable". */
  it('an EXIT gate row says what that accept does — close, or leave the close owed (12/18)', async () => {
    const exits = card({
      pendingGates: [
        { task: TASK, gate: 'confirm', readiness: { ready: true, blockers: [] }, closesOnAccept: true },
        { task: '01-leg/02-b', gate: 'confirm', readiness: { ready: true, blockers: [] }, closesOnAccept: false },
      ],
    });
    const page = boot(reads(exits));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('pending gates'), reads(exits));
    const body = tab.get('card-node').textContent;
    expect(body).toContain('accepting it closes the task — the conclusion evidence is present');
    expect(body).toContain('the close would still refuse, so complete! is owed');
    expect(body).not.toContain('makes the task runnable');
  });

  it('THE PAGE RENDERS BEFORE THE INTEGRITY VERDICT — a pending state, never a blank claim', async () => {
    // The pre-check is fetched lazily (leg 12/07): while it is in flight the card is fully
    // rendered, says it does not know yet, and offers no approve — never a verdict it never got.
    const page = boot(reads(card()), '', ['/api/integrity']);
    await flush();
    expect(page.get('wn-action').textContent).toBe('continue-leg'); // the derivation IS rendered
    expect(page.get('wn-detail').textContent).toContain('next task'); // …and the card is complete
    expect(page.get('wn-badge').textContent).toBe('CHECKING INTEGRITY');
    expect(page.get('wn-actions').hidden).toBe(true); // no approve on an unknown verdict
    expect(page.get('wn-facts').text()).toContain('the page does NOT run the full pre-check on load');
    expect(page.get('wn-blockers').textContent).not.toContain('blocker:'); // and no invented blocker
  });

  it('a blocker tab names its class, the read that derives it, and the node it names', async () => {
    const dirtyCard = card();
    const dirtyInteg = integrity({ clean: false, blockers: [DIRTY] });
    const page = boot(reads(dirtyCard, dirtyInteg));
    await flush();
    expect(page.get('wn-badge').textContent).toBe('BLOCKED — CANNOT ADVANCE');
    expect(page.get('wn-actions').hidden).toBe(true); // no approve where it cannot work
    const row = page.get('wn-blockers').link('blocker:');
    expect(row.textContent).toContain('uncommitted tracked journey changes — commit them'); // the operator's step
    expect(row.href).toContain('drill=blocker');
    const tab = await openTab(row, reads(dirtyCard, dirtyInteg));
    expect(tab.get('card-step-label').textContent).toContain('integrity blocker');
    expect(tab.get('card-node').textContent).toContain('a dirty tree: uncommitted tracked work');
    expect(tab.get('card-node').textContent).toContain('git status --porcelain -- .ann/journey docs');
    expect(tab.get('card-node').textContent).toContain('your step');
    const named = await openTab(tab.get('card-node').link(TASK), reads(dirtyCard, dirtyInteg)); // the node the blocker names
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
    expect(after.filter((f) => f === '/api/journey' || f === '/api/gates' || f === '/api/whatsnext' || f === '/api/integrity')).toEqual([]);
    expect(tab.get('updated').textContent).toContain('as of ');
  });

  it('a result drill from a gate DECIDED since the link was made shows no decision it cannot take', async () => {
    const decided: Record<string, unknown> = {
      ...reads(card()),
      [`/api/confirm?id=${TASK}`]: gateCard({ gates: { grill: { state: 'accepted' }, confirm: { state: 'accepted', at: '2026-09-12' } } }),
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
    const blocked = boot(reads(card(), integrity({ clean: false, blockers: [DIRTY] })));
    await flush();
    expect(blocked.get('wn-actions').hidden).toBe(true);
    const tab = await openTab(blocked.get('wn-blockers').link('blocker:'), reads(card(), integrity({ clean: false, blockers: [DIRTY] })));
    expect(tab.get('card-gates').hidden, 'a view with no gate chips hides the .gates row').toBe(true);
  });

  it('an EXHAUSTED journey with a dirty tree says so — the boundary is the headline, not the blocker', async () => {
    // reported: with the journey done (derivation `none`) and an uncommitted journey tree,
    // the card said BLOCKED — CANNOT ADVANCE. The blocker blocks an APPROVE, and there is
    // none to offer: the move (goal! met / a subtle task / archive) is the human's.
    const exhausted = card({
      advance: { leg: '', action: 'none', detail: 'journey exhausted — verdict UNCONFIRMED: the human chooses — (1) goal! met (criteria met) · (2) a subtle task · (3) goal! archive & start a new goal' },
      frontmost: undefined,
      executable: false,
    });
    const dirtyInteg = integrity({ clean: false, blockers: [DIRTY] });
    const page = boot(reads(exhausted, dirtyInteg));
    await flush();
    expect(page.get('wn-badge').textContent).toBe('PRESENTED AND STOPPED'); // NOT 'BLOCKED'
    expect(page.get('wn-detail').textContent).toContain('goal! met'); // the move, on the card
    expect(page.get('wn-blockers').textContent).toContain('commit them');
    expect(page.get('wn-blockers').textContent).toContain('none is offered here'); // it blocks an approve, not the move
    expect(page.get('wn-message').textContent).toContain('nothing to approve');
    expect(page.get('wn-actions').hidden).toBe(true);
    // …and the blocker still drills (what it is, the read that derives it, its node)
    const tab = await openTab(page.get('wn-blockers').link('blocker:'), reads(exhausted, dirtyInteg));
    expect(tab.get('card-node').textContent).toContain('git status --porcelain -- .ann/journey docs');
  });

  it('an EMPTY resolved chain is never MACHINE-EXECUTABLE — the card says ACTIVATE & WAIT', async () => {
    // REPORTED BUG: the badge promised execution for a task whose resolved chain has NO
    // content steps (an `implementation` task: the runner does the work). The read carries
    // the chain's step count; the badge must follow it.
    const page = boot(reads(card({ chainSteps: 0 })));
    await flush();
    expect(page.get('wn-action').textContent).toBe('continue-leg'); // the derivation is unchanged
    expect(page.get('wn-badge').textContent).toBe('ACTIVATE & WAIT');
    // the card QUOTES what the frame really does — never 'the machine can run this step'
    expect(page.get('wn-facts').text()).toContain('nothing to execute — the frame activates the task and waits for the runner (empty chain)');
    expect(page.get('wn-facts').text()).not.toContain('the machine can run this step through the frame');
    expect(page.get('wn-actions').hidden).toBe(false); // the move IS available: it activates the task
    // …and a DIRTY tree still wins the headline (the approve is withheld, not merely un-runnable)
    const dirty = boot(reads(card({ chainSteps: 0 }), integrity({ clean: false, blockers: [DIRTY] })));
    await flush();
    expect(dirty.get('wn-badge').textContent).toBe('BLOCKED — CANNOT ADVANCE');
    expect(dirty.get('wn-actions').hidden).toBe(true);
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

/**
 * Leg 12 task 01 — THE DEFERRED VIEW. A deferred task closes its leg, so it is neither a
 * ready task nor a gate: without its own list the postponed obligation vanishes from the
 * page while the pull surface reads exhausted. The rows come off the SAME `ahead.deferred`
 * the journey route carries (`/api/journey`), and each one DRILLS into its node —
 * presented, never decided.
 */
const DEF = '09-spec-fidelity/01-validate-decision-forks';
const DEF_REASON =
  "deferred: the goal's server/UI slice takes priority — the D1-D11 design-fidelity decisions remain recorded in .agents/plan/design-fidelity-plan.md; this leg's work returns as its own later epic";
const deferredJourney = {
  ahead: {
    activeLeg: LEG,
    activeLegStatus: 'queued',
    frontmostReady: { task: TASK, status: 'queued' },
    legGate: { met: true },
    deferred: [{ task: DEF, leg: '09-spec-fidelity', since: '2026-09-11', reason: DEF_REASON, plan: '.agents/plan/design-fidelity-plan.md' }],
  },
  legs: [
    { id: LEG, status: 'queued', tasks: [{ id: TASK, status: 'queued' }] },
    { id: '09-spec-fidelity', status: 'done', tasks: [{ id: DEF, status: 'deferred' }] },
  ],
};
const deferredReads = (): Record<string, unknown> => ({
  ...reads(card()),
  '/api/journey': deferredJourney,
  [`/api/confirm?id=${DEF}`]: {
    detail: {
      id: DEF,
      status: 'deferred',
      contract: { intent: 'decide the forks', acceptanceCriteria: ['the forks are decided'] },
      gates: { grill: { state: 'accepted' }, confirm: { state: 'none' } },
      rework: false,
      next: { verdict: 'terminal', status: 'deferred' },
      inputs: [],
      openQuestions: [],
      claims: [],
      checks: [],
    },
    results: [],
  },
});

describe('the served page — the DEFERRED work is visible (leg 12 task 01)', () => {
  it('renders the row: the id, the recorded reason, and the plan it names', async () => {
    const page = boot(deferredReads());
    await flush();
    expect(page.get('journey-view').hidden).toBe(false);
    expect(page.get('deferred-head').hidden).toBe(false);
    const rows = page.get('deferred').text();
    expect(rows).toContain(DEF);
    expect(rows).toContain(DEF_REASON); // verbatim — the recorded reason, never re-worded
    expect(rows).toContain('plan: .agents/plan/design-fidelity-plan.md');
    expect(rows).toContain('deferred 2026-09-11');
    // the leg line still reads done — the deferred task closed it (semantics unchanged)
    expect(page.get('legs').text()).toContain('09-spec-fidelity · done');
  });

  it('a deferred row drills into its node — PRESENTED, never decided', async () => {
    const page = boot(deferredReads());
    await flush();
    const row = page.get('deferred').descendants().find((c) => c.tag === 'button');
    expect(row, 'the deferred row is not a drill').toBeDefined();
    row!.click();
    await flush();
    expect(page.fetched).toContain(`/api/confirm?id=${DEF}`);
    expect(page.get('card-title').textContent).toBe(DEF);
    expect(page.get('card-next').textContent).toContain('next: deferred');
    expect(page.get('card-decide').hidden).toBe(true); // nothing to decide on a deferred task
  });

  it('no deferred work → the section is HIDDEN, never left showing a stale row', async () => {
    const page = boot({ ...reads(card()), '/api/journey': journey });
    await flush();
    expect(page.get('deferred-head').hidden).toBe(true);
    expect(page.get('deferred').text()).toBe('');
  });
});

describe('the served page — the node’s EVENT LIST is on the card (leg 10/04’s read, wired in)', () => {
  it('lists the node’s events in LOG ORDER, each row a NEW-TAB drill into the raw record', async () => {
    const gateReads: Record<string, unknown> = { ...reads(card()), [`/api/confirm?id=${TASK}`]: gateCard() };
    const tab = boot(gateReads, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm');
    await flush();
    // the card reads the node's log — the SAME read the CLI prints with `ann events <id>`
    expect(tab.fetched).toContain(`/api/events?id=${TASK}`);
    expect(tab.get('card-events-h').hidden).toBe(false);
    const links = tab.get('card-events').links();
    expect(links.map((l) => l.textContent)).toEqual([
      '1. 2026-09-12  created — spawned by bookkeeper (agent) ›',
      '2. 2026-09-12  submitted (gate=grill) — submitted for the grill gate (agent) ›',
      `3. 2026-09-12  evidence — captured 'npm test' → pass (exit 0) against ${SHA} ›`,
    ]);
    // numbered exactly as `journey <id>` numbers them, and each carries its event in the fragment
    expect(links[0].href).toBe('#drill=event&id=' + encodeURIComponent(TASK) + '&gate=confirm&n=1');
    expect(links[2].href).toBe('#drill=event&id=' + encodeURIComponent(TASK) + '&gate=confirm&n=3');
    expect(links[0].target).toBe('_blank');
    expect(links[0].rel).toBe('noopener');
  });

  it('the event tab shows the RAW record + what it points at, and keeps the exit gate’s decision', async () => {
    const gateReads: Record<string, unknown> = { ...reads(card()), [`/api/confirm?id=${TASK}`]: gateCard() };
    const gateTab = boot(gateReads, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm');
    await flush();
    const tab = await openTab(gateTab.get('card-events').links()[0], gateReads);
    expect(tab.get('card-step-label').textContent).toContain('EXIT STEP'); // the review survives the drill
    expect(tab.get('card-title').textContent).toBe(`${TASK} · event 1`);
    expect(tab.fetched).toContain(`/api/events?id=${TASK}&n=1`);
    expect(tab.get('card-decide').hidden).toBe(false); // a submitted gate stays decidable while read
    const node = tab.get('card-node');
    expect(node.textContent).toContain('1 of 3 on ' + TASK); // where this event sits in the walk
    expect(node.textContent).toContain('ann events ' + TASK + ' 1'); // the CLI handle
    expect(node.textContent).toContain('"type": "created"'); // the RAW record, not a paraphrase
    // the links: a NODE drills into its own tab, every other kind names the follow-up command
    expect(node.textContent).toContain('commit: ' + SHA + ' — resolves in git');
    expect(node.textContent).toContain('ann results ' + TASK + ' 1');
    const deeper = await openTab(node.link('drill in'), gateReads);
    expect(deeper.get('card-title').textContent).toBe(TASK); // the node it names
  });

  it('a LEG root says why its own list is empty (its status is derived from its tasks)', async () => {
    const page = boot(reads(card()));
    await flush();
    const tab = await openTab(page.get('wn-facts').link('leg gate'), reads(card()));
    expect(tab.fetched).toContain(`/api/events?id=${LEG}`);
    expect(tab.get('card-events-h').hidden).toBe(false);
    expect(tab.get('card-events').textContent).toContain('no events — a leg root carries none by design');
  });

  it('a view with NO event list hides the section (never a stale row from the card before it)', async () => {
    const gateReads: Record<string, unknown> = {
      ...reads(card()),
      [`/api/confirm?id=${TASK}`]: gateCard(),
      [`/api/results?id=${TASK}&n=1`]: resultsRead,
    };
    const gateTab = boot(gateReads, '#drill=gate&id=' + encodeURIComponent(TASK) + '&gate=confirm');
    await flush();
    const tab = await openTab(gateTab.get('card-results').link('commit'), gateReads);
    expect(tab.get('card-events-h').hidden).toBe(true);
    expect(tab.get('card-events').textContent).toBe('');
  });
});
